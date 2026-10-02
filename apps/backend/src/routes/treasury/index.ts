import {
  CreateInviteRequestSchema,
  CreateOrgRequestSchema,
  DecimalString,
  IssueUnitsRequestSchema,
  RegisterMainnetWalletRequestSchema,
  formatDecimal,
  toDecimal,
  type ActivityResponse,
  type CycleSummary,
  type HolderPosition,
  type HoldersResponse,
  type Invite,
  type InfrastructureResponse,
  type OrgResponse,
  type OverviewResponse,
} from '@mithra/shared';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ActivityLog } from '../../activity/log';
import { requireRole, rolesOfRequest } from '../../auth/roles';
import type { Config } from '../../config/env';
import type { Database } from '../../db';
import { invites, txRefs } from '../../db/schema';
import type { EventBus } from '../../events/bus';
import { FundingError, type Funding } from '../../funding';
import { AutoReceiveStatus } from '../../holders/autoReceive';
import { transferInstructionAccept } from '../../holders/commands';
import { createHolderAdmin } from '../../holders/admin';
import { holderError } from '../../holders/errors';
import { buildPosition, opaqueId } from '../../holders/position';
import { createHoldersReader } from '../../holders/response';
import { ApiError, parse } from '../../http/errors';
import { RateLimiter } from '../../http/rateLimit';
import type { Ledger, MithraReader } from '../../ledger';
import { createMainnetAutoReceive } from '../../mainnet/autoReceive';
import type { MainnetWallets } from '../../mainnet/wallets';
import type { PartyNames } from '../../parties/names';
import type { AssetAdapter } from '../../wallet';
import { formatAmount } from './format';
import { createInfrastructureChecker, type InfrastructureChecker } from './infrastructure';
import { isInviteCode, normalizeInviteCode } from './invites';
import { buildMandateView, buildOrgResponse } from './org';

/**
 * What the treasury routes need from the cycle engine (M4). Tests pass a stub.
 * `nextCycle` is the next scheduled run; `at` is an ISO time.
 */
export interface CycleQueries {
  listCycles(): Promise<CycleSummary[]>;
  nextCycle(): Promise<{ cycleId: string; label: string; at: string } | null>;
}

export interface TreasuryRoutesDeps {
  config: Config;
  ledger: Pick<Ledger, 'client' | 'reader' | 'commands'>;
  asset: AssetAdapter;
  names: PartyNames;
  activity: ActivityLog;
  bus: EventBus;
  db: Database;
  cycles: CycleQueries;
  funding: Funding;
  /** MainNet payouts: the holders' Grofty wallets. Present on MainNet only. */
  mainnetWallets?: MainnetWallets;
  /**
   * Marks accepted payments Paid right away (the cycle module's `reconciler.reconcilePayments`).
   * Called after a holder accepts a payment, so the Payment does not wait for the next pass. When
   * absent the background reconciler does it.
   */
  reconcilePayments?: () => Promise<unknown>;
  /** Called after a holder connected a wallet, to let cycles that waited for it go ahead. */
  walletConnected?: () => Promise<unknown>;
  /** Overrides for tests; the defaults are what production uses. */
  options?: {
    now?: () => Date;
    autoReceive?: AutoReceiveStatus;
    infrastructure?: InfrastructureChecker;
    /** How long POST /api/me/auto-receive waits for the registry to report the preapproval. */
    autoReceivePoll?: { attempts: number; delayMs: number };
    /** Requests per minute per IP for the public invite lookup. Default 60. */
    inviteLookupLimit?: number;
  };
}

/** Response of POST /api/treasury/fund. */
export interface FundTreasuryResponse {
  amount: string;
  balance: string | null;
  /** True when the transfer was pending and the agent accepted it for the treasury. */
  acceptedPending: boolean;
}

const RECENT_CYCLES = 5;
const RECENT_ACTIVITY = 10;
/** Cycle statuses that mean a distribution was executed, for the "last total" estimate. */
const EXECUTED_STATUSES: ReadonlySet<CycleSummary['status']> = new Set([
  'paid-automatically',
  'paid-after-approval',
  'awaiting-acceptance',
]);

