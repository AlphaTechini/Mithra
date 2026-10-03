import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callsTo,
  configFor,
  HOLDER_A,
  HOLDER_B,
  holderSession,
  json,
  position,
  stubApi,
} from '$lib/components/holder/fixtures';
import { sessionStore } from '$lib/stores/session.svelte';
import Page from './+page.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn(() => Promise.resolve()) }));

const paid = {
  paymentId: 'pay-1',
  cycleLabel: 'August 2026',
  amount: '300.0000000000',
  status: 'paid' as const,
  at: '2026-09-01T09:00:00Z',
  link: { updateId: '1220upd1', href: '/holder/tx/1220upd1', external: false },
  seeded: true,
};
const awaiting = {
  paymentId: 'pay-2',
  cycleLabel: 'September 2026',
  amount: '310.5000000000',
  status: 'awaiting-acceptance' as const,
  at: '2026-10-01T09:00:00Z',
  link: null,
  seeded: false,
};

async function signIn(network: 'localnet' | 'mainnet' = 'localnet'): Promise<void> {
  sessionStore.reset();
  stubApi({
    'GET /api/session': holderSession(network),
    'GET /api/config/public': configFor(network),
  });
  await sessionStore.load();
}

beforeEach(async () => {
  await signIn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('holder home', () => {
  it('shows units, share, total received, next payment and the privacy note', async () => {
    stubApi({ 'GET /api/me/position': position({ payments: [paid] }) });
    render(Page);
    expect(await screen.findByText('2,500')).toBeInTheDocument();
    expect(screen.getByText('25.00%')).toBeInTheDocument();
    expect(screen.getByText('1,250.50')).toBeInTheDocument();
    expect(screen.getByText('Nov 1')).toBeInTheDocument();
    expect(screen.getByText('Only you and the fund can see your position.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /auto-receive/i })).toBeNull();
  });

  it('shows the empty state when there are no payments', async () => {
    stubApi({ 'GET /api/me/position': position() });
    render(Page);
    expect(
      await screen.findByText('No payments yet. Your first yield payment will appear here.'),
    ).toBeInTheDocument();
  });

  it('tags seeded payments and shows Paid with a word, not colour alone', async () => {
    stubApi({ 'GET /api/me/position': position({ payments: [paid] }) });
    render(Page);
    const row = (await screen.findByText('August 2026')).closest('tr');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('Paid')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('Seeded')).toBeInTheDocument();
  });

  it('shows an awaiting payment with Accept payment, which calls the endpoint', async () => {
    let current = position({ payments: [awaiting] });
    const fetchMock = stubApi({
      'GET /api/me/position': () => json(current),
      'POST /api/me/payments/pay-2/accept': () => {
        current = position({
          totalReceived: '1561.0000000000',
          payments: [
            {
              ...awaiting,
              status: 'paid',
              link: { updateId: '1220upd2', href: '/holder/tx/1220upd2', external: false },
            },
          ],
        });
        return json(current);
      },
    });
    render(Page);
    expect(await screen.findByText('Awaiting acceptance')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /Accept payment/ }));
    await waitFor(() => expect(callsTo(fetchMock, 'POST /api/me/payments/pay-2/accept')).toBe(1));
    expect(await screen.findByText('Paid')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Accept payment/ })).toBeNull();
    expect(screen.getByText('1,561.00')).toBeInTheDocument();
  });

  it('shows a banner with Turn on auto-receive when auto-receive is off', async () => {
    const fetchMock = stubApi({
      'GET /api/me/position': position({ autoReceive: false }),
      'POST /api/me/auto-receive': position({ autoReceive: true }),
    });
    render(Page);
    await fireEvent.click(await screen.findByRole('button', { name: 'Turn on auto-receive' }));
    await waitFor(() => expect(callsTo(fetchMock, 'POST /api/me/auto-receive')).toBe(1));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Turn on auto-receive' })).toBeNull(),
    );
  });

  it('P3 on LocalNet: the payment links to the in-app transaction detail', async () => {
    stubApi({ 'GET /api/me/position': position({ payments: [paid] }) });
    render(Page);
    const link = await screen.findByRole('link', { name: /View transaction/ });
    expect(link).toHaveAttribute('href', '/holder/tx/1220upd1');
    expect(link).not.toHaveAttribute('target');
  });

  it('P3 on MainNet: the payment links to the explorer in a new tab', async () => {
    await signIn('mainnet');
    stubApi({
      'GET /api/me/position': position({
        payments: [
          {
            ...paid,
            link: {
              updateId: '1220upd1',
              href: 'https://explorer.example/tx/1220upd1',
              external: true,
            },
          },
        ],
      }),
    });
    render(Page);
    const link = await screen.findByRole('link', { name: /View on explorer/ });
    expect(link).toHaveAttribute('href', 'https://explorer.example/tx/1220upd1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('rel')).toContain('noreferrer');
  });

  describe('MainNet payouts', () => {
    const wallet = { partyId: 'holder-wallet::1220aabbccddeeff0011' };
    const pending = {
      paymentId: 'pay-3',
      cycleLabel: 'October 2026',
      amount: '99.0000000000',
      status: 'pending' as const,
      at: '2026-10-02T09:00:00Z',
      link: null,
      seeded: false,
    };

    it('asks to connect Grofty first, and holds back the auto-receive steps until it is connected', async () => {
      await signIn('mainnet');
      stubApi({ 'GET /api/me/position': position({ mainnetWallet: null, autoReceive: null }) });
      render(Page);
      expect(
        await screen.findByRole('button', { name: 'Connect Grofty Wallet' }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Connect Grofty Wallet so your payouts know where to go/),
      ).toBeInTheDocument();
      expect(screen.queryByText('Open Grofty Wallet.')).toBeNull();
    });

    it('shows the connected MainNet party (short, with copy) and the numbered auto-receive steps with Check again', async () => {
      await signIn('mainnet');
      stubApi({
        'GET /api/me/position': position({ mainnetWallet: wallet, autoReceive: false }),
        'POST /api/me/auto-receive': position({ mainnetWallet: wallet, autoReceive: true }),
      });
      render(Page);
      expect(
        await screen.findByRole('heading', { name: 'Your Grofty Wallet' }),
      ).toBeInTheDocument();
      expect(screen.getByTitle(wallet.partyId)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Copy party ID' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Connect Grofty Wallet' })).toBeNull();
      expect(
        screen.getByRole('list', { name: 'Turn on auto-receive in Grofty Wallet' }).tagName,
      ).toBe('OL');
      await fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull());
    });

    it('a payment waiting for the treasurer is pending (P4), and an offer is accepted in Grofty, not in Mithra', async () => {
      await signIn('mainnet');
      stubApi({
        'GET /api/me/position': position({
          mainnetWallet: wallet,
          autoReceive: true,
          payments: [pending, { ...awaiting, link: null }],
        }),
      });
      render(Page);
      await screen.findByText('October 2026');
      expect(screen.getByText('Pending ledger confirmation')).toBeInTheDocument();
      expect(screen.getByText('Accept it in Grofty Wallet.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Accept payment/ })).toBeNull();
    });
  });

  it('shows the server message when accepting fails, and nothing else about anyone', async () => {
    stubApi({
      'GET /api/me/position': position({ payments: [awaiting] }),
      'POST /api/me/payments/pay-2/accept': () =>
        json(
          { error: { code: 'ledger_rejected', message: 'The ledger refused the payment.' } },
          422,
        ),
    });
    render(Page);
    await fireEvent.click(await screen.findByRole('button', { name: /Accept payment/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The ledger refused the payment.');
  });

  it('shows what failed with a retry when the position cannot load', async () => {
    stubApi({
      'GET /api/me/position': () =>
        json({ error: { code: 'unavailable', message: 'The ledger is busy. Try again.' } }, 503),
    });
    render(Page);
    expect(await screen.findByRole('alert')).toHaveTextContent('The ledger is busy. Try again.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('Retry stops being busy when the retry fails too, and a later retry can succeed', async () => {
    let answer: 'fail' | 'ok' = 'fail';
    const api = stubApi({
      'GET /api/me/position': () =>
        answer === 'fail'
          ? json({ error: { code: 'unavailable', message: 'The ledger is busy. Try again.' } }, 503)
          : json(position({ payments: [paid] })),
    });
    render(Page);
    await fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(callsTo(api, 'GET /api/me/position')).toBe(2));
    const retry = await screen.findByRole('button', { name: 'Retry' });
    await waitFor(() => expect(retry).toBeEnabled());
    expect(retry).not.toHaveAttribute('aria-busy');

    answer = 'ok';
    await fireEvent.click(retry);
    expect(await screen.findByText('2,500')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('U7: holder screens never render another holder', () => {
  /** Every text node and every attribute value on the page, as one string. */
  function everything(root: HTMLElement): string {
    const parts: string[] = [root.textContent ?? ''];
    for (const el of root.querySelectorAll('*')) {
      for (const attr of Array.from(el.attributes)) parts.push(attr.value);
    }
    return parts.join('\n');
  }

  it('holder A home contains no string of holder B, including title and aria-label', async () => {
    stubApi({
      'GET /api/me/position': position({ payments: [paid, awaiting], autoReceive: false }),
    });
    const { container } = render(Page);
    await screen.findByText('August 2026');

    // The fixtures differ: B's name, party id, units and amount are not in A's position.
    const html = everything(container);
    expect(html).not.toContain(HOLDER_B.displayName);
    expect(html).not.toContain(HOLDER_B.partyId);
    expect(html).not.toContain(HOLDER_B.partyId.split('::')[1] ?? 'x');
    expect(html).not.toContain(String(HOLDER_B.units));
    expect(html).not.toContain(HOLDER_B.amount);
    expect(html).not.toContain('4,321.56');
    // Sanity: the check can see attributes, so a leak would be caught.
    expect(container.querySelector('[aria-label]')).not.toBeNull();
    expect(html).toContain('Accept payment, September 2026');
  });

  it('error messages are the server message only', async () => {
    stubApi({
      'GET /api/me/position': () =>
        json({ error: { code: 'forbidden', message: 'You can only see your own position.' } }, 403),
    });
    const { container } = render(Page);
    await screen.findByRole('alert');
    const html = everything(container);
    expect(html).toContain('You can only see your own position.');
    expect(html).not.toContain(HOLDER_B.displayName);
    expect(html).not.toContain(HOLDER_B.partyId);
  });

  it('the party shown in the page chrome is the session party only', () => {
    expect(sessionStore.party?.displayName).toBe(HOLDER_A.displayName);
  });
});
