import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callsTo,
  configFor,
  holderSession,
  json,
  position,
  stubApi,
} from '$lib/components/holder/fixtures';
import { sessionStore } from '$lib/stores/session.svelte';
import { toasts } from '$lib/stores/toasts.svelte';
import Page from './+page.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn(() => Promise.resolve()) }));

const tranche = { unitId: 'unit-1', units: 2500, effectiveDate: '2026-09-15' };

async function signIn(network: 'localnet' | 'mainnet'): Promise<void> {
  sessionStore.reset();
  stubApi({
    'GET /api/session': holderSession(network),
    'GET /api/config/public': configFor(network),
  });
  await sessionStore.load();
}

beforeEach(() => {
  toasts.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('holder welcome', () => {
  it('walks accept units, then auto-receive, then home', async () => {
    sessionStore.reset();
    let current = position({ units: 0, autoReceive: false, pendingUnits: [tranche] });
    const fetchMock = stubApi({
      'GET /api/session': holderSession(),
      'GET /api/config/public': configFor(),
      'GET /api/me/position': () => json(current),
      'POST /api/me/units/unit-1/accept': () => {
        current = position({ units: 2500, autoReceive: false, pendingUnits: [] });
        return json(current);
      },
      'POST /api/me/auto-receive': () => {
        current = position({ units: 2500, autoReceive: true, pendingUnits: [] });
        return json(current);
      },
    });
    await sessionStore.load();
    render(Page);

    // Step 1: the tranche, its units and effective date.
    expect(await screen.findByText('2,500 units')).toBeInTheDocument();
    expect(screen.getByText('effective Sep 15')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn on auto-receive' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Go to my home' })).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: /Accept units/ }));
    await waitFor(() => expect(callsTo(fetchMock, 'POST /api/me/units/unit-1/accept')).toBe(1));

    // Step 2: the auto-receive prompt appears once the units are accepted.
    expect(
      await screen.findByText(
        'Turn on auto-receive so yield arrives without you having to accept each payment.',
      ),
    ).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Turn on auto-receive' }));
    await waitFor(() => expect(callsTo(fetchMock, 'POST /api/me/auto-receive')).toBe(1));
    expect(await screen.findByText('Auto-receive is on')).toBeInTheDocument();
    expect(toasts.items.map((t) => t.message)).toContain('Auto-receive is on');

    // Step 3: on to home.
    expect(screen.getByRole('link', { name: 'Go to my home' })).toHaveAttribute('href', '/holder');
  });

  it('MainNet: shows the Grofty steps and Check again calls the same endpoint', async () => {
    await signIn('mainnet');
    const fetchMock = stubApi({
      'GET /api/session': holderSession('mainnet'),
      'GET /api/config/public': configFor('mainnet'),
      'GET /api/me/position': position({ autoReceive: false }),
      'POST /api/me/auto-receive': position({ autoReceive: false }),
    });
    render(Page);
    expect(await screen.findByText('Open Grofty Wallet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn on auto-receive' })).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(callsTo(fetchMock, 'POST /api/me/auto-receive')).toBe(1));
    expect(await screen.findByText(/Auto-receive is not on yet\./)).toBeInTheDocument();
  });

  it('shows the server message in place when a MainNet write needs the wallet', async () => {
    await signIn('mainnet');
    stubApi({
      'GET /api/session': holderSession('mainnet'),
      'GET /api/config/public': configFor('mainnet'),
      'GET /api/me/position': position({ units: 0, pendingUnits: [tranche], autoReceive: false }),
      'POST /api/me/units/unit-1/accept': () =>
        json(
          {
            error: {
              code: 'sign_in_wallet',
              message: 'Approve this in Grofty Wallet, then retry.',
            },
          },
          409,
        ),
    });
    render(Page);
    await fireEvent.click(await screen.findByRole('button', { name: /Accept units/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Approve this in Grofty Wallet, then retry.',
    );
  });

  it('shows what failed with a retry when the position cannot load', async () => {
    sessionStore.reset();
    stubApi({
      'GET /api/session': holderSession(),
      'GET /api/config/public': configFor(),
      'GET /api/me/position': () =>
        json({ error: { code: 'forbidden', message: 'This invitation is not for you.' } }, 403),
    });
    await sessionStore.load();
    render(Page);
    expect(await screen.findByRole('alert')).toHaveTextContent('This invitation is not for you.');
  });
});