const CodeParams = z.object({ code: z.string().min(1).max(64) });
const UnitParams = z.object({ unitId: z.string().min(1).max(500) });
const PaymentParams = z.object({ paymentId: z.string().min(1).max(500) });
const ActivityQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
const FundBody = z.object({
  amount: DecimalString.refine((v) => toDecimal(v).gt(0), 'The amount must be more than 0'),
});

function partyOf(request: FastifyRequest): string {
  const partyId = request.session?.partyId;
  if (!partyId) throw new ApiError(401, 'not_signed_in', 'Sign in and pick a party first.');
  return partyId;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Registers the treasury, holder and overview routes (the cycle routes are M4's). */
export function treasuryRoutes(app: FastifyInstance, deps: TreasuryRoutesDeps): void {
  const { config, ledger, asset, names, activity, bus, db, cycles, funding, mainnetWallets } = deps;
  const { reader, client, commands } = ledger;
  const now = deps.options?.now ?? (() => new Date());
  /** MainNet payouts: Mithra's records are on LocalNet either way, but the money moves in Grofty. */
  const mainnet = config.network === 'mainnet';
  /** The agent can read FundUnits (and so see acceptance) only when it may read as the treasury. */
  const fundUnitsReadable = config.ledger.readAsTreasury;
  const treasury = config.parties.treasury;
  const poll = deps.options?.autoReceivePoll ?? { attempts: 12, delayMs: 1500 };

  const onAutoReceiveError = (holder: string, error: unknown): void =>
    app.log.warn({ err: error, holder }, 'could not read auto-receive status');
  const autoReceive =
    deps.options?.autoReceive ??
    (config.network === 'mainnet' && mainnetWallets
      ? createMainnetAutoReceive({
          scanUrl: config.mainnet.scanUrl,
          wallets: mainnetWallets,
          onError: onAutoReceiveError,
        })
      : new AutoReceiveStatus({ asset, treasury, onError: onAutoReceiveError }));
  const infrastructure =
    deps.options?.infrastructure ?? createInfrastructureChecker({ config, client });
  const inviteLimiter = new RateLimiter({
    limit: deps.options?.inviteLookupLimit ?? 60,
    windowMs: 60_000,
  });

  const treasuryTeam = requireRole('treasurer', 'approver');
  const holderAdmin = createHolderAdmin({
    config,
    ledger,
    names,
    activity,
    bus,
    db,
    now,
  });

  // -------------------------------------------------------------------------------------------
  // Organization (userflow 4 step 1, 12)

  async function readOrgState() {
    const [charter, organization, mandate] = await Promise.all([
      reader.charter(),
      reader.organization(),
      reader.mandate(),
    ]);
    return { charter, organization, mandate };
  }

  app.get(
    '/api/org',
    {
      // The treasurer and approvers, and any signed-in party with no role yet, so setup can start.
      async preHandler(request) {
        partyOf(request);
        const { roles } = await rolesOfRequest(request);
        const allowed =
          roles.length === 0 || roles.includes('treasurer') || roles.includes('approver');
        if (!allowed) {
          throw new ApiError(
            403,
            'forbidden_role',
            'This needs the treasurer or approver role. Switch to a party that has it.',
          );
        }
      },
    },
    async (request): Promise<OrgResponse> => {
      const { roles } = await rolesOfRequest(request);
      const detail = roles.includes('treasurer') || roles.includes('approver');
      return buildOrgResponse(config, await readOrgState(), names, { detail });
    },
  );

  app.post('/api/org', async (request, reply): Promise<OrgResponse> => {
    const party = partyOf(request);
    const body = parse(CreateOrgRequestSchema, request.body);

    const { charter, organization } = await readOrgState();
    if (organization) {
      throw new ApiError(
        409,
        'organization_exists',
        'This treasury already has an organization. Open Settings to review it.',
      );
    }
    if (!charter) {
      throw new ApiError(
        409,
        'no_charter',
        'No treasury charter exists yet. On LocalNet run scripts/localnet-up.sh to create it, then try again.',
      );
    }
    if (charter.payload.treasurer !== party) {
      throw new ApiError(
        403,
        'not_treasurer',
        'Only the treasurer named in the charter can create the organization. Switch to that party.',
      );
    }
    if (new Set(body.approvers).size !== body.approvers.length) {
      throw new ApiError(
        400,
        'duplicate_approver',
        'Each approver must be a different party. Remove the duplicate and try again.',
      );
    }
    const system = new Set([
      config.parties.agent,
      config.parties.operator,
      charter.payload.agent,
      charter.payload.operator,
      charter.payload.treasury,
    ]);
    if (body.approvers.some((a) => system.has(a))) {
      throw new ApiError(
        400,
        'invalid_approver',
        'The agent, the operator and the treasury cannot be approvers. Choose people from your team.',
      );
    }
    if (body.approvalThreshold > body.approvers.length) {
      throw new ApiError(
        400,
        'invalid_threshold',
        `The approval threshold is ${body.approvalThreshold} but there ${body.approvers.length === 1 ? 'is' : 'are'} only ${plural(body.approvers.length, 'approver', 'approvers')}. Lower the threshold or add approvers.`,
      );
    }

    await client.submit({
      actAs: [party],
      commands: [
        commands.charterCreateOrganization(charter.contractId, {
          name: body.name,
          asset: { admin: config.asset.adminParty, id: config.asset.id },
          approvers: body.approvers,
          approvalThreshold: body.approvalThreshold,
        }),
      ],
    });
    await activity.record({
      actorParty: party,
      kind: 'org.created',
      subject: body.name,
      text: `Treasurer created ${body.name} with ${plural(body.approvers.length, 'approver', 'approvers')}, ${body.approvalThreshold} of ${body.approvers.length}`,
    });
    return reply
      .code(201)
      .send(await buildOrgResponse(config, await readOrgState(), names, { detail: true }));
  });

  // -------------------------------------------------------------------------------------------
  // Holders (userflow 5) and invites

  const holdersResponse = createHoldersReader({
    config,
    ledger,
    names,
    autoReceive,
    ...(mainnetWallets ? { wallets: mainnetWallets } : {}),
  });

  app.get('/api/holders', { preHandler: treasuryTeam }, () => holdersResponse());

  app.post(
    '/api/holders/issue',
    { preHandler: requireRole('treasurer') },
    async (request): Promise<HoldersResponse> => {
      const party = partyOf(request);
      const body = parse(IssueUnitsRequestSchema, request.body);
      await holderAdmin.issueUnits({
        actor: party,
        holder: body.holder,
        units: body.units,
        ...(body.effectiveDate ? { effectiveDate: body.effectiveDate } : {}),
      });
      return holdersResponse();
    },
  );

  app.post(
    '/api/invites',
    { preHandler: requireRole('treasurer') },
    async (request, reply): Promise<Invite> => {
      const party = partyOf(request);
      const body = parse(CreateInviteRequestSchema, request.body);
      const invite = await holderAdmin.createInvite({
        actor: party,
        kind: body.kind,
        displayName: body.displayName,
        partyId: body.partyId,
      });
      return reply.code(201).send(invite);
    },
  );

  /** An invite as the invitee sees it: the fund name, their own name and the units offered to them. */
  app.get('/api/invites/:code', async (request) => {
    const params = parse(CodeParams, request.params);
    if (!inviteLimiter.allow(request.ip)) {
      throw new ApiError(
        429,
        'too_many_requests',
        'Too many invite lookups. Wait a minute, then try again.',
      );
    }
    const notFound = new ApiError(
      404,
      'not_found',
      'That invitation code is not valid. Check the link, or ask the fund for a new one.',
    );
    const code = normalizeInviteCode(params.code);
    if (!isInviteCode(code)) throw notFound;
    const [row] = await db.select().from(invites).where(eq(invites.code, code)).limit(1);
    if (!row) throw notFound;
    const org = await reader.organization();
    let unitsOffered: number | null = null;
    if (row.kind === 'holder' && row.partyId && fundUnitsReadable) {
      // Only this invitee's own, not yet accepted units: never anyone else's.
      const open = (await reader.fundUnits(row.partyId)).filter((u) => !u.payload.accepted);
      if (open.length > 0) unitsOffered = open.reduce((sum, u) => sum + u.payload.units, 0);
    }
    // `unitsOffered` goes beyond the shared `Invite` schema (clients that parse it ignore it).
    return {
      code: row.code,
      kind: row.kind,
      displayName: row.displayName,
      path: `/invite/${row.code}`,
      orgName: org?.payload.name ?? '',
      used: row.usedAt !== null,
      unitsOffered,
    } satisfies Invite & { unitsOffered: number | null };
  });

  // -------------------------------------------------------------------------------------------
  // Overview, activity, infrastructure (userflow 7, 12)

  app.get('/api/overview', { preHandler: treasuryTeam }, async (): Promise<OverviewResponse> => {
    const [mandate, balance, nextCycle, allCycles, recentActivity] = await Promise.all([
      reader.mandate(),
      // MainNet: the balance is in the treasurer's Grofty wallet, which the server cannot read.
      mainnet
        ? Promise.resolve(null)
        : asset.balance(treasury).then(
            (b) => b,
            (error: unknown) => {
              app.log.warn({ err: error }, 'could not read the treasury balance');
              return null;
            },
          ),
      cycles.nextCycle().then(
        (c) => c,
        (error: unknown) => {
          app.log.warn({ err: error }, 'could not read the next cycle');
          return null;
        },
      ),
      cycles.listCycles(),
      activity.list(RECENT_ACTIVITY),
    ]);

    const newestFirst = [...allCycles].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const lastExecutedTotal =
      newestFirst.find((c) => EXECUTED_STATUSES.has(c.status) && c.total !== null)?.total ?? null;
    const terms = mandate?.payload.terms;
    // The Mandate's fixed amount, else what the last executed cycle paid.
    const expectedNextTotal = terms?.fixedAmount ?? lastExecutedTotal;

    let fundsWarning: OverviewResponse['fundsWarning'] = null;
    if (balance !== null && expectedNextTotal !== null) {
      const required = toDecimal(expectedNextTotal).plus(toDecimal(terms?.feeBuffer ?? '0'));
      if (toDecimal(balance).lt(required)) {
        fundsWarning = { balance, required: formatDecimal(required) };
      }
    }

    return {
      balance,
      assetSymbol: config.asset.symbol,
      nextCycle: nextCycle
        ? { cycleId: nextCycle.cycleId, label: nextCycle.label, at: nextCycle.at }
        : null,
      expectedNextTotal,
      fundsWarning,
      mandate: mandate
        ? await buildMandateView(config, mandate, mandate.payload.treasurer, names)
        : null,
      pendingApprovals: allCycles.filter((c) => c.status === 'awaiting-approval').length,
      recentCycles: newestFirst.slice(0, RECENT_CYCLES),
      recentActivity,
    };
  });

  app.get(
    '/api/activity',
    { preHandler: treasuryTeam },
    async (request): Promise<ActivityResponse> => {
      const query = parse(ActivityQuery, request.query);
      return { entries: await activity.list(query.limit) };
    },
  );

  app.get(
    '/api/infrastructure',
    { preHandler: treasuryTeam },
    (): Promise<InfrastructureResponse> => infrastructure.get(),
  );

  app.post(
    '/api/treasury/fund',
    { preHandler: requireRole('treasurer') },
    async (request): Promise<FundTreasuryResponse> => {
      const party = partyOf(request);
      if (mainnet) {
        throw new ApiError(
          404,
          'not_available',
          'Test funds are only available on LocalNet. Send CC to your Grofty Wallet; payouts are signed from it.',
        );
      }
      const body = parse(FundBody, request.body);
      let result;
      try {
        result = await funding.fundTreasury(body.amount);
      } catch (error) {
        if (error instanceof FundingError) {
          app.log.warn({ err: error }, 'adding test funds failed');
          throw new ApiError(502, 'funding_failed', error.message);
        }
        throw error;
      }
      await activity.record({
        actorParty: party,
        kind: 'treasury.funded',
        subject: treasury,
        text: `Added ${formatAmount(result.amount)} ${config.asset.symbol} to the treasury (LocalNet test funds)`,
      });
      const balance = await asset.balance(treasury).then(
        (b) => b,
        () => null,
      );
      return { amount: result.amount, balance, acceptedPending: result.acceptedPending };
    },
  );

  // -------------------------------------------------------------------------------------------
  // Holder routes (userflow 6). The data is always the session party's own (L7, U7).

  /**
   * Payments and FundUnits as the holder. The records are on LocalNet on both networks, and the
   * ledger itself restricts the read to what the holder may see (`reader.as([holder])`), so
   * another holder's data never reaches this process.
   */
  async function readHolderContracts(holder: string) {
    const own: MithraReader = reader.as([holder]);
    const [payments, fundUnits] = await Promise.all([own.payments(), own.fundUnits()]);
    return { payments, fundUnits };
  }

  async function positionOf(
    holder: string,
    autoReceiveStatus?: boolean | null,
  ): Promise<HolderPosition> {
    const [organization, register, own, next, receive] = await Promise.all([
      reader.organization(),
      reader.register(),
      readHolderContracts(holder),
      cycles.nextCycle().then(
        (c) => c,
        (error: unknown) => {
          app.log.warn({ err: error }, 'could not read the next cycle');
          return null;
        },
      ),
      autoReceiveStatus === undefined
        ? autoReceive.get(holder)
        : Promise.resolve(autoReceiveStatus),
    ]);
    if (!organization || !register) {
      throw new ApiError(
        404,
        'not_found',
        'Your position is not available yet. Ask the fund to finish setup.',
      );
    }
    // Only the links of this holder's own payments are looked up.
    const cids = own.payments.map((p) => p.contractId);
    const refs =
      cids.length === 0
        ? []
        : await db.select().from(txRefs).where(inArray(txRefs.contractId, cids));
    const updateIds = new Map<string, string>();
    for (const ref of refs) {
      // Prefer a reference recorded for the payment itself if several kinds exist.
      if (!updateIds.has(ref.contractId) || ref.kind === 'payment') {
        updateIds.set(ref.contractId, ref.updateId);
      }
    }
    const position = buildPosition({
      config,
      orgName: organization.payload.name,
      holder,
      changes: register.payload.changes,
      fundUnits: own.fundUnits,
      payments: own.payments,
      updateIds,
      nextPayment: next?.at ?? null,
      autoReceive: receive,
    });
    if (!mainnetWallets) return position;
    return { ...position, mainnetWallet: await mainnetWallets.get(holder) };
  }

  /** Runs a holder route body; any ledger or registry failure becomes a generic message. */
  async function asHolder<T>(
    request: FastifyRequest,
    action: string,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const mapped = holderError(error, action);
      if (!mapped) throw error;
      if (!(error instanceof ApiError)) {
        // The detail names parties and amounts: it stays in the server log.
        request.log.warn(
          { err: mapped.detail, party: request.session?.partyId },
          `${action} failed`,
        );
      }
      throw mapped.apiError;
    }
  }

  const holderOnly = requireRole('holder');

  app.get('/api/me/position', { preHandler: holderOnly }, (request) =>
    asHolder(request, 'Loading your position', () => positionOf(partyOf(request))),
  );

  // -------------------------------------------------------------------------------------------
  // MainNet wallet (M10): the holder connects Grofty Wallet so payouts can be sent to it.

  function requireWallets(): MainnetWallets {
    if (!mainnetWallets) {
      throw new ApiError(
        404,
        'not_available',
        'Connecting Grofty Wallet is only used on MainNet. Payouts on LocalNet stay on the ledger.',
      );
    }
    return mainnetWallets;
  }

  app.post('/api/me/mainnet-wallet/challenge', { preHandler: holderOnly }, async (request) => {
    const wallets = requireWallets();
    const holder = partyOf(request);
    return wallets.challenge(holder, await names.name(holder));
  });

  app.post('/api/me/mainnet-wallet', { preHandler: holderOnly }, (request) =>
    asHolder(request, 'Connecting your Grofty Wallet', async () => {
      const wallets = requireWallets();
      const holder = partyOf(request);
      const body = parse(RegisterMainnetWalletRequestSchema, request.body);
      await wallets.register(holder, body);
      autoReceive.invalidate(holder);
      bus.publish({ type: 'holder', change: 'wallet' }, { parties: [holder] });
      await activity.record({
        actorParty: holder,
        kind: 'holder.wallet-connected',
        subject: holder,
        text: `${await names.name(holder)} connected a Grofty Wallet for MainNet payouts`,
      });
      // A cycle that was waiting for this wallet can go ahead now.
      if (deps.walletConnected) {
        await deps.walletConnected().catch((error: unknown) => {
          request.log.warn({ err: error }, 'could not advance the cycles waiting for wallets');
        });
      }
      return positionOf(holder);
    }),
  );

  app.post('/api/me/units/:unitId/accept', { preHandler: holderOnly }, (request) =>
    asHolder(request, 'Accepting these units', async () => {
      const holder = partyOf(request);
      const params = parse(UnitParams, request.params);
      const { fundUnits } = await readHolderContracts(holder);
      const unit = fundUnits.find(
        (u) => opaqueId(u.contractId) === params.unitId && !u.payload.accepted,
      );
      if (!unit) {
        throw new ApiError(
          404,
          'not_found',
          'These units were not found, or you already accepted them. Refresh the page.',
        );
      }
      await client.submit({
        actAs: [holder],
        commands: [commands.fundUnitAccept(unit.contractId)],
      });
      bus.publish({ type: 'holder', change: 'units' }, { parties: [holder] });
      await activity.record({
        actorParty: holder,
        kind: 'units.accepted',
        subject: unit.contractId,
        text: `${await names.name(holder)} accepted ${formatAmount(String(unit.payload.units))} units`,
      });
      return positionOf(holder);
    }),
  );

  app.post('/api/me/auto-receive', { preHandler: holderOnly }, (request) =>
    asHolder(request, 'Turning on auto-receive', async () => {
      const holder = partyOf(request);
      autoReceive.invalidate(holder);
      let status = await autoReceive.get(holder);
      if (status !== true && !mainnet) {
        await funding.createPreapproval(holder);
        // The registry reports the preapproval a little after the ledger has it.
        for (let attempt = 0; attempt < poll.attempts && status !== true; attempt += 1) {
          if (attempt > 0) await sleep(poll.delayMs);
          autoReceive.invalidate(holder);
          status = await autoReceive.get(holder);
        }
        if (status !== true) {
          throw new ApiError(
            409,
            'auto_receive_pending',
            'Auto-receive was created, but the token registry has not confirmed it yet. Wait a minute, then refresh this page.',
          );
        }
      }
      // MainNet: the holder turns it on in Grofty; this only verifies it.
      if (status === true) {
        bus.publish({ type: 'holder', change: 'auto-receive' }, { parties: [holder] });
        await activity.record({
          actorParty: holder,
          kind: 'holder.auto-receive',
          subject: holder,
          text: `${await names.name(holder)} turned on auto-receive`,
        });
      }
      return positionOf(holder, status);
    }),
  );

  app.post('/api/me/payments/:paymentId/accept', { preHandler: holderOnly }, (request) =>
    asHolder(request, 'Accepting this payment', async () => {
      const holder = partyOf(request);
      const params = parse(PaymentParams, request.params);
      // Read as the holder: another holder's payment is simply not there (404, no detail).
      const { payments } = await readHolderContracts(holder);
      const payment = payments.find(
        (p) =>
          opaqueId(p.contractId) === params.paymentId &&
          p.payload.holder === holder &&
          p.payload.status === 'AwaitingAcceptance' &&
          p.payload.transferInstructionCid !== null,
      );
      const instructionCid = payment?.payload.transferInstructionCid;
      if (!payment || !instructionCid) {
        throw new ApiError(
          404,
          'not_found',
          'That payment was not found, or it is already accepted. Refresh the page.',
        );
      }
      const context = await asset.acceptContext(instructionCid);
      await client.submit({
        actAs: [holder],
        commands: [transferInstructionAccept(instructionCid, context.extraArgs)],
        disclosedContracts: context.disclosed,
      });
      bus.publish({ type: 'holder', change: 'payments' }, { parties: [holder] });
      await activity.record({
        actorParty: holder,
        kind: 'payment.accepted',
        subject: payment.contractId,
        text: `${await names.name(holder)} accepted a payment of ${formatAmount(payment.payload.amount)} ${config.asset.symbol} for ${payment.payload.cycleLabel}`,
      });
      // The reconciler marks the Payment Paid once it sees the accepted transfer; run that pass
      // now so the holder sees "Paid" in the answer instead of after the next background pass.
      // The accept itself succeeded, so a failure here is only logged: the next pass retries.
      if (deps.reconcilePayments) {
        await deps.reconcilePayments().catch((error: unknown) => {
          request.log.warn({ err: error }, 'could not mark the accepted payment Paid yet');
        });
      }
      return positionOf(holder);
    }),
  );
}

/** `treasuryRoutes` as a Fastify plugin (`app.register(treasuryPlugin, deps)`). */
export const treasuryPlugin: FastifyPluginAsync<TreasuryRoutesDeps> = (app, deps) => {
  treasuryRoutes(app, deps);
  return Promise.resolve();
};
