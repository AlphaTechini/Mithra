/** Fixtures that match the shared API contract, for the treasurer screen tests. */
import type {
  ActivityEntry,
  CycleDetail,
  CycleSummary,
  HolderRow,
  MandateView,
  OverviewResponse,
  PolicyDraft,
  PolicyFields,
  SessionResponse,
} from '@mithra/shared';

export const TREASURER = { partyId: 'treasurer::1220aa', displayName: 'Treasurer' };
export const APPROVER_1 = { partyId: 'approver1::1220b1', displayName: 'Approver 1' };
export const APPROVER_2 = { partyId: 'approver2::1220b2', displayName: 'Approver 2' };
export const APPROVER_3 = { partyId: 'approver3::1220b3', displayName: 'Approver 3' };
export const HOLDER_A = { partyId: 'holderA::1220c1', displayName: 'Holder A' };
export const HOLDER_B = { partyId: 'holderB::1220c2', displayName: 'Holder B' };

export function session(
  role: 'treasurer' | 'approver',
  network: 'localnet' | 'mainnet' = 'localnet',
): SessionResponse {
  const who = role === 'treasurer' ? TREASURER : APPROVER_1;
  return {
    network,
    testMode: network === 'localnet',
    signedIn: true,
    party: { ...who, roles: [role], primaryRole: role },
  };
}

export const PUBLIC_CONFIG = (network: 'localnet' | 'mainnet' = 'localnet') => ({
  network,
  testMode: network === 'localnet',
  assetSymbol: 'CC',
  explorerTxUrlTemplate: network === 'mainnet' ? 'https://explorer.example/tx/{updateId}' : null,
  groftyMinVersion: '1.0.0',
});

export function sessionRoutes(
  role: 'treasurer' | 'approver',
  network: 'localnet' | 'mainnet' = 'localnet',
): Record<string, unknown> {
  return {
    'GET /api/session': session(role, network),
    'GET /api/config/public': PUBLIC_CONFIG(network),
  };
}

export function summary(overrides: Partial<CycleSummary> = {}): CycleSummary {
  return {
    cycleId: '2026-09',
    label: 'September 2026',
    status: 'awaiting-approval',
    total: '1200.0000000000',
    recordDate: '2026-09-30',
    approvals: { have: 0, need: 2 },
    flagCount: 2,
    trigger: 'manual',
    createdAt: '2026-10-01T09:00:00Z',
    seeded: false,
    ...overrides,
  };
}

const TIMELINE: CycleDetail['timeline'] = [
  { id: 'woke', label: 'Woke up', status: 'done', detail: null, at: '2026-10-01T09:00:00Z' },
  {
    id: 'snapshot',
    label: 'Snapshot taken',
    status: 'done',
    detail: '4 holders',
    at: '2026-10-01T09:00:02Z',
  },
  {
    id: 'amounts',
    label: 'Amounts computed',
    status: 'done',
    detail: null,
    at: '2026-10-01T09:00:03Z',
  },
  {
    id: 'checks',
    label: 'Checks run',
    status: 'done',
    detail: '2 flags',
    at: '2026-10-01T09:00:04Z',
  },
  {
    id: 'review',
    label: 'Review written',
    status: 'done',
    detail: null,
    at: '2026-10-01T09:00:06Z',
  },
  {
    id: 'verdict',
    label: 'Verdict',
    status: 'done',
    detail: 'Needs approval',
    at: '2026-10-01T09:00:07Z',
  },
];

