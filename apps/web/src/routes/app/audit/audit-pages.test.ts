import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUDITOR,
  GRANT,
  PREVIEW,
  QUESTION,
  detail,
  grantedView,
  requestView,
  sessionRoutes,
} from '$lib/components/audit/fixtures';
import { live } from '$lib/stores/live.svelte';
import { sessionStore } from '$lib/stores/session.svelte';
import { toasts } from '$lib/stores/toasts.svelte';
import { errorResponse, installFakeEventSource, stubApi } from '../../../test/treasury/stub';
import ListPage from './+page.svelte';
import ReviewPage from './[requestId]/+page.svelte';

vi.mock('$app/state', () => ({
  page: { params: { requestId: 'req-1' }, url: new URL('http://localhost/app/audit/req-1') },
}));

async function stub(routes: Record<string, unknown>): Promise<ReturnType<typeof stubApi>> {
  const api = stubApi({ ...sessionRoutes('treasurer'), ...routes });
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

describe('treasurer audit list', () => {
  it('lists requests with the pending one first and links each to its review page', async () => {
    await stub({
      'GET /api/audit/requests': {
        requests: [
          grantedView({ requestId: 'req-old', question: 'Older granted question' }),
          requestView({
            requestId: 'req-new',
            question: 'Newer pending question',
            requestedAt: '2026-10-02T09:00:00Z',
          }),
        ],
      },
    });
    render(ListPage);

    const table = await screen.findByRole('table', { name: 'Audit requests' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Newer pending question');
    expect(rows[0]).toHaveTextContent('Waiting for the treasurer');
    expect(rows[0]).toHaveTextContent(AUDITOR.displayName);
    expect(rows[1]).toHaveTextContent('Older granted question');
    expect(rows[1]).toHaveTextContent('Active until Oct 8');
    expect(within(rows[0]!).getByRole('link', { name: 'Newer pending question' })).toHaveAttribute(
      'href',
      '/app/audit/req-new',
    );
    // The treasurer's list names the auditor but never prints a party id.
    expect(document.body.innerHTML).not.toContain(AUDITOR.partyId);
  });

  it('shows the empty state', async () => {
    await stub({ 'GET /api/audit/requests': { requests: [] } });
    render(ListPage);
    expect(await screen.findByText(/No audit requests yet\./)).toBeInTheDocument();
  });

  it('shows what failed with a retry', async () => {
    await stub({
      'GET /api/audit/requests': () => errorResponse(500, 'internal', 'The ledger is busy.'),
    });
    render(ListPage);
    expect(await screen.findByRole('alert')).toHaveTextContent('The ledger is busy.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('treasurer review page', () => {
  it('shows the auditor question beside the exact records that would be shared', async () => {
    await stub({ 'GET /api/audit/requests/req-1': detail(requestView()) });
    render(ReviewPage);

    const question = await screen.findByRole('region', { name: "Auditor's question" });
    const records = screen.getByRole('region', { name: 'Records that would be shared' });
    expect(question).toHaveTextContent(QUESTION);
    expect(question).toHaveTextContent('Holder identities are shown as Holder A to D');
    const items = within(records).getAllByRole('listitem');
    expect(items).toHaveLength(PREVIEW.length);
    expect(items[0]).toHaveTextContent('Decision record, July 2026');
    expect(items[0]).toHaveTextContent('1,200 CC to 4 holders, within mandate');
    // A record that is no longer on the ledger cannot be shared.
    expect(items[2]).toHaveTextContent('No longer on the ledger');
    expect(within(items[2]!).getByRole('checkbox')).toBeDisabled();
    // The seal is open: nothing has been granted yet.
    expect(screen.getByRole('img', { name: /0 of 1 signature/ })).toBeInTheDocument();
  });

  it('grants with the chosen expiry and the chosen subset, and closes the seal from the response', async () => {
    const api = await stub({ 'GET /api/audit/requests/req-1': detail(requestView()) });
    api.route(
      'POST /api/audit/requests/req-1/grant',
      detail(
        grantedView({
          grant: { ...GRANT, recordIds: ['rec-2026-07'], expiresAt: '2026-10-31T10:00:00Z' },
        }),
      ),
    );
    render(ReviewPage);
    await screen.findByRole('region', { name: "Auditor's question" });

    await fireEvent.click(screen.getByRole('checkbox', { name: /Decision record, August 2026/ }));
    await fireEvent.click(screen.getByRole('radio', { name: '30 days' }));
    expect(screen.getByRole('radio', { name: '7 days' })).not.toBeChecked();
    await fireEvent.click(screen.getByRole('button', { name: 'Grant access' }));

    await waitFor(() =>
      expect(api.callsTo('POST /api/audit/requests/req-1/grant')).toHaveLength(1),
    );
    expect(api.callsTo('POST /api/audit/requests/req-1/grant')[0]?.body).toEqual({
      expiresIn: '30d',
      recordIds: ['rec-2026-07'],
    });
    await waitFor(() =>
      expect(toasts.items.map((t) => t.message)).toContain('Access granted until Oct 31'),
    );
    expect(
      await screen.findByRole('heading', { name: 'Access granted until Oct 31' }),
    ).toBeInTheDocument();
    // Closed from the server response: one of one signature, sealed.
    expect(
      screen.getByRole('img', { name: /1 of 1 signature, sealed\. Access granted until Oct 31/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'End access now' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Grant access' })).not.toBeInTheDocument();
  });

  it('does not offer Grant access while no record is selected', async () => {
    await stub({ 'GET /api/audit/requests/req-1': detail(requestView()) });
    render(ReviewPage);
    await screen.findByRole('region', { name: "Auditor's question" });
    await fireEvent.click(screen.getByRole('checkbox', { name: /Decision record, July 2026/ }));
    await fireEvent.click(screen.getByRole('checkbox', { name: /Decision record, August 2026/ }));
    expect(screen.getByRole('button', { name: 'Grant access' })).toBeDisabled();
  });

  it('shows the ledger message in place when granting fails', async () => {
    await stub({
      'GET /api/audit/requests/req-1': detail(requestView()),
      'POST /api/audit/requests/req-1/grant': () =>
        errorResponse(422, 'ledger_rejected', 'The ledger refused the grant. Try again.'),
    });
    render(ReviewPage);
    await screen.findByRole('region', { name: "Auditor's question" });
    await fireEvent.click(screen.getByRole('button', { name: 'Grant access' }));
    expect(await screen.findByText('The ledger refused the grant. Try again.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Grant access' })).toBeEnabled();
  });

  it('requires a reason to deny, then sends it and says "Request denied"', async () => {
    const api = await stub({
      'GET /api/audit/requests/req-1': detail(requestView()),
      'POST /api/audit/requests/req-1/deny': detail(
        requestView({
          status: 'denied',
          denial: { reason: 'Too broad for this quarter.', at: '2026-10-02T09:00:00Z' },
        }),
        null,
      ),
    });
    render(ReviewPage);
    await screen.findByRole('region', { name: "Auditor's question" });

    await fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    const dialog = await screen.findByRole('dialog', { name: 'Deny this request' });
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Deny' }));
    expect(await within(dialog).findByText('Give the auditor a reason.')).toBeInTheDocument();
    expect(api.callsTo('POST /api/audit/requests/req-1/deny')).toHaveLength(0);

    await fireEvent.input(within(dialog).getByLabelText('Reason'), {
      target: { value: 'Too broad for this quarter.' },
    });
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Deny' }));

    await waitFor(() => expect(api.callsTo('POST /api/audit/requests/req-1/deny')).toHaveLength(1));
    expect(api.callsTo('POST /api/audit/requests/req-1/deny')[0]?.body).toEqual({
      reason: 'Too broad for this quarter.',
    });
    await waitFor(() => expect(toasts.items.map((t) => t.message)).toContain('Request denied'));
    expect(await screen.findByRole('heading', { name: 'Request denied' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the expiry ring for an active grant and ends access after confirming', async () => {
    const api = await stub({
      'GET /api/audit/requests/req-1': detail(grantedView()),
      'POST /api/audit/grants/grant-1/revoke': detail(
        grantedView({
          status: 'ended',
          grant: { ...GRANT, closedAt: '2026-10-03T08:00:00Z', closedReason: 'revoked' },
        }),
      ),
    });
    render(ReviewPage);

    expect(
      await screen.findByRole('heading', { name: 'Access granted until Oct 8' }),
    ).toBeInTheDocument();
    const ring = screen.getByRole('img', {
      name: /Access granted until Oct 8\. \d+ percent of the access period remains\./,
    });
    expect(ring.closest('figure')).toHaveAttribute('data-state', 'expiring');
    // Only the records the grant covers are listed.
    const shared = screen.getByRole('list', { name: 'Records shared' });
    expect(within(shared).getAllByRole('listitem')).toHaveLength(2);

    await fireEvent.click(screen.getByRole('button', { name: 'End access now' }));
    const dialog = await screen.findByRole('dialog', { name: 'End access now?' });
    await fireEvent.click(within(dialog).getByRole('button', { name: 'End access now' }));

    await waitFor(() =>
      expect(api.callsTo('POST /api/audit/grants/grant-1/revoke')).toHaveLength(1),
    );
    expect(await screen.findByRole('heading', { name: 'Access ended Oct 3' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'End access now' })).not.toBeInTheDocument();
  });

  it('shows "Access ended {date}" for an expired grant', async () => {
    await stub({
      'GET /api/audit/requests/req-1': detail(
        grantedView({
          status: 'ended',
          grant: { ...GRANT, closedAt: '2026-10-08T10:00:00Z', closedReason: 'expired' },
        }),
      ),
    });
    render(ReviewPage);
    expect(await screen.findByRole('heading', { name: 'Access ended Oct 8' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Grant access' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'End access now' })).not.toBeInTheDocument();
  });

  it('shows what failed with a retry when the request cannot load', async () => {
    await stub({
      'GET /api/audit/requests/req-1': () => errorResponse(404, 'not_found', 'No such request.'),
    });
    render(ReviewPage);
    expect(await screen.findByRole('alert')).toHaveTextContent('No such request.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
