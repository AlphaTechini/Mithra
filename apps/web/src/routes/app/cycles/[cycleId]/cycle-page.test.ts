import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CycleDetail } from '@mithra/shared';
import { live } from '$lib/stores/live.svelte';
import { sessionStore } from '$lib/stores/session.svelte';
import { toasts } from '$lib/stores/toasts.svelte';
import {
  APPROVER_1,
  APPROVER_2,
  cycleDetail,
  proposal,
  sessionRoutes,
  summary,
} from '../../../../test/treasury/fixtures';
import {
  FakeEventSource,
  deferred,
  installFakeEventSource,
  stubApi,
} from '../../../../test/treasury/stub';
import Page from './+page.svelte';

vi.mock('$app/state', () => ({
  page: {
    params: { cycleId: '2026-09' },
    url: new URL('http://localhost/app/cycles/2026-09'),
  },
}));

const CYCLE = 'GET /api/cycles/2026-09';

async function signIn(
  role: 'treasurer' | 'approver',
  routes: Record<string, unknown>,
): Promise<ReturnType<typeof stubApi>> {
  const api = stubApi({ ...sessionRoutes(role), ...routes });
  await sessionStore.load();
  return api;
}

const within_mandate = (overrides: Partial<CycleDetail> = {}): CycleDetail =>
  cycleDetail({
    summary: summary({ status: 'executing', approvals: null, flagCount: 0 }),
    proposal: proposal({
      verdict: 'within-mandate',
      verdictReasons: [],
      approvers: [],
      approvalThreshold: 0,
      checks: [],
      payouts: [
        {
          holder: { partyId: 'holderA::1220c1', displayName: 'Holder A' },
          units: 600,
          sharePct: '100.00',
          amount: '1200.0000000000',
          payment: { status: 'pending-ledger', link: null },
        },
      ],
    }),
    ...overrides,
  });

beforeEach(() => {
  sessionStore.reset();
  live.reset();
  toasts.clear();
  installFakeEventSource();
});

afterEach(() => {
  live.reset();
  vi.unstubAllGlobals();
});

