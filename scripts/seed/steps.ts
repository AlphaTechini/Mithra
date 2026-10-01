import type { Backend } from '../../apps/backend/src/wiring/backend';
import { defaultPolicyFields } from '../../apps/backend/src/wiring/agentServices';
import { D } from '../../apps/backend/src/cycle/format';
import type { MandateSealer } from '../../apps/backend/src/governance/sealer';
import { describeSchedule, formatAmount } from '../../apps/backend/src/routes/treasury/format';

type SealStatus = Awaited<ReturnType<MandateSealer['start']>>;

/**
 * The seeding steps (T4, U8, details.md feature 17): real demo history on a ledger, tagged as
 * seeded. Every step looks at what is already there and skips itself, so running the script again
 * changes nothing. The steps work on any `Backend`: LocalNet in production, the full-stack test
 * server in `--sandbox` mode.
 */

export const FUND_NAME = 'Northwind Income Fund';
/** The demo holders and their units, effective on `UNITS_EFFECTIVE_DATE`. */
export const DEMO_HOLDERS: { name: string; units: number }[] = [
  { name: 'Holder A', units: 100 },
  { name: 'Holder B', units: 300 },
  { name: 'Holder C', units: 600 },
  { name: 'Holder D', units: 1000 },
];
export const UNITS_EFFECTIVE_DATE = '2026-05-01';
/** The treasury is topped up with `FUND_AMOUNT` when it holds less than `MIN_BALANCE`. */
export const MIN_BALANCE = '10000';
export const FUND_AMOUNT = '20000';
/**
 * The seeded history: June and July. The live demo then runs August (clean, 300 CC) and September
 * (flagged: Holder C's units jump just before the record date, 1,200 CC against a ~400 CC average).
 */
export const DEMO_CYCLES: { cycleId: string; total: string }[] = [
  { cycleId: '2026-06', total: '400' },
  { cycleId: '2026-07', total: '420' },
];
/**
 * Holders who get auto-receive, so their payments settle at once. Holder D has none, so the demo
 * shows the pending-acceptance path with one holder only.
 */
export const AUTO_RECEIVE_HOLDERS = ['Holder A', 'Holder B', 'Holder C'];

/** Cycle statuses that mean the distribution was executed. */
const EXECUTED = new Set(['paid-automatically', 'paid-after-approval', 'awaiting-acceptance']);
/** Cycle statuses from which nothing happens by itself. */
const STUCK = new Set(['failed', 'rejected', 'cancelled', 'needs-funds', 'awaiting-approval']);

export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedError';
  }
}

export interface SeedContext {
  backend: Pick<
    Backend,
    'config' | 'ledger' | 'asset' | 'funding' | 'cycle' | 'holderAdmin' | 'activity' | 'names'
  >;
  /** Where a step's line goes. */
  print(line: string): void;
  /** How long to wait for the Mandate to be sealed (node confirmations) and for a cycle. */
  sealTimeoutMs?: number;
  cycleTimeoutMs?: number;
  /** How long to wait for the registry to show a new preapproval. */
  autoReceiveTimeoutMs?: number;
  pollMs?: number;
}

