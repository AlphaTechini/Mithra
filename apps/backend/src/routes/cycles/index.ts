import {
  ApproveRequestSchema,
  RejectRequestSchema,
  RunCycleRequestSchema,
  SealMandateRequestSchema,
  UpdatePolicyDraftRequestSchema,
  type ApprovalsInbox,
  type CycleDetail,
  type CyclesResponse,
  type DecisionRecordView,
  type MandateView,
  type PolicyDraft,
  type RunCycleResponse,
  type SealStatus,
  type TxDetail,
} from '@mithra/shared';
import type { FastifyError, FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { requireRole, rolesOfRequest } from '../../auth/roles';
import type { Config } from '../../config/env';
import type { CycleService } from '../../cycle/engine';
import type { Database } from '../../db';
import { txRefs } from '../../db/schema';
import { ApiError, errorBody, parse, upstreamErrorResponse } from '../../http/errors';
import type { MandateSealer } from '../../governance/sealer';
import { LedgerError, PaymentSchema, createdIn, type Ledger } from '../../ledger';
import type { PartyNames } from '../../parties/names';
import type { PolicyDrafts } from '../../policy/drafts';
import { termsView } from '../../policy/fields';

export interface CycleRouteDeps {
  config: Config;
  cycles: CycleService;
  sealer: MandateSealer;
  drafts: PolicyDrafts;
  ledger: Pick<Ledger, 'client' | 'reader'>;
  names: PartyNames;
  /** For payment links that point at the transaction that accepted a transfer (`tx_refs`). */
  db: Database;
}

const CycleParams = z.object({ cycleId: z.string().min(1).max(40) });
const ProposalParams = z.object({ proposalId: z.string().min(1).max(200) });
const RecordParams = z.object({ recordId: z.string().min(1).max(200) });
const SealParams = z.object({ sealId: z.string().min(1).max(100) });
const TxParams = z.object({ updateId: z.string().min(1).max(200) });

/** The signed-in party; the role hooks have already checked there is one. */
function partyOf(request: FastifyRequest): string {
  const partyId = request.session?.partyId;
  if (!partyId) throw new ApiError(401, 'not_signed_in', 'Sign in and pick a party first.');
  return partyId;
}

/** Same mapping as the application's global handler, so the routes behave the same in any app. */
function handleError(
  error: FastifyError | ZodError | ApiError,
  request: FastifyRequest,
  reply: { code(status: number): { send(body: unknown): unknown } },
): unknown {
  if (error instanceof ApiError)
    return reply.code(error.status).send(errorBody(error.code, error.message));
  const upstream = upstreamErrorResponse(error);
  if (upstream) {
    request.log.warn({ err: error }, 'upstream request failed');
    return reply.code(upstream.status).send(upstream.body);
  }
  if (error instanceof ZodError) {
    const message = error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return reply.code(400).send(errorBody('validation_error', message));
  }
  const status =
    'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
  if (status >= 500) {
    request.log.error({ err: error }, 'request failed');
    return reply.code(status).send(errorBody('internal_error', 'Internal server error'));
  }
  return reply.code(status).send(errorBody('bad_request', error.message));
}

/** Registers the cycle, approval, Mandate, policy-draft and transaction routes (the contract in shared/api/treasury.ts). */
export function cycleRoutes(app: FastifyInstance, deps: CycleRouteDeps): void {
  const { cycles, sealer, drafts, ledger, names, config, db } = deps;
  const treasuryTeam = requireRole('treasurer', 'approver');
  const treasurerOnly = requireRole('treasurer');
  const approverOnly = requireRole('approver');

  app.get('/api/cycles', { preHandler: treasuryTeam }, async (): Promise<CyclesResponse> => ({
    cycles: await cycles.listCycles(),
  }));

  app.post(
    '/api/cycles/run',
    { preHandler: treasurerOnly },
    async (request, reply): Promise<RunCycleResponse> => {
      const body = parse(RunCycleRequestSchema, request.body ?? {});
      const partyId = partyOf(request);
      const who = await names.name(partyId);
      const result = await cycles.run({
        trigger: 'manual',
        triggerDetail: `Run cycle now by ${who}`,
        actorParty: partyId,
        ...(body.cycleId ? { cycleId: body.cycleId } : {}),
        ...(body.total ? { total: body.total } : {}),
        ...(body.recordDate ? { recordDate: body.recordDate } : {}),
      });
      void reply.code(202);
      return result;
    },
  );

  app.get(
    '/api/cycles/:cycleId',
    { preHandler: treasuryTeam },
    async (request): Promise<CycleDetail> => {
      const { cycleId } = parse(CycleParams, request.params);
      return cycles.getCycle(cycleId);
    },
  );

  app.post(
    '/api/cycles/:cycleId/hold',
    { preHandler: treasurerOnly },
    async (request): Promise<CycleDetail> => {
      const { cycleId } = parse(CycleParams, request.params);
      return cycles.hold(cycleId, partyOf(request));
    },
  );

  app.post(
    '/api/cycles/:cycleId/release',
    { preHandler: treasurerOnly },
    async (request): Promise<CycleDetail> => {
      const { cycleId } = parse(CycleParams, request.params);
      return cycles.release(cycleId, partyOf(request));
    },
  );

  app.post(
    '/api/cycles/:cycleId/cancel',
    { preHandler: treasurerOnly },
    async (request): Promise<CycleDetail> => {
      const { cycleId } = parse(CycleParams, request.params);
      return cycles.cancel(cycleId, partyOf(request));
    },
  );

  app.post(
    '/api/proposals/:proposalId/approve',
    { preHandler: approverOnly },
    async (request): Promise<CycleDetail> => {
      const { proposalId } = parse(ProposalParams, request.params);
      const body = parse(ApproveRequestSchema, request.body ?? {});
      return cycles.approve(proposalId, partyOf(request), body.note);
    },
  );

  app.post(
    '/api/proposals/:proposalId/reject',
    { preHandler: approverOnly },
    async (request): Promise<CycleDetail> => {
      const { proposalId } = parse(ProposalParams, request.params);
      const body = parse(RejectRequestSchema, request.body);
      return cycles.reject(proposalId, partyOf(request), body.reason);
    },
  );

  app.get(
    '/api/approvals',
    { preHandler: approverOnly },
    async (request): Promise<ApprovalsInbox> => cycles.inbox(partyOf(request)),
  );

  app.get(
    '/api/decision-records/:recordId',
    { preHandler: treasuryTeam },
    async (request): Promise<DecisionRecordView> => {
      const { recordId } = parse(RecordParams, request.params);
      return cycles.decisionRecord(recordId);
    },
  );

  // Mandate and sealing --------------------------------------------------------------------

  app.get('/api/mandate', { preHandler: treasuryTeam }, async (): Promise<MandateView> => {
    const mandate = await ledger.reader.mandate();
    if (!mandate) {
      throw new ApiError(
        404,
        'no_mandate',
        'There is no sealed Mandate yet. Review the policy and seal it in the setup.',
      );
    }
    const m = mandate.payload;
    const approvers = await names.refs(m.terms.approvers);
    const nameMap: Record<string, string> = {};
    for (const a of approvers) nameMap[a.partyId] = a.displayName;
    const symbol =
      m.terms.asset.admin === config.asset.adminParty && m.terms.asset.id === config.asset.id
        ? config.asset.symbol
        : m.terms.asset.id;
    return {
      version: m.version,
      terms: termsView(m.terms, approvers, nameMap, symbol),
      agentExecutes: m.agentExecutes,
      sealedAt: m.sealedAt,
      sealedBy: await names.ref(m.treasurer),
      executedCycles: m.executedCycles,
      seal: { required: 1, signed: 1 },
    };
  });

  app.post(
    '/api/mandate/seal',
    { preHandler: treasurerOnly },
    async (request): Promise<SealStatus> => {
      const body = parse(SealMandateRequestSchema, request.body);
      return sealer.start(body.draftId, partyOf(request));
    },
  );

  app.get(
    '/api/mandate/seal/:sealId',
    { preHandler: treasuryTeam },
    async (request): Promise<SealStatus> => {
      const { sealId } = parse(SealParams, request.params);
      // Polling moves the seal forward, so progress does not depend on the background loop.
      return sealer.advance(sealId);
    },
  );

  // Policy draft ----------------------------------------------------------------------------

  app.get(
    '/api/policy/draft',
    { preHandler: treasurerOnly },
    async (request): Promise<PolicyDraft> => {
      const draft = await drafts.latest(partyOf(request));
      if (!draft) {
        throw new ApiError(
          404,
          'no_draft',
          'There is no policy draft yet. Tell the agent how distributions should work and it will draft one.',
        );
      }
      return draft;
    },
  );

  app.put(
    '/api/policy/draft',
    { preHandler: treasurerOnly },
    async (request): Promise<PolicyDraft> => {
      const body = parse(UpdatePolicyDraftRequestSchema, request.body);
      return drafts.replace(partyOf(request), body.fields);
    },
  );

  // Transaction detail (LocalNet, P3) -------------------------------------------------------

  app.get(
    '/api/tx/:updateId',
    { preHandler: requireRole('treasurer', 'approver', 'holder') },
    async (request): Promise<TxDetail> => {
      const { updateId } = parse(TxParams, request.params);
      const partyId = partyOf(request);
      const { roles } = await rolesOfRequest(request);
      const team = roles.includes('treasurer') || roles.includes('approver');
      // The ledger shows each party only what it may see, so a holder who asks as themselves
      // gets only their own payment (L7); the treasury team asks as the agent and treasury.
      const viewers = team
        ? [config.parties.agent, ...(config.ledger.readAsTreasury ? [config.parties.treasury] : [])]
        : [partyId];
      let tx;
      try {
        tx = await ledger.client.updateById(updateId, viewers);
      } catch (error) {
        if (error instanceof LedgerError && error.status >= 400 && error.status < 500) {
          throw new ApiError(404, 'not_found', 'No transaction with that id is visible to you.');
        }
        throw error;
      }
      const payments = createdIn(tx, 'Mithra.Payment:Payment').map((e) =>
        PaymentSchema.parse(e.createArgument),
      );
      // The link of a Payment that `Payment_MarkAccepted` recreated points at the transaction in
      // which the holder accepted the transfer. That transaction creates no Payment; its payment
      // is the one recorded against it in `tx_refs`, read as the viewer so a holder gets only theirs.
      if (payments.length === 0) {
        const refs = await db
          .select({ contractId: txRefs.contractId })
          .from(txRefs)
          .where(and(eq(txRefs.updateId, updateId), eq(txRefs.kind, 'payment')));
        const ids = new Set(refs.map((r) => r.contractId));
        if (ids.size > 0) {
          const reader = team ? ledger.reader : ledger.reader.as([partyId]);
          payments.push(
            ...(await reader.payments()).filter((p) => ids.has(p.contractId)).map((p) => p.payload),
          );
        }
      }
      const visible = team ? payments : payments.filter((p) => p.holder === partyId);
      if (visible.length === 0) {
        throw new ApiError(404, 'not_found', 'No transaction with that id is visible to you.');
      }
      return {
        updateId: tx.updateId,
        recordTime: tx.recordTime || tx.effectiveAt,
        payments: await Promise.all(
          visible.map(async (p) => ({
            holder: await names.ref(p.holder),
            amount: p.amount,
            status: p.status === 'Paid' ? 'paid' : 'awaiting-acceptance',
            cycleLabel: p.cycleLabel,
          })),
        ),
      };
    },
  );
}

/**
 * The same routes as a Fastify plugin with its own error handler, for `app.register(plugin)` after
 * the session plugin.
 */
export function createCycleRoutesPlugin(deps: CycleRouteDeps): FastifyPluginAsync {
  return (app) => {
    app.setErrorHandler(handleError);
    cycleRoutes(app, deps);
    return Promise.resolve();
  };
}