describe('cycle page', () => {
  it('shows "Pending ledger confirmation" until the server reports a Paid payment (P4)', async () => {
    const api = await signIn('treasurer', { [CYCLE]: within_mandate() });
    render(Page);

    await screen.findByText('Holder A');
    expect(screen.getAllByText('Pending ledger confirmation').length).toBeGreaterThan(0);
    expect(screen.queryByText('Paid', { exact: true })).toBeNull();
    expect(screen.queryByText('Paid automatically')).toBeNull();

    // The ledger confirms: the server's next answer says so, and a live event triggers the refetch.
    api.route(
      CYCLE,
      within_mandate({
        summary: summary({ status: 'paid-automatically', approvals: null, flagCount: 0 }),
        proposal: {
          ...within_mandate().proposal!,
          payouts: [
            {
              holder: { partyId: 'holderA::1220c1', displayName: 'Holder A' },
              units: 600,
              sharePct: '100.00',
              amount: '1200.0000000000',
              payment: {
                status: 'paid',
                link: { updateId: 'upd-1', href: '/app/tx/upd-1', external: false },
              },
            },
          ],
        },
      }),
    );
    FakeEventSource.latest.emit({
      type: 'cycle',
      cycleId: '2026-09',
      status: 'paid-automatically',
    });

    await waitFor(() => expect(screen.getAllByText('Paid', { exact: true }).length).toBe(1));
    expect(screen.getByText('Paid automatically')).toBeInTheDocument();
    expect(screen.queryByText('Pending ledger confirmation')).toBeNull();
    expect(screen.getByRole('link', { name: 'View transaction' })).toHaveAttribute(
      'href',
      '/app/tx/upd-1',
    );
  });

  it('keeps the seal ring at the server count while Approve is in flight (U3)', async () => {
    const pending = deferred<CycleDetail>();
    const api = await signIn('approver', {
      [CYCLE]: cycleDetail(),
      'POST /api/proposals/prop-1/approve': () => pending.promise,
    });
    render(Page);

    const ring = await screen.findByRole('img', { name: /^0 of 2 signatures/ });
    expect(ring).toBeInTheDocument();
    expect(screen.getByText('Needs 2 of 3 approvals')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.callsTo('POST /api/proposals/prop-1/approve')).toHaveLength(1));

    // Response is still on its way: nothing local moves the ring.
    expect(screen.getByRole('img', { name: /^0 of 2 signatures/ })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /^1 of 2 signatures/ })).toBeNull();
    expect(
      screen.getByText('Waiting for the ledger to confirm your approval…'),
    ).toBeInTheDocument();

    // The server answers with the ledger's count.
    pending.resolve(
      cycleDetail({
        summary: summary({ approvals: { have: 1, need: 2 } }),
        proposal: proposal({
          approvals: [{ approver: APPROVER_1, at: '2026-10-01T10:00:00Z', note: '' }],
        }),
      }),
    );
    expect(await screen.findByRole('img', { name: /^1 of 2 signatures/ })).toBeInTheDocument();
    expect(toasts.items.map((t) => t.message)).toContain('Approved (1 of 2)');
    // Having approved, this approver gets no second Approve button.
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('sends the optional note with Approve', async () => {
    const api = await signIn('approver', {
      [CYCLE]: cycleDetail(),
      'POST /api/proposals/prop-1/approve': cycleDetail(),
    });
    render(Page);
    await fireEvent.input(await screen.findByLabelText('Note (optional)'), {
      target: { value: 'Holder B checks out' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(api.callsTo('POST /api/proposals/prop-1/approve')[0]?.body).toEqual({
        note: 'Holder B checks out',
      }),
    );
  });

  it('asks for a reason before rejecting and shows what the server answers', async () => {
    const api = await signIn('approver', {
      [CYCLE]: cycleDetail(),
      'POST /api/proposals/prop-1/reject': cycleDetail({
        summary: summary({ status: 'rejected' }),
        outcome: {
          kind: 'rejected',
          actor: APPROVER_1,
          reason: 'Holder B units look wrong',
          at: '2026-10-01T10:00:00Z',
        },
      }),
    });
    render(Page);
    await fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reject this proposal' });
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(within(dialog).getByText('Say briefly why you reject it.')).toBeInTheDocument();
    expect(api.callsTo('POST /api/proposals/prop-1/reject')).toHaveLength(0);

    await fireEvent.input(within(dialog).getByLabelText('Reason'), {
      target: { value: 'Holder B units look wrong' },
    });
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(api.callsTo('POST /api/proposals/prop-1/reject')[0]?.body).toEqual({
        reason: 'Holder B units look wrong',
      }),
    );
    expect(await screen.findByText(/Reason: Holder B units look wrong/)).toBeInTheDocument();
    expect(screen.getByText('No payments were made.', { exact: false })).toBeInTheDocument();
  });

  it('does not offer Approve to someone who is not an approver of this proposal', async () => {
    await signIn('treasurer', { [CYCLE]: cycleDetail() });
    render(Page);
    await screen.findByText('Needs 2 of 3 approvals');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel proposal' })).toBeInTheDocument();
  });

  it('shows the Hold countdown on a clean proposal and calls /hold', async () => {
    const executesAt = new Date(Date.now() + 30_000).toISOString();
    const api = await signIn('treasurer', {
      [CYCLE]: within_mandate({
        summary: summary({ status: 'countdown', approvals: null, flagCount: 0 }),
        countdown: { executesAt, held: false },
      }),
      'POST /api/cycles/2026-09/hold': {},
    });
    render(Page);

    expect(await screen.findByText('Within mandate')).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent(/0:\d\d/);

    api.route(
      CYCLE,
      within_mandate({
        summary: summary({ status: 'held', approvals: null, flagCount: 0 }),
        countdown: { executesAt, held: true },
      }),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Hold' }));
    await waitFor(() => expect(api.callsTo('POST /api/cycles/2026-09/hold')).toHaveLength(1));
    expect(await screen.findByRole('button', { name: 'Release' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel proposal' })).toBeInTheDocument();
  });

  it('lists the checks with actual values and marks advisory flags', async () => {
    await signIn('treasurer', { [CYCLE]: cycleDetail() });
    render(Page);
    expect(
      await screen.findByText('Total 1,200 CC vs 3-cycle average 410 CC, +193%'),
    ).toBeInTheDocument();
    expect(screen.getByText('Limit: Within 50%')).toBeInTheDocument();
    const checks = screen.getByRole('list', { name: 'Checks' });
    const advisory = within(checks).getAllByText('Advisory');
    expect(advisory).toHaveLength(1);
    // The reasons the proposal needs approval are listed.
    expect(screen.getByText('Total is 193% above the 3-cycle average')).toBeInTheDocument();
  });

  it('shows the funds block with the balance and what is required', async () => {
    await signIn('treasurer', {
      [CYCLE]: cycleDetail({
        summary: summary({ status: 'needs-funds' }),
        fundsShortfall: { balance: '100.0000000000', required: '1205.0000000000' },
      }),
    });
    render(Page);
    expect(await screen.findByRole('button', { name: 'Add funds' })).toBeInTheDocument();
    expect(screen.getByText("This cycle can't be paid yet.")).toBeInTheDocument();
  });

  it('patches the timeline from live events as the agent works', async () => {
    await signIn('treasurer', {
      [CYCLE]: cycleDetail({
        summary: summary({ status: 'running' }),
        proposal: null,
        timeline: [
          {
            id: 'woke',
            label: 'Woke up',
            status: 'done',
            detail: null,
            at: '2026-10-01T09:00:00Z',
          },
          { id: 'snapshot', label: 'Snapshot taken', status: 'running', detail: null, at: null },
        ],
      }),
    });
    render(Page);
    await screen.findByText('Snapshot taken');
    expect(
      screen.getByText('The proposal appears here when the agent finishes.'),
    ).toBeInTheDocument();

    FakeEventSource.latest.emit({
      type: 'timeline',
      cycleId: '2026-09',
      step: {
        id: 'snapshot',
        label: 'Snapshot taken',
        status: 'done',
        detail: '4 holders on 2026-09-30',
        at: '2026-10-01T09:00:02Z',
      },
    });
    expect(await screen.findByText('4 holders on 2026-09-30')).toBeInTheDocument();
  });

  it('opens the decision record from the proposal', async () => {
    await signIn('treasurer', {
      [CYCLE]: cycleDetail(),
      'GET /api/decision-records/rec-1': {
        recordId: 'rec-1',
        trigger: 'manual',
        triggerDetail: 'Run cycle now by Treasurer',
        inputFingerprints: [{ label: 'Holder snapshot', sha256: 'ab12cd34' }],
        modelFingerprints: [],
        checks: proposal().checks,
        memo: 'The agent memo.',
        memoSource: 'ai',
        verdict: 'needs-approval',
        mandateVersion: 3,
        cap: '5000',
        createdAt: '2026-10-01T09:00:07Z',
      },
    });
    render(Page);
    await fireEvent.click(await screen.findByRole('button', { name: 'View decision record' }));
    const dialog = await screen.findByRole('dialog', { name: 'Decision record' });
    expect(await within(dialog).findByText('ab12cd34')).toBeInTheDocument();
    expect(within(dialog).getByText(/Version 3/)).toBeInTheDocument();
    // The memo source is in words, not the raw value.
    expect(within(dialog).getByText('Written by the AI reviewer')).toBeInTheDocument();
    expect(within(dialog).queryByText('ai')).toBeNull();
  });

  it.each([
    ['ai', 'Written by the AI reviewer'],
    ['template', 'Written from the checks'],
    ['ai-unavailable', 'AI review unavailable; written from the checks'],
  ])('shows the memo source %s as words on the cycle page', async (memoSource, words) => {
    await signIn('treasurer', { [CYCLE]: cycleDetail({ proposal: proposal({ memoSource }) }) });
    render(Page);
    expect(await screen.findByText(words)).toBeInTheDocument();
    expect(screen.queryByText(memoSource)).toBeNull();
  });

  it('tells an approver what to do when the wallet must sign (MainNet)', async () => {
    const api = await signIn('approver', {
      [CYCLE]: cycleDetail(),
      'POST /api/proposals/prop-1/approve': () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'sign_in_wallet',
              message:
                'On MainNet this is signed in Grofty Wallet. Open the wallet and approve there.',
            },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
    });
    render(Page);
    await fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/signed in Grofty Wallet/)).toBeInTheDocument();
    expect(api.callsTo('POST /api/proposals/prop-1/approve')).toHaveLength(1);
    expect(screen.getByRole('img', { name: /^0 of 2 signatures/ })).toBeInTheDocument();
    void APPROVER_2;
  });
});
