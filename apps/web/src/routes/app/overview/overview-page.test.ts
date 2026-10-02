import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { live } from '$lib/stores/live.svelte';
import { sessionStore } from '$lib/stores/session.svelte';
import { toasts } from '$lib/stores/toasts.svelte';
import {
  activity,
  mandate,
  overview,
  sessionRoutes,
  summary,
} from '../../../test/treasury/fixtures';
import { stubApi } from '../../../test/treasury/stub';
import Page from './+page.svelte';

const goto = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('$app/navigation', () => ({ goto }));

beforeEach(() => {
  sessionStore.reset();
  live.reset();
  toasts.clear();
  goto.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('overview page', () => {
  it('shows "Add funds" when the server reports a funds warning, and adds funds on LocalNet', async () => {
    const api = stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/overview': overview({
        balance: '100.0000000000',
        fundsWarning: { balance: '100.0000000000', required: '1205.0000000000' },
      }),
      'POST /api/treasury/fund': { balance: '1305.0000000000' },
    });
    await sessionStore.load();
    render(Page);

    const warning = await screen.findByRole('alert', { name: 'Low balance' });
    expect(within(warning).getByText('The treasury balance is too low.')).toBeInTheDocument();
    await fireEvent.click(within(warning).getByRole('button', { name: 'Add funds' }));

    const dialog = await screen.findByRole('dialog', { name: 'Add funds' });
    // The suggested amount is the server's required figure.
    expect(within(dialog).getByLabelText('Amount (CC)')).toHaveValue('1205.0000000000');
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Add funds' }));
    await waitFor(() => expect(api.callsTo('POST /api/treasury/fund')).toHaveLength(1));
    expect(api.callsTo('POST /api/treasury/fund')[0]?.body).toEqual({ amount: '1205.0000000000' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The overview is reloaded from the server afterwards.
    await waitFor(() => expect(api.callsTo('GET /api/overview').length).toBeGreaterThan(1));
  });

  it('does not show the warning when the server sends none', async () => {
    stubApi({ ...sessionRoutes('treasurer'), 'GET /api/overview': overview() });
    await sessionStore.load();
    render(Page);
    await screen.findByText('Treasury balance');
    expect(screen.queryByRole('button', { name: 'Add funds' })).toBeNull();
  });

  it('explains how to add funds on MainNet: send CC to the Grofty Wallet, no faucet', async () => {
    stubApi({
      ...sessionRoutes('treasurer', 'mainnet'),
      'GET /api/overview': overview({
        balance: null,
        fundsWarning: null,
      }),
    });
    await sessionStore.load();
    render(Page);
    // The server cannot read the balance: it is in the treasurer's Grofty Wallet.
    expect(await screen.findByText(/your CC is in your Grofty Wallet/)).toBeInTheDocument();
    await fireEvent.click(await screen.findByRole('button', { name: 'Add funds' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add funds' });
    expect(
      within(dialog).getByText('Send CC to your Grofty Wallet; payouts are signed from it.'),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Add funds' })).toBeNull();
    expect(within(dialog).queryByLabelText(/Amount/)).toBeNull();
  });

  it('shows balance, mandate, recent cycles with chips and the Seeded tag', async () => {
    stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/overview': overview({
        recentCycles: [
          summary({
            cycleId: '2026-09',
            label: 'September 2026',
            status: 'paid-automatically',
            approvals: null,
            seeded: true,
          }),
          summary({
            cycleId: '2026-10',
            label: 'October 2026',
            status: 'awaiting-approval',
            approvals: { have: 1, need: 2 },
          }),
          summary({ cycleId: '2026-08', label: 'August 2026', status: 'rejected' }),
          summary({ cycleId: '2026-07', label: 'July 2026', status: 'paid-after-approval' }),
        ],
        recentActivity: [activity({ seeded: true })],
      }),
    });
    await sessionStore.load();
    render(Page);

    expect(await screen.findByText('Paid automatically')).toBeInTheDocument();
    expect(screen.getByText('Awaiting approval 1 of 2')).toBeInTheDocument();
    expect(screen.getByText('Rejected')).toBeInTheDocument();
    expect(screen.getByText('Paid after approval')).toBeInTheDocument();
    expect(screen.getAllByText('Seeded')).toHaveLength(2);
    expect(screen.getByText('10,000.00')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /sealed/i })).toBeInTheDocument();
  });

  it('opens Run cycle now with the previous month, and goes to the new cycle', async () => {
    const api = stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/overview': overview({
        mandate: mandate({ terms: { ...mandate().terms, fixedAmount: '1200' } }),
      }),
      'POST /api/cycles/run': { cycleId: '2026-09' },
    });
    await sessionStore.load();
    render(Page);
    await fireEvent.click(await screen.findByRole('button', { name: 'Run cycle now' }));
    const dialog = await screen.findByRole('dialog', { name: 'Run cycle now' });
    expect(within(dialog).getByLabelText<HTMLInputElement>('Period').value).toMatch(
      /^\d{4}-\d{2}$/,
    );
    // The total defaults to the mandate's fixed amount; the record date rule is shown.
    expect(within(dialog).getByLabelText('Total (CC)')).toHaveValue('1200');
    expect(within(dialog).getByText(/last day of the previous month/)).toBeInTheDocument();

    await fireEvent.input(within(dialog).getByLabelText('Period'), {
      target: { value: '2026-09' },
    });
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Run cycle now' }));
    await waitFor(() => expect(api.callsTo('POST /api/cycles/run')).toHaveLength(1));
    expect(api.callsTo('POST /api/cycles/run')[0]?.body).toEqual({
      cycleId: '2026-09',
      total: '1200',
    });
    await waitFor(() =>
      expect(goto).toHaveBeenCalledWith('/app/cycles/2026-09', expect.anything()),
    );
    expect(toasts.items.map((t) => t.message)).toContain('Cycle started');
  });

  it('shows an empty state with the next action before a mandate exists', async () => {
    stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/overview': overview({
        mandate: null,
        balance: null,
        nextCycle: null,
        recentCycles: [],
        recentActivity: [],
      }),
    });
    await sessionStore.load();
    render(Page);
    expect(await screen.findByRole('link', { name: 'Set up a treasury' })).toHaveAttribute(
      'href',
      '/setup/organization',
    );
    expect(screen.queryByRole('button', { name: 'Run cycle now' })).toBeNull();
  });

  it('shows what failed and offers a retry when the overview cannot load', async () => {
    stubApi({ ...sessionRoutes('treasurer') });
    await sessionStore.load();
    render(Page);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load the overview.");
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
