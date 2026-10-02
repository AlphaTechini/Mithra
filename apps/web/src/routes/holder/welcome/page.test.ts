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
import { MAINNET_ACCOUNT, healthyGrofty, rpcError } from '../../../test/grofty';
import { useProvider } from '$lib/wallet/grofty';
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

  describe('MainNet payouts', () => {
    const wallet = { partyId: 'holder-wallet::1220aabbccdd' };
    const grofty = () =>
      healthyGrofty({ handlers: { signMessage: () => ({ signature: 'c2ln' }) } });

    afterEach(() => useProvider(undefined));

    it('connects Grofty (challenge, signMessage, register), then shows the auto-receive steps and Check again', async () => {
      await signIn('mainnet');
      let current = position({ pendingUnits: [], autoReceive: null, mainnetWallet: null });
      const provider = grofty();
      useProvider(provider);
      const fetchMock = stubApi({
        'GET /api/session': holderSession('mainnet'),
        'GET /api/config/public': configFor('mainnet'),
        'GET /api/me/position': () => json(current),
        'POST /api/me/mainnet-wallet/challenge': () =>
          json({ nonce: 'abc123', message: 'Connect your Grofty Wallet to Mithra\nNonce: abc123' }),
        'POST /api/me/mainnet-wallet': () => {
          current = position({ autoReceive: false, mainnetWallet: wallet });
          return json(current);
        },
        'POST /api/me/auto-receive': () =>
          json(position({ autoReceive: false, mainnetWallet: wallet })),
      });
      render(Page);

      // Auto-receive waits until the wallet is connected.
      expect(await screen.findByRole('heading', { name: 'Grofty Wallet' })).toBeInTheDocument();
      expect(screen.queryByText('Open Grofty Wallet.')).toBeNull();
      await fireEvent.click(screen.getByRole('button', { name: 'Connect Grofty Wallet' }));

      await waitFor(() => expect(callsTo(fetchMock, 'POST /api/me/mainnet-wallet')).toBe(1));
      // The wallet signed the server's challenge, and its account went back with the signature.
      expect(provider.callsTo('signMessage')[0]?.params).toEqual({
        message: 'Connect your Grofty Wallet to Mithra\nNonce: abc123',
      });
      const sent = fetchMock.mock.calls.find(([u]) => u === '/api/me/mainnet-wallet')?.[1]?.body;
      const registered = JSON.parse(typeof sent === 'string' ? sent : '{}') as Record<
        string,
        string
      >;
      expect(registered).toEqual({
        partyId: MAINNET_ACCOUNT.partyId,
        publicKey: MAINNET_ACCOUNT.publicKey,
        signature: 'c2ln',
        nonce: 'abc123',
      });
      expect(await screen.findByText('Grofty Wallet connected')).toBeInTheDocument();

      // N5: numbered steps to turn on auto-receive in Grofty, and Check again.
      expect(await screen.findByText('Open Grofty Wallet.')).toBeInTheDocument();
      expect(
        screen.getByRole('list', { name: 'Turn on auto-receive in Grofty Wallet' }).tagName,
      ).toBe('OL');
      expect(screen.queryByRole('button', { name: 'Turn on auto-receive' })).toBeNull();
      await fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
      await waitFor(() => expect(callsTo(fetchMock, 'POST /api/me/auto-receive')).toBe(1));
      expect(await screen.findByText(/Auto-receive is not on yet\./)).toBeInTheDocument();
    });

    it('Check again says it cannot tell when the server has no Scan to ask', async () => {
      await signIn('mainnet');
      stubApi({
        'GET /api/session': holderSession('mainnet'),
        'GET /api/config/public': configFor('mainnet'),
        'GET /api/me/position': position({ autoReceive: null, mainnetWallet: wallet }),
        'POST /api/me/auto-receive': position({ autoReceive: null, mainnetWallet: wallet }),
      });
      render(Page);
      await fireEvent.click(await screen.findByRole('button', { name: 'Check again' }));
      expect(await screen.findByText(/Mithra can't check this from here/)).toBeInTheDocument();
    });

    it('says to install Grofty when it is not installed', async () => {
      await signIn('mainnet');
      useProvider(null);
      stubApi({
        'GET /api/session': holderSession('mainnet'),
        'GET /api/config/public': configFor('mainnet'),
        'GET /api/me/position': position({ mainnetWallet: null }),
      });
      render(Page);
      await fireEvent.click(await screen.findByRole('button', { name: 'Connect Grofty Wallet' }));
      expect(
        await screen.findByText(/Install Grofty Wallet to pay on MainNet\./),
      ).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Get Grofty Wallet' })).toHaveAttribute(
        'href',
        'https://grofty.cc',
      );
    });

    it("shows the server's message when the signature is refused", async () => {
      await signIn('mainnet');
      useProvider(grofty());
      stubApi({
        'GET /api/session': holderSession('mainnet'),
        'GET /api/config/public': configFor('mainnet'),
        'GET /api/me/position': position({ mainnetWallet: null }),
        'POST /api/me/mainnet-wallet/challenge': { nonce: 'n1', message: 'm' },
        'POST /api/me/mainnet-wallet': () =>
          json(
            {
              error: {
                code: 'invalid_signature',
                message: "Grofty's signature did not match this wallet. Try connecting again.",
              },
            },
            401,
          ),
      });
      render(Page);
      await fireEvent.click(await screen.findByRole('button', { name: 'Connect Grofty Wallet' }));
      expect(
        await screen.findByText(
          /Grofty's signature did not match this wallet\. Try connecting again\./,
        ),
      ).toBeInTheDocument();
    });

    it('a declined connection says nothing was changed', async () => {
      await signIn('mainnet');
      useProvider(
        healthyGrofty({
          handlers: {
            connect: () => {
              throw rpcError(4001);
            },
          },
        }),
      );
      stubApi({
        'GET /api/session': holderSession('mainnet'),
        'GET /api/config/public': configFor('mainnet'),
        'GET /api/me/position': position({ mainnetWallet: null }),
      });
      render(Page);
      await fireEvent.click(await screen.findByRole('button', { name: 'Connect Grofty Wallet' }));
      expect(
        await screen.findByText('You declined in Grofty. Nothing was sent.'),
      ).toBeInTheDocument();
    });
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
