import {
  CycleDetailSchema,
  MandateViewSchema,
  formatDecimal,
  toDecimal,
  type CycleDetail,
  type CycleSummary,
  type HoldersResponse,
  type Invite,
  type MandateView,
  type PartyRef,
  type PolicyDraft,
  type PolicyFields,
} from '@mithra/shared';
import Decimal from 'decimal.js';
import type { Fingerprint } from '../ledger/mithra/templates';
import { cycleLabelOf } from './format';
import type { AgentServices } from './services';

/** In-memory `AgentServices` for tests. Every call is recorded in `calls`. Not used by the application. */

export const FAKE_PARTIES = {
  treasurer: { partyId: 'treasurer::1220aa', displayName: 'Treasurer' },
  approver1: { partyId: 'approver1::1220aa', displayName: 'Approver 1' },
  approver2: { partyId: 'approver2::1220aa', displayName: 'Approver 2' },
  approver3: { partyId: 'approver3::1220aa', displayName: 'Approver 3' },
  holderA: { partyId: 'holderA::1220aa', displayName: 'Holder A' },
  holderB: { partyId: 'holderB::1220aa', displayName: 'Holder B' },
  holderC: { partyId: 'holderC::1220aa', displayName: 'Holder C' },
  holderD: { partyId: 'holderD::1220aa', displayName: 'Holder D' },
} satisfies Record<string, PartyRef>;

const UNITS: [PartyRef, number][] = [
  [FAKE_PARTIES.holderA, 100],
  [FAKE_PARTIES.holderB, 300],
  [FAKE_PARTIES.holderC, 400],
  [FAKE_PARTIES.holderD, 200],
];

export interface FakeCall {
  method: string;
  args: unknown;
}

export interface RunInput {
  trigger: 'schedule' | 'prompt' | 'manual';
  triggerDetail: string;
  cycleId?: string;
  total?: string;
  recordDate?: string;
  promptText?: string;
  modelFingerprints?: Fingerprint[];
  actorParty: string;
}

export interface FakeServices extends AgentServices {
  calls: FakeCall[];
  /** Calls of methods that change something (not reads). */
  writes(): FakeCall[];
  runs: RunInput[];
  cycles: AgentServices['cycles'] & { store: Map<string, CycleDetail> };
  state: {
    mandate: MandateView | null;
    balance: string | null;
    cap: string;
    threshold: number;
    /** What `getCycle` returns for a new cycle: when set, the proposal is not ready this many polls. */
    proposalDelayPolls: number;
    payments: Awaited<ReturnType<AgentServices['history']['payments']>>;
  };
}

export function fakeMandate(cap = '5000', threshold = 2): MandateView {
  return MandateViewSchema.parse({
    version: 1,
    terms: {
      cap,
      approvers: [FAKE_PARTIES.approver1, FAKE_PARTIES.approver2, FAKE_PARTIES.approver3],
      approvalThreshold: threshold,
      assetSymbol: 'CC',
      scheduleCron: '0 9 1 * *',
      scheduleTimezone: 'UTC',
      scheduleText: 'Monthly on the 1st at 09:00 UTC',
      recordDateRule: 'last_day_of_previous_month',
      recordDateText: 'Last day of the previous month',
      fixedAmount: null,
      deviationPct: '50',
      trailingCycles: 3,
      unitChangePct: '100',
      unitChangeWindowDays: 3,
      feeBuffer: '1',
    },
    agentExecutes: true,
    sealedAt: '2026-08-01T09:00:00.000Z',
    sealedBy: FAKE_PARTIES.treasurer,
    executedCycles: [],
    seal: { required: 1, signed: 1 },
  });
}

/** Pro-rata split for the fake engine. Test double only: the real arithmetic lives in the cycle engine. */
function fakeSplit(total: string): { holder: PartyRef; units: number; amount: string }[] {
  const totalUnits = UNITS.reduce((s, [, u]) => s + u, 0);
  return UNITS.map(([holder, units]) => ({
    holder,
    units,
    amount: formatDecimal(
      toDecimal(total).mul(units).div(totalUnits).toDecimalPlaces(10, Decimal.ROUND_DOWN),
    ),
  }));
}

function buildCycle(input: RunInput, cycleId: string, state: FakeServices['state']): CycleDetail {
  const total = input.total ?? '1000';
  const needsApproval = toDecimal(total).gt(toDecimal(state.cap));
  const label = cycleLabelOf(cycleId);
  const payouts = fakeSplit(total).map((p) => ({
    holder: p.holder,
    units: p.units,
    sharePct: formatDecimal(new Decimal(p.units).div(10)).replace(/0+$/, '').replace(/\.$/, ''),
    amount: p.amount,
    payment: null,
  }));
  return CycleDetailSchema.parse({
    summary: {
      cycleId,
      label,
      status: needsApproval ? 'awaiting-approval' : 'countdown',
      total,
      recordDate: input.recordDate ?? '2026-09-30',
      approvals: needsApproval ? { have: 0, need: state.threshold } : null,
      flagCount: needsApproval ? 1 : 0,
      trigger: input.trigger,
      createdAt: new Date().toISOString(),
      seeded: false,
    },
    timeline: [],
    proposal: {
      proposalId: `proposal-${cycleId}`,
      total,
      recordDate: input.recordDate ?? '2026-09-30',
      verdict: needsApproval ? 'needs-approval' : 'within-mandate',
      verdictReasons: needsApproval ? [`Total is above the ${state.cap} CC cap`] : [],
      payouts,
      checks: [
        {
          code: 'cap',
          label: 'Within the auto-execute cap',
          passed: !needsApproval,
          blocking: true,
          actual: `Total ${total} CC vs cap ${state.cap} CC`,
          limit: `${state.cap} CC`,
          source: 'deterministic',
        },
      ],
      memo: 'Fake memo.',
      memoSource: 'template',
      approvals: [],
      approvalThreshold: state.threshold,
      approvers: [FAKE_PARTIES.approver1, FAKE_PARTIES.approver2, FAKE_PARTIES.approver3],
      decisionRecordId: `decision/${cycleId}/1`,
    },
    decisionRecord: null,
    countdown: null,
    outcome: null,
    fundsShortfall: null,
    error: null,
  });
}

