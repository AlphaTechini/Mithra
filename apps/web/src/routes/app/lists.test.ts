import { render, screen, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { live } from '$lib/stores/live.svelte';
import { sessionStore } from '$lib/stores/session.svelte';
import {
  HOLDER_A,
  HOLDER_B,
  activity,
  holderRow,
  sessionRoutes,
  summary,
} from '../../test/treasury/fixtures';
import { FakeEventSource, installFakeEventSource, stubApi } from '../../test/treasury/stub';
import ActivityPage from './activity/+page.svelte';
import CyclesPage from './cycles/+page.svelte';
import HoldersPage from './holders/+page.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn(() => Promise.resolve()) }));

beforeEach(() => {
  sessionStore.reset();
  live.reset();
  installFakeEventSource();
});

afterEach(() => {
  live.reset();
  vi.unstubAllGlobals();
});

describe('MainNet wallets in the holders table', () => {
  it("shows each holder's Grofty wallet status on MainNet only", async () => {
    const routes = {
      'GET /api/holders': {
        totalUnits: 1000,
        holders: [
          holderRow({ mainnetWallet: { partyId: 'a-main::1220aabbccddeeff' } }),
          holderRow({ holder: HOLDER_B, units: 400, sharePct: '40.00', mainnetWallet: null }),
        ],
      },
    };
    stubApi({ ...sessionRoutes('treasurer', 'mainnet'), ...routes });
    await sessionStore.load();
    const mainnet = render(HoldersPage);
    expect(await screen.findByRole('columnheader', { name: 'MainNet wallet' })).toBeInTheDocument();
    const rows = await screen.findAllByRole('row');
    const a = rows.find((r) => within(r).queryByText('Holder A'));
    const b = rows.find((r) => within(r).queryByText('Holder B'));
    expect(within(a!).getByText('Confirmed')).toBeInTheDocument();
    expect(within(a!).getByTitle('a-main::1220aabbccddeeff')).toBeInTheDocument();
    expect(within(b!).getByText('Not connected to Grofty yet')).toBeInTheDocument();
    mainnet.unmount();

    sessionStore.reset();
    stubApi({ ...sessionRoutes('treasurer'), ...routes });
    await sessionStore.load();
    render(HoldersPage);
    await screen.findAllByRole('row');
    expect(screen.queryByRole('columnheader', { name: 'MainNet wallet' })).toBeNull();
  });
});

describe('Seeded tags (U8)', () => {
  it('tags seeded holders and only those', async () => {
    stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/holders': {
        totalUnits: 1000,
        holders: [
          holderRow({ seeded: true }),
          holderRow({
            holder: HOLDER_B,
            units: 400,
            sharePct: '40.00',
            seeded: false,
            autoReceive: false,
          }),
        ],
      },
    });
    await sessionStore.load();
    render(HoldersPage);
    const rows = await screen.findAllByRole('row');
    const a = rows.find((r) => within(r).queryByText('Holder A'));
    const b = rows.find((r) => within(r).queryByText('Holder B'));
    expect(within(a!).getByText('Seeded')).toBeInTheDocument();
    expect(within(b!).queryByText('Seeded')).toBeNull();
  });

  it('tags seeded cycles', async () => {
    stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/cycles': {
        cycles: [
          summary({
            cycleId: '2026-08',
            label: 'August 2026',
            status: 'paid-automatically',
            approvals: null,
            seeded: true,
          }),
          summary({ cycleId: '2026-09', label: 'September 2026', seeded: false }),
        ],
      },
    });
    await sessionStore.load();
    render(CyclesPage);
    const rows = await screen.findAllByRole('row');
    const august = rows.find((r) => within(r).queryByText('August 2026'));
    const september = rows.find((r) => within(r).queryByText('September 2026'));
    expect(within(august!).getByText('Seeded')).toBeInTheDocument();
    expect(within(september!).queryByText('Seeded')).toBeNull();
    expect(within(september!).getByText('Awaiting approval 0 of 2')).toBeInTheDocument();
    expect(within(september!).getByRole('link', { name: 'September 2026' })).toHaveAttribute(
      'href',
      '/app/cycles/2026-09',
    );
  });

  it('tags seeded activity entries, and adds live entries on top', async () => {
    stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/activity': {
        entries: [
          activity({
            id: 'a1',
            text: 'Seeded cycle paid',
            seeded: true,
            link: '/app/cycles/2026-08',
          }),
          activity({ id: 'a2', text: 'Real cycle proposed', seeded: false }),
        ],
      },
    });
    await sessionStore.load();
    render(ActivityPage);
    const log = await screen.findByRole('list', { name: 'Activity log' });
    const items = within(log).getAllByRole('listitem');
    expect(within(items[0]!).getByText('Seeded')).toBeInTheDocument();
    expect(within(items[0]!).getByRole('link', { name: 'View' })).toHaveAttribute(
      'href',
      '/app/cycles/2026-08',
    );
    expect(within(items[1]!).queryByText('Seeded')).toBeNull();

    FakeEventSource.latest.emit({
      type: 'activity',
      entry: activity({ id: 'a3', text: 'Approver 1 approved September 2026 (1 of 2)' }),
    });
    const after = within(await screen.findByRole('list', { name: 'Activity log' })).getAllByRole(
      'listitem',
    );
    expect(after).toHaveLength(3);
    expect(within(after[0]!).getByText(/Approver 1 approved/)).toBeInTheDocument();
  });
});

describe('Holders page', () => {
  it('warns about holders without auto-receive', async () => {
    stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/holders': {
        totalUnits: 1000,
        holders: [holderRow({ holder: HOLDER_A, autoReceive: false })],
      },
    });
    await sessionStore.load();
    render(HoldersPage);
    expect(
      await screen.findByText('Payments to this holder will wait for them to accept.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Auto-receive off')).toBeInTheDocument();
  });

  it('shows the empty state with its one action', async () => {
    stubApi({ ...sessionRoutes('treasurer'), 'GET /api/holders': { totalUnits: 0, holders: [] } });
    await sessionStore.load();
    render(HoldersPage);
    expect(
      await screen.findByText(
        'No holders yet. Issue units to your first holder to start paying yield.',
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Issue units' }).length).toBeGreaterThan(0);
  });
});
