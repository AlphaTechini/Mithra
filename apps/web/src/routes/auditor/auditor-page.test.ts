import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUDITOR,
  DRAFT,
  HOLDER_IDS,
  QUESTION,
  detail,
  evidenceRoom,
  evidenceWithLeaks,
  sessionRoutes,
  grantedView,
  requestView,
} from '$lib/components/audit/fixtures';
import { live } from '$lib/stores/live.svelte';
import { sessionStore } from '$lib/stores/session.svelte';
import { toasts } from '$lib/stores/toasts.svelte';
import {
  FakeEventSource,
  errorResponse,
  installFakeEventSource,
  stubApi,
} from '../../test/treasury/stub';
import Page from './+page.svelte';

/** Stubs the API as a signed-in auditor; the session is loaded so live events can connect. */
async function stub(routes: Record<string, unknown>): Promise<ReturnType<typeof stubApi>> {
  const api = stubApi({ ...sessionRoutes('auditor'), ...routes });
  await sessionStore.load();
  return api;
}

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

async function openNewRequest(): Promise<void> {
  await fireEvent.click(await screen.findByRole('button', { name: 'New request' }));
}

describe('auditor workspace: new request', () => {
  it('proposes a scope with a reason per record and the excluded sentence', async () => {
    const api = await stub({
      'GET /api/audit/requests': { requests: [] },
      'POST /api/audit/scope/draft': DRAFT,
    });
    render(Page);
    await openNewRequest();

    await fireEvent.input(screen.getByLabelText('What do you need to see?'), {
      target: { value: QUESTION },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Propose scope' }));

    const list = await screen.findByRole('list', { name: 'Proposed records' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Decision record, July 2026');
    expect(within(items[0]!).getByLabelText('Reason for Decision record, July 2026')).toHaveValue(
      'Q3 distribution for July.',
    );
    expect(items[2]).toHaveTextContent('Outcome, September 2026');
    expect(screen.getByText(DRAFT.excluded)).toBeInTheDocument();
    expect(api.callsTo('POST /api/audit/scope/draft')[0]?.body).toEqual({ question: QUESTION });
  });

  it('shows the rules notice when the model was unavailable', async () => {
    await stub({
      'GET /api/audit/requests': { requests: [] },
      'POST /api/audit/scope/draft': {
        ...DRAFT,
        source: 'rules',
        notice: 'The agent could not use its language model, so the rules drafted this scope.',
      },
    });
    render(Page);
    await openNewRequest();
    await fireEvent.click(screen.getByRole('button', { name: 'Use the example' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Propose scope' }));
    expect(await screen.findByRole('status')).toHaveTextContent('the rules drafted this scope');
  });

  it('drops an unticked record and an edited reason from the request body, then says "Request sent"', async () => {
    const created = detail(requestView(), null);
    const api = await stub({
      'GET /api/audit/requests': { requests: [] },
      'POST /api/audit/scope/draft': DRAFT,
      'POST /api/audit/requests': created,
    });
    render(Page);
    await openNewRequest();
    await fireEvent.input(screen.getByLabelText('What do you need to see?'), {
      target: { value: QUESTION },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Propose scope' }));
    await screen.findByRole('list', { name: 'Proposed records' });

    await fireEvent.click(screen.getByRole('checkbox', { name: /Decision record, August 2026/ }));
    await fireEvent.input(screen.getByLabelText('Reason for Decision record, July 2026'), {
      target: { value: 'Needed for the Q3 sample.' },
    });
    expect(screen.getByText('2 of 3 records included.')).toBeInTheDocument();

    api.route('GET /api/audit/requests', { requests: [requestView()] });
    await fireEvent.click(screen.getByRole('button', { name: 'Request access' }));

    await waitFor(() => expect(api.callsTo('POST /api/audit/requests')).toHaveLength(1));
    expect(api.callsTo('POST /api/audit/requests')[0]?.body).toEqual({
      question: QUESTION,
      items: [
        { recordId: 'rec-2026-07', kind: 'decision', reason: 'Needed for the Q3 sample.' },
        { recordId: 'out-2026-09', kind: 'outcome', reason: 'Flagged: the approvals behind it.' },
      ],
      excluded: DRAFT.excluded,
    });
    await waitFor(() => expect(toasts.items.map((t) => t.message)).toContain('Request sent'));
    // The new request opens with its status.
    expect((await screen.findAllByText('Waiting for the treasurer')).length).toBeGreaterThan(0);
    expect(screen.getByText('Request sent', { selector: 'strong' })).toBeInTheDocument();
  });

  it('asks for a fresh proposal when the question changes after proposing', async () => {
    await stub({
      'GET /api/audit/requests': { requests: [] },
      'POST /api/audit/scope/draft': DRAFT,
    });
    render(Page);
    await openNewRequest();
    const box = screen.getByLabelText('What do you need to see?');
    await fireEvent.input(box, { target: { value: QUESTION } });
    await fireEvent.click(screen.getByRole('button', { name: 'Propose scope' }));
    await screen.findByRole('list', { name: 'Proposed records' });
    expect(screen.getByRole('button', { name: 'Request access' })).toBeEnabled();

    await fireEvent.input(box, { target: { value: `${QUESTION} Only September.` } });
    expect(screen.getByRole('button', { name: 'Request access' })).toBeDisabled();
    expect(screen.getByText(/Propose scope again to update the records/)).toBeInTheDocument();
  });

  it('shows the ledger message in place when the request fails', async () => {
    await stub({
      'GET /api/audit/requests': { requests: [] },
      'POST /api/audit/scope/draft': DRAFT,
      'POST /api/audit/requests': () =>
        errorResponse(422, 'ledger_rejected', 'The ledger refused the request. Try again.'),
    });
    render(Page);
    await openNewRequest();
    await fireEvent.input(screen.getByLabelText('What do you need to see?'), {
      target: { value: QUESTION },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Propose scope' }));
    await screen.findByRole('list', { name: 'Proposed records' });
    await fireEvent.click(screen.getByRole('button', { name: 'Request access' }));
    expect(await screen.findByText('The ledger refused the request. Try again.')).toBeVisible();
  });
});

describe('auditor workspace: requests and evidence room', () => {
  it('lists requests with status chips and the empty state when there are none', async () => {
    await stub({ 'GET /api/audit/requests': { requests: [] } });
    const first = render(Page);
    expect(await screen.findByText(/No requests yet/)).toBeInTheDocument();
    first.unmount();

    await stub({
      'GET /api/audit/requests': {
        requests: [
          requestView(),
          requestView({
            requestId: 'req-2',
            question: 'Second question',
            status: 'denied',
            denial: { reason: 'Too broad.', at: '2026-10-02T09:00:00Z' },
          }),
        ],
      },
    });
    render(Page);
    const list = await screen.findByRole('list', { name: 'Your requests' });
    expect(within(list).getByText('Waiting for the treasurer')).toBeInTheDocument();
    expect(within(list).getByText('Request denied')).toBeInTheDocument();
  });

  it('renders the evidence room with holder labels only and no party ids anywhere (L8)', async () => {
    await stub({
      'GET /api/audit/requests': { requests: [grantedView()] },
      'GET /api/audit/grants/grant-1/evidence': evidenceWithLeaks(),
    });
    const { container } = render(Page);
    await fireEvent.click(await screen.findByRole('button', { name: /Show all Q3/ }));

    const room = await screen.findByRole('region', { name: 'Evidence room' });
    expect(within(room).getAllByText('Holder A').length).toBeGreaterThan(0);
    expect(within(room).getAllByText('Holder B').length).toBeGreaterThan(0);
    expect(within(room).getByText('Approver 1')).toBeInTheDocument();
    expect(within(room).getByText(/August is 4 percent over/)).toBeInTheDocument();
    expect(within(room).getByText(/Actual 1,300 CC, limit 1,250 CC/)).toBeInTheDocument();
    expect(within(room).getByText(/Version 2, cap/)).toBeInTheDocument();
    expect(within(room).getByRole('link', { name: /View transaction, Holder A/ })).toHaveAttribute(
      'href',
      '/app/tx/upd-1',
    );
    // Read-only: nothing to type into or toggle inside the room.
    expect(within(room).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(room).queryAllByRole('checkbox')).toHaveLength(0);

    const html = container.ownerDocument.body.innerHTML;
    for (const id of [...HOLDER_IDS, AUDITOR.partyId]) expect(html).not.toContain(id);
    expect(html).not.toContain('holderA::');
    expect(html).not.toContain('1220');
  });

  it('says what a payment status means in words, never the raw status name', async () => {
    const room = evidenceWithLeaks() as ReturnType<typeof evidenceRoom>;
    const record = room.records.find((r) => r.outcome);
    if (!record?.outcome) throw new Error('the fixture has an outcome');
    const payment = record.outcome.payments[0];
    if (!payment) throw new Error('the fixture has a payment');
    record.outcome.payments = [
      { ...payment, holderLabel: 'Holder A', status: 'paid' },
      { ...payment, holderLabel: 'Holder B', status: 'awaiting-acceptance', link: null },
      { ...payment, holderLabel: 'Holder C', status: 'awaiting-signature', link: null },
    ];
    await stub({
      'GET /api/audit/requests': { requests: [grantedView()] },
      'GET /api/audit/grants/grant-1/evidence': room,
    });
    render(Page);
    await fireEvent.click(await screen.findByRole('button', { name: /Show all Q3/ }));
    const table = await screen.findByRole('table', { name: /^Payments, / });
    const status = (label: string) =>
      within(within(table).getByRole('row', { name: new RegExp(`^${label} `) })).getByText(
        /Paid|Awaiting/,
      ).textContent;
    expect(status('Holder A')).toBe('Paid');
    expect(status('Holder B')).toBe('Awaiting acceptance');
    expect(status('Holder C')).toContain('Awaiting signature in Grofty');
    expect(table.textContent).not.toMatch(/awaiting-acceptance|awaiting-signature/);
  });

  it('shows the grant ring in the expiring state with the right label, and the export link', async () => {
    await stub({
      'GET /api/audit/requests': { requests: [grantedView()] },
      'GET /api/audit/grants/grant-1/evidence': evidenceWithLeaks(),
    });
    render(Page);
    await fireEvent.click(await screen.findByRole('button', { name: /Show all Q3/ }));
    await screen.findByRole('region', { name: 'Evidence room' });

    const room = screen.getByRole('region', { name: 'Evidence room' });
    const ring = within(room).getByRole('img', {
      name: /Access until .*\. \d+ percent of the access period remains\./,
    });
    expect(ring.closest('figure')).toHaveAttribute('data-state', 'expiring');
    const exportLink = within(room).getByRole('link', { name: /Export summary/ });
    expect(exportLink).toHaveAttribute('href', '/api/audit/grants/grant-1/export');
    expect(exportLink).toHaveAttribute('download');
  });

  it('answers 410 with "Access ended" and removes the records, without the scheduled expiry as a date', async () => {
    const api = await stub({
      'GET /api/audit/requests': { requests: [grantedView()] },
      'GET /api/audit/grants/grant-1/evidence': () =>
        errorResponse(410, 'access_ended', 'This access grant has ended.'),
    });
    render(Page);
    await fireEvent.click(await screen.findByRole('button', { name: /Show all Q3/ }));

    // The request is still marked granted, with an expiry of Oct 8: it ended early, so that date
    // is not shown as when access ended.
    expect(await screen.findByText('Access ended')).toBeInTheDocument();
    expect(screen.queryByText(/Access ended Oct/)).toBeNull();
    expect(screen.getByText('This access grant has ended.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Evidence room' })).not.toBeInTheDocument();
    expect(screen.queryByText('Holder A')).not.toBeInTheDocument();
    // The list is reloaded so the status catches up with the server.
    await waitFor(() => expect(api.callsTo('GET /api/audit/requests').length).toBeGreaterThan(1));
  });

  it('shows the date once the server supplies closedAt for a request ended early', async () => {
    let revoked = false;
    await stub({
      'GET /api/audit/requests': () => ({
        requests: [
          revoked
            ? grantedView({
                status: 'ended',
                grant: {
                  ...grantedView().grant!,
                  closedAt: '2026-10-03T08:00:00Z',
                  closedReason: 'revoked',
                },
              })
            : grantedView(),
        ],
      }),
      'GET /api/audit/grants/grant-1/evidence': () => {
        revoked = true;
        return errorResponse(410, 'access_ended', 'This access grant has ended.');
      },
    });
    render(Page);
    await fireEvent.click(await screen.findByRole('button', { name: /Show all Q3/ }));
    expect((await screen.findAllByText('Access ended Oct 3')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Access ended Oct 8/)).toBeNull();
  });

  it('refetches the evidence room when an audit event arrives and drops the records on 410', async () => {
    let ended = false;
    await stub({
      'GET /api/audit/requests': { requests: [grantedView()] },
      'GET /api/audit/grants/grant-1/evidence': () =>
        ended
          ? errorResponse(410, 'access_ended', 'This access grant has ended.')
          : evidenceWithLeaks(),
    });
    render(Page);
    await fireEvent.click(await screen.findByRole('button', { name: /Show all Q3/ }));
    await screen.findByRole('region', { name: 'Evidence room' });

    ended = true;
    FakeEventSource.latest.open();
    FakeEventSource.latest.emit({ type: 'audit', requestId: 'req-1' });
    expect(await screen.findByText(/Access ended/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Evidence room' })).not.toBeInTheDocument();
  });

  it('shows "Access ended {date}" for an ended request without fetching records', async () => {
    const api = await stub({
      'GET /api/audit/requests': {
        requests: [
          grantedView({
            status: 'ended',
            grant: {
              ...grantedView().grant!,
              closedAt: '2026-10-08T10:00:00Z',
              closedReason: 'expired',
            },
          }),
        ],
      },
    });
    render(Page);
    await fireEvent.click(await screen.findByRole('button', { name: /Show all Q3/ }));
    expect((await screen.findAllByText('Access ended Oct 8')).length).toBeGreaterThan(0);
    expect(api.callsTo('GET /api/audit/grants/grant-1/evidence')).toHaveLength(0);
  });

  it('withdraws a pending request', async () => {
    const api = await stub({
      'GET /api/audit/requests': { requests: [requestView()] },
      'POST /api/audit/requests/req-1/withdraw': detail(requestView({ status: 'withdrawn' }), null),
    });
    render(Page);
    await fireEvent.click(await screen.findByRole('button', { name: /Show all Q3/ }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Withdraw request' }));
    await waitFor(() =>
      expect(api.callsTo('POST /api/audit/requests/req-1/withdraw')).toHaveLength(1),
    );
  });

  it('shows what failed with a retry when the list cannot load', async () => {
    await stub({
      'GET /api/audit/requests': () => errorResponse(500, 'internal', 'The ledger is busy.'),
    });
    render(Page);
    expect(await screen.findByRole('alert')).toHaveTextContent('The ledger is busy.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