export interface StepResult {
  step: string;
  /** `done` when the step changed something, `skipped` when it was already done. */
  outcome: 'done' | 'skipped';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What the registry says about a transfer from the treasury to `holder`: `direct` means auto-receive is on. */
async function hasAutoReceive(backend: SeedContext['backend'], holder: string): Promise<boolean> {
  try {
    const leg = await backend.asset.transferLeg({
      sender: backend.config.parties.treasury,
      receiver: holder,
      amount: '1',
    });
    return leg.kind === 'direct';
  } catch (error) {
    throw new SeedError(
      `Could not ask the registry whether the holder has auto-receive: ${error instanceof Error ? error.message : String(error)} Check the registry (scripts/localnet-status.sh) and seed again.`,
    );
  }
}

/**
 * Turns auto-receive on for one holder, unless the registry already reports `direct` for them.
 * Waits until the registry shows it, so the cycles that follow pay straight to the holder.
 */
export async function ensureAutoReceive(
  ctx: SeedContext,
  holder: string,
): Promise<StepResult['outcome']> {
  const { backend } = ctx;
  if (await hasAutoReceive(backend, holder)) return 'skipped';
  try {
    await backend.funding.createPreapproval(holder);
  } catch (error) {
    throw new SeedError(
      `Could not turn on auto-receive: ${error instanceof Error ? error.message : String(error)} Fix that and seed again.`,
    );
  }
  const deadline = Date.now() + (ctx.autoReceiveTimeoutMs ?? 60_000);
  while (!(await hasAutoReceive(backend, holder))) {
    if (Date.now() > deadline) {
      throw new SeedError(
        'Auto-receive was created but the registry does not show it yet. Wait a moment and seed again.',
      );
    }
    await sleep(ctx.pollMs ?? 1000);
  }
  return 'done';
}

/** Runs every seeding step in order and prints one line for each. */
export async function runSeed(ctx: SeedContext): Promise<StepResult[]> {
  const { backend } = ctx;
  const { config, ledger } = backend;
  if (config.network !== 'localnet') {
    throw new SeedError('Seeding is for LocalNet only. Set NETWORK=localnet.');
  }
  const pollMs = ctx.pollMs ?? 1000;
  const results: StepResult[] = [];

  const demoParty = (displayName: string): string => {
    const found = config.localnet.demoParties.find(
      (p) => p.displayName.toLowerCase() === displayName.toLowerCase(),
    );
    if (!found) {
      throw new SeedError(
        `LOCALNET_DEMO_PARTIES has no party named "${displayName}". Add it to .env (scripts/localnet-up.sh writes the list).`,
      );
    }
    return found.partyId;
  };
  const treasurer = demoParty('Treasurer');
  const approvers = ['Approver 1', 'Approver 2', 'Approver 3'].map(demoParty);

  function report(step: string, outcome: StepResult['outcome'], text: string): void {
    results.push({ step, outcome });
    ctx.print(`${step}: ${text}`);
  }

  // (a) The organization --------------------------------------------------------------------
  {
    const organization = await ledger.reader.organization();
    if (organization) {
      report('Organization', 'skipped', `already done (${organization.payload.name})`);
    } else {
      const charter = await ledger.reader.charter();
      if (!charter) {
        throw new SeedError(
          'There is no treasury charter on the ledger. Run scripts/localnet-up.sh to create it, then seed again.',
        );
      }
      if (charter.payload.treasurer !== treasurer) {
        throw new SeedError(
          'The treasury charter names a different treasurer than the demo party "Treasurer". Check LOCALNET_DEMO_PARTIES.',
        );
      }
      await ledger.client.submit({
        actAs: [treasurer],
        commands: [
          ledger.commands.charterCreateOrganization(charter.contractId, {
            name: FUND_NAME,
            asset: { admin: config.asset.adminParty, id: config.asset.id },
            approvers,
            approvalThreshold: 2,
          }),
        ],
      });
      await backend.activity.record({
        actorParty: treasurer,
        kind: 'org.created',
        subject: FUND_NAME,
        text: `Treasurer created ${FUND_NAME} with 3 approvers, 2 of 3`,
        seeded: true,
      });
      report('Organization', 'done', `created ${FUND_NAME} with Approver 1 to 3, threshold 2`);
    }
  }

  // (b) The Mandate -------------------------------------------------------------------------
  {
    const mandate = await ledger.reader.mandate();
    if (mandate) {
      report('Mandate', 'skipped', `already done (version ${mandate.payload.version})`);
    } else {
      const fields = defaultPolicyFields(approvers, 2);
      const draft = await backend.cycle.drafts.savePolicyDraft(fields, 'edited', treasurer);
      let status = await backend.cycle.sealer.start(draft.draftId, treasurer);
      let shown = '';
      const deadline = Date.now() + (ctx.sealTimeoutMs ?? 5 * 60_000);
      while (status.state === 'awaiting-nodes' || status.state === 'awaiting-signature') {
        shown = printConfirmations(ctx, status, shown);
        if (Date.now() > deadline) {
          throw new SeedError(
            'Sealing the Mandate timed out waiting for node confirmations. Check the nodes (scripts/localnet-status.sh) and seed again.',
          );
        }
        await sleep(pollMs);
        status = await backend.cycle.sealer.advance(status.sealId);
      }
      printConfirmations(ctx, status, shown);
      if (status.state !== 'sealed') {
        throw new SeedError(`Sealing the Mandate failed: ${status.error ?? 'no reason given'}`);
      }
      report(
        'Mandate',
        'done',
        `sealed version ${status.mandateVersion ?? 1} (cap ${formatAmount(fields.cap)} ${config.asset.symbol}, 2 of 3 approvals, ${describeSchedule(fields.scheduleCron, fields.scheduleTimezone)})`,
      );
    }
  }

  // (c) Units -------------------------------------------------------------------------------
  {
    const register = await ledger.reader.register();
    const held = new Map<string, number>();
    for (const change of register?.payload.changes ?? []) {
      held.set(change.holder, (held.get(change.holder) ?? 0) + change.delta);
    }
    for (const demo of DEMO_HOLDERS) {
      const holder = demoParty(demo.name);
      const step = `Units ${demo.name}`;
      const have = held.get(holder) ?? 0;
      if (have > 0) {
        report(step, 'skipped', `already done (${formatAmount(String(have))} units)`);
        continue;
      }
      await backend.holderAdmin.issueUnits({
        actor: treasurer,
        holder,
        units: demo.units,
        effectiveDate: UNITS_EFFECTIVE_DATE,
        seeded: true,
      });
      report(
        step,
        'done',
        `issued ${formatAmount(String(demo.units))} units, effective ${UNITS_EFFECTIVE_DATE}, seeded`,
      );
    }
  }

  // (d) Funds -------------------------------------------------------------------------------
  {
    const symbol = config.asset.symbol;
    const balance = await backend.asset.balance(config.parties.treasury);
    if (new D(balance).gte(new D(MIN_BALANCE))) {
      report('Treasury funds', 'skipped', `already done (${formatAmount(balance)} ${symbol})`);
    } else {
      await backend.funding.fundTreasury(FUND_AMOUNT);
      const after = await backend.asset.balance(config.parties.treasury);
      report(
        'Treasury funds',
        'done',
        `added ${formatAmount(FUND_AMOUNT)} ${symbol} (was ${formatAmount(balance)}, now ${formatAmount(after)})`,
      );
    }
  }

  // (e) Auto-receive ------------------------------------------------------------------------
  // Before the cycles, so their payments to Holders A to C settle at once; Holder D keeps the
  // pending-acceptance path.
  for (const name of AUTO_RECEIVE_HOLDERS) {
    const step = `Auto-receive ${name}`;
    const outcome = await ensureAutoReceive(ctx, demoParty(name));
    report(
      step,
      outcome,
      outcome === 'done' ? 'turned on' : 'already done (the registry reports direct)',
    );
  }

  // (f) Cycles ------------------------------------------------------------------------------
  for (const demo of DEMO_CYCLES) {
    const step = `Cycle ${demo.cycleId}`;
    const symbol = config.asset.symbol;
    const existing = (await backend.cycle.cycles.listCycles()).find(
      (c) => c.cycleId === demo.cycleId,
    );
    if (existing && existing.status !== 'failed') {
      report(step, 'skipped', `already done (${existing.status})`);
      continue;
    }
    await backend.cycle.cycles.run({
      trigger: 'manual',
      triggerDetail: 'Seeded demo cycle',
      cycleId: demo.cycleId,
      total: demo.total,
      actorParty: treasurer,
      seeded: true,
    });
    const deadline = Date.now() + (ctx.cycleTimeoutMs ?? 3 * 60_000);
    for (;;) {
      const detail = await backend.cycle.cycles.getCycle(demo.cycleId);
      const status = detail.summary.status;
      if (EXECUTED.has(status)) {
        report(step, 'done', `ran ${formatAmount(demo.total)} ${symbol}, ${status}, seeded`);
        break;
      }
      if (STUCK.has(status)) {
        throw new SeedError(
          `${step} stopped at "${status}"${detail.error ? `: ${detail.error}` : ''}. Fix that and seed again.`,
        );
      }
      if (Date.now() > deadline) {
        throw new SeedError(`${step} did not execute in time (status "${status}").`);
      }
      // The reconciler may not be running in this process: this pays the cycle once its countdown is over.
      await backend.cycle.cycles.advance(demo.cycleId).catch(() => undefined);
      await sleep(pollMs);
    }
  }

  return results;
}

/** Prints the node confirmations when they changed since `shown`; returns what was printed. */
function printConfirmations(ctx: SeedContext, status: SealStatus, shown: string): string {
  const nodes = status.nodeConfirmations;
  if (!nodes) return shown;
  const confirmed = nodes.nodes.filter((n) => n.confirmed).map((n) => n.name);
  const line = `  node confirmations: ${nodes.confirmed} of ${nodes.required}${confirmed.length > 0 ? ` (${confirmed.join(', ')})` : ''}`;
  if (line !== shown) ctx.print(line);
  return line;
}