export function proposal(
  overrides: Partial<NonNullable<CycleDetail['proposal']>> = {},
): NonNullable<CycleDetail['proposal']> {
  return {
    proposalId: 'prop-1',
    total: '1200.0000000000',
    recordDate: '2026-09-30',
    verdict: 'needs-approval',
    verdictReasons: ['Total is 193% above the 3-cycle average'],
    payouts: [
      {
        holder: HOLDER_A,
        units: 600,
        sharePct: '60.00',
        amount: '720.0000000000',
        payment: null,
      },
      {
        holder: HOLDER_B,
        units: 400,
        sharePct: '40.00',
        amount: '480.0000000000',
        payment: null,
      },
    ],
    checks: [
      {
        code: 'cap',
        label: 'Within the auto-execute cap',
        passed: true,
        blocking: true,
        actual: 'Total 1,200 CC',
        limit: 'Cap 5,000 CC',
        source: 'deterministic',
      },
      {
        code: 'deviation',
        label: 'Close to the trailing average',
        passed: false,
        blocking: true,
        actual: 'Total 1,200 CC vs 3-cycle average 410 CC, +193%',
        limit: 'Within 50%',
        source: 'deterministic',
      },
      {
        code: 'ai-note',
        label: 'Holder B joined recently',
        passed: false,
        blocking: false,
        actual: 'Holder B was issued units 2 days before the record date',
        limit: '',
        source: 'ai',
      },
    ],
    memo: 'The total is far above recent cycles because Holder B joined shortly before the record date.',
    memoSource: 'Written by the agent',
    approvals: [],
    approvalThreshold: 2,
    approvers: [APPROVER_1, APPROVER_2, APPROVER_3],
    decisionRecordId: 'rec-1',
    ...overrides,
  };
}

export function cycleDetail(overrides: Partial<CycleDetail> = {}): CycleDetail {
  return {
    summary: summary(),
    timeline: TIMELINE,
    proposal: proposal(),
    decisionRecord: null,
    countdown: null,
    outcome: null,
    fundsShortfall: null,
    error: null,
    ...overrides,
  };
}

export function fields(overrides: Partial<PolicyFields> = {}): PolicyFields {
  return {
    cap: '5000',
    approvers: [APPROVER_1.partyId, APPROVER_2.partyId, APPROVER_3.partyId],
    approvalThreshold: 2,
    scheduleCron: '0 9 1 * *',
    scheduleTimezone: 'UTC',
    recordDateRule: 'last_day_of_previous_month',
    fixedAmount: null,
    deviationPct: '50',
    trailingCycles: 3,
    unitChangePct: '100',
    unitChangeWindowDays: 3,
    feeBuffer: '5',
    ...overrides,
  };
}

export function draft(overrides: Partial<PolicyDraft> = {}): PolicyDraft {
  return {
    draftId: 'draft-1',
    fields: fields(),
    summary: 'Pays monthly on the 1st. Auto-pays up to 5,000 CC.',
    agentCan: ['Pay holders pro rata on the 1st'],
    agentCannot: ['Pay more than 5,000 CC without 2 of 3 approvals'],
    source: 'agent',
    updatedAt: '2026-10-01T09:00:00Z',
    ...overrides,
  };
}

export function mandate(overrides: Partial<MandateView> = {}): MandateView {
  return {
    version: 1,
    terms: {
      cap: '5000',
      approvers: [APPROVER_1, APPROVER_2, APPROVER_3],
      approvalThreshold: 2,
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
      feeBuffer: '5',
    },
    agentExecutes: true,
    sealedAt: '2026-10-01T08:00:00Z',
    sealedBy: TREASURER,
    executedCycles: [],
    seal: { required: 1, signed: 1 },
    ...overrides,
  };
}

export function activity(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: 'act-1',
    at: '2026-10-01T09:00:00Z',
    actor: TREASURER,
    kind: 'mandate.sealed',
    text: 'Treasurer sealed the mandate',
    link: null,
    seeded: false,
    ...overrides,
  };
}

export function overview(overrides: Partial<OverviewResponse> = {}): OverviewResponse {
  return {
    balance: '10000.0000000000',
    assetSymbol: 'CC',
    nextCycle: { cycleId: '2026-10', label: 'October 2026', at: '2026-11-01T09:00:00Z' },
    expectedNextTotal: '1200.0000000000',
    fundsWarning: null,
    mandate: mandate(),
    pendingApprovals: 1,
    recentCycles: [summary()],
    recentActivity: [activity()],
    ...overrides,
  };
}

export function holderRow(overrides: Partial<HolderRow> = {}): HolderRow {
  return {
    holder: HOLDER_A,
    units: 600,
    sharePct: '60.00',
    autoReceive: true,
    unitsAccepted: true,
    lastPayment: null,
    seeded: false,
    ...overrides,
  };
}