export function createFakeServices(): FakeServices {
  const calls: FakeCall[] = [];
  const runs: RunInput[] = [];
  const store = new Map<string, CycleDetail>();
  const polls = new Map<string, number>();
  const state: FakeServices['state'] = {
    mandate: fakeMandate(),
    balance: '25000.0000000000',
    cap: '5000',
    threshold: 2,
    proposalDelayPolls: 0,
    payments: [],
  };
  const record = <T>(method: string, args: unknown, value: T): Promise<T> => {
    calls.push({ method, args });
    return Promise.resolve(value);
  };
  let draft: PolicyDraft | null = null;
  let inviteCounter = 0;

  const services: FakeServices = {
    calls,
    runs,
    state,
    writes: () =>
      calls.filter((c) =>
        ['cycles.run', 'policy.saveDraft', 'org.issueUnits', 'org.createInvite'].includes(c.method),
      ),
    cycles: {
      store,
      run(input) {
        runs.push(input);
        const cycleId = input.cycleId ?? '2026-09';
        store.set(cycleId, buildCycle(input, cycleId, state));
        return record('cycles.run', input, { cycleId });
      },
      getCycle(cycleId) {
        calls.push({ method: 'cycles.getCycle', args: cycleId });
        const seen = (polls.get(cycleId) ?? 0) + 1;
        polls.set(cycleId, seen);
        const detail = store.get(cycleId) ?? null;
        if (detail && seen <= state.proposalDelayPolls) {
          return Promise.resolve({ ...detail, proposal: null });
        }
        return Promise.resolve(detail);
      },
      listCycles() {
        calls.push({ method: 'cycles.listCycles', args: null });
        const list: CycleSummary[] = [...store.values()].map((d) => d.summary);
        return Promise.resolve(list);
      },
    },
    policy: {
      saveDraft(fields: PolicyFields, source, party) {
        draft = {
          draftId: 'draft-1',
          fields,
          summary: `Pays on ${fields.scheduleCron}, cap ${fields.cap} CC, ${fields.approvalThreshold} of ${fields.approvers.length} approvals.`,
          agentCan: [],
          agentCannot: [],
          source,
          updatedAt: new Date().toISOString(),
        };
        return record('policy.saveDraft', { fields, source, party }, draft);
      },
      currentDraft(party) {
        return record('policy.currentDraft', party, draft);
      },
    },
    org: {
      holders() {
        const response: HoldersResponse = {
          totalUnits: UNITS.reduce((s, [, u]) => s + u, 0),
          holders: UNITS.map(([holder, units]) => ({
            holder,
            units,
            sharePct: (units / 10).toFixed(2),
            autoReceive: true,
            unitsAccepted: true,
            lastPayment: null,
            seeded: false,
          })),
        };
        return record('org.holders', null, response);
      },
      issueUnits(input) {
        return record('org.issueUnits', input, undefined);
      },
      createInvite(input) {
        inviteCounter += 1;
        const invite: Invite = {
          code: `INV${inviteCounter}`,
          kind: input.kind,
          displayName: input.displayName,
          path: `/invite/INV${inviteCounter}`,
          orgName: 'Acme Fund',
          used: false,
        };
        return record('org.createInvite', input, invite);
      },
      balance() {
        return record('org.balance', null, state.balance);
      },
      mandate() {
        return record('org.mandate', null, state.mandate);
      },
      parties() {
        return record('org.parties', null, Object.values(FAKE_PARTIES) as PartyRef[]);
      },
    },
    history: {
      payments(filter) {
        const rows = state.payments.filter(
          (p) =>
            (filter.holder === undefined || p.holder.partyId === filter.holder) &&
            (filter.from === undefined || p.at.slice(0, 10) >= filter.from) &&
            (filter.to === undefined || p.at.slice(0, 10) <= filter.to),
        );
        return record('history.payments', filter, rows);
      },
    },
  };
  return services;
}

/** A name lookup for tests: the fake parties by id. */
export const fakeNames = {
  name(partyId: string): Promise<string> {
    const found = Object.values(FAKE_PARTIES).find((p) => p.partyId === partyId);
    return Promise.resolve(found?.displayName ?? partyId);
  },
};
