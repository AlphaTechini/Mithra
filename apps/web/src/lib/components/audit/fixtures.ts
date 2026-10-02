/** Fixtures that match the shared audit API contract, for the M9b tests. Not imported by any screen. */
import type {
  AuditRequestDetail,
  AuditRequestView,
  EvidenceRoom,
  GrantView,
  RecordPreview,
  ScopeDraft,
  SessionResponse,
} from '@mithra/shared';

export const AUDITOR = {
  partyId: 'auditor::1220dddd00000000000000000000000000000000000000000000000000000004',
  displayName: 'Auditor',
};
export const TREASURER = {
  partyId: 'treasurer::1220aaaa00000000000000000000000000000000000000000000000000000001',
  displayName: 'Treasurer',
};
/** Real holder party ids: none of these may ever reach the auditor's DOM (L8). */
export const HOLDER_IDS = [
  'holderA::1220c1c100000000000000000000000000000000000000000000000000000011',
  'holderB::1220c2c200000000000000000000000000000000000000000000000000000012',
];

export function sessionFor(role: 'auditor' | 'treasurer'): SessionResponse {
  const who = role === 'auditor' ? AUDITOR : TREASURER;
  return {
    network: 'localnet',
    testMode: true,
    signedIn: true,
    party: { ...who, roles: [role], primaryRole: role },
  };
}

export const CONFIG = {
  network: 'localnet',
  testMode: true,
  payoutRail: 'ledger',
  assetSymbol: 'CC',
  explorerTxUrlTemplate: null,
  groftyMinVersion: '1.0.0',
  demoVideoUrl: null,
};

export function sessionRoutes(role: 'auditor' | 'treasurer'): Record<string, unknown> {
  return { 'GET /api/session': sessionFor(role), 'GET /api/config/public': CONFIG };
}

export const QUESTION = 'Show all Q3 distributions and the approvals behind any flagged one.';

export const DRAFT: ScopeDraft = {
  items: [
    {
      recordId: 'rec-2026-07',
      kind: 'decision',
      label: 'Decision record, July 2026',
      reason: 'Q3 distribution for July.',
    },
    {
      recordId: 'rec-2026-08',
      kind: 'decision',
      label: 'Decision record, August 2026',
      reason: 'Q3 distribution for August.',
    },
    {
      recordId: 'out-2026-09',
      kind: 'outcome',
      label: 'Outcome, September 2026',
      reason: 'Flagged: the approvals behind it.',
    },
  ],
  excluded: 'Holder identities are shown as Holder A to D unless you ask for them.',
  source: 'ai',
  notice: null,
};

export function requestView(overrides: Partial<AuditRequestView> = {}): AuditRequestView {
  return {
    requestId: 'req-1',
    auditor: AUDITOR,
    question: QUESTION,
    scope: DRAFT.items,
    excluded: DRAFT.excluded,
    requestedAt: '2026-10-01T09:00:00Z',
    status: 'pending',
    grant: null,
    denial: null,
    ...overrides,
  };
}

export const GRANT: GrantView = {
  grantId: 'grant-1',
  grantedAt: '2026-10-01T10:00:00Z',
  expiresAt: '2026-10-08T10:00:00Z',
  recordIds: ['rec-2026-07', 'rec-2026-08'],
  closedAt: null,
  closedReason: null,
};

export function grantedView(overrides: Partial<AuditRequestView> = {}): AuditRequestView {
  return requestView({ status: 'granted', grant: { ...GRANT }, ...overrides });
}

export const PREVIEW: RecordPreview[] = [
  {
    recordId: 'rec-2026-07',
    kind: 'decision',
    label: 'Decision record, July 2026',
    summary: '1,200 CC to 4 holders, within mandate',
    available: true,
  },
  {
    recordId: 'rec-2026-08',
    kind: 'decision',
    label: 'Decision record, August 2026',
    summary: '1,300 CC to 4 holders, flagged, approved 2 of 3',
    available: true,
  },
  {
    recordId: 'out-2026-09',
    kind: 'outcome',
    label: 'Outcome, September 2026',
    summary: 'Executed after approval',
    available: false,
  },
];

export function detail(
  request: AuditRequestView,
  preview: RecordPreview[] | null = PREVIEW,
): AuditRequestDetail {
  return { request, preview };
}

export function evidenceRoom(overrides: Partial<EvidenceRoom> = {}): EvidenceRoom {
  return {
    grantId: 'grant-1',
    question: QUESTION,
    grantedAt: new Date(Date.now() - 24 * 3600_000).toISOString(),
    expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
    records: [
      {
        recordId: 'rec-2026-08',
        kind: 'decision',
        cycleLabel: 'August 2026',
        decision: {
          trigger: 'Scheduled monthly cycle',
          recordDate: '2026-07-31',
          total: '1300.0000000000',
          payouts: [
            { holderLabel: 'Holder A', units: 600, amount: '650.0000000000' },
            { holderLabel: 'Holder B', units: 600, amount: '650.0000000000' },
          ],
          inputFingerprints: [{ label: 'Holder snapshot', sha256: 'ab12cd34'.repeat(8) }],
          modelFingerprints: [],
          checks: [
            {
              label: 'Total within the monthly cap',
              passed: false,
              blocking: false,
              actual: '1,300 CC',
              limit: '1,250 CC',
              source: 'Mandate v2',
            },
          ],
          memo: 'August is 4 percent over the usual amount, so it needs approval.',
          verdict: 'needs-approval',
          mandateVersion: 2,
          cap: '1250.0000000000',
          createdAt: '2026-08-31T09:00:00Z',
        },
        outcome: {
          kind: 'executed',
          approvals: [
            { approverLabel: 'Approver 1', at: '2026-09-01T10:00:00Z', note: 'Checked the memo.' },
          ],
          payments: [
            {
              holderLabel: 'Holder A',
              amount: '650.0000000000',
              status: 'paid',
              link: { updateId: 'upd-1', href: '/app/tx/upd-1', external: false },
            },
          ],
          reason: null,
          at: '2026-09-01T10:05:00Z',
        },
      },
    ],
    ...overrides,
  };
}

/** The same room with identity fields a careless backend might add; the schema must drop them. */
export function evidenceWithLeaks(): unknown {
  const room = evidenceRoom();
  return {
    ...room,
    records: room.records.map((record) => ({
      ...record,
      decision: record.decision && {
        ...record.decision,
        payouts: record.decision.payouts.map((p, i) => ({ ...p, holder: HOLDER_IDS[i] })),
      },
    })),
  };
}
