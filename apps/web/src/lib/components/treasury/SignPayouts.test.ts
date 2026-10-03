import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MainnetPayout, MainnetPayoutsResponse } from '@mithra/shared';
import { sessionStore } from '$lib/stores/session.svelte';
import { toasts } from '$lib/stores/toasts.svelte';
import { setMinVersion, useProvider } from '$lib/wallet/grofty';
import { FakeProvider, healthyGrofty, rpcError } from '../../../test/grofty';
import { errorResponse, deferred, stubApi } from '../../../test/treasury/stub';
import { sessionRoutes } from '../../../test/treasury/fixtures';
import SignPayouts from './SignPayouts.svelte';

const LIST = 'GET /api/cycles/2026-09/mainnet-payouts';
const RECORD = (name: string): string => `POST /api/cycles/2026-09/mainnet-payouts/pay-${name}`;
const EXPLORER = 'https://explorer.example/tx/{updateId}';

function payout(name: string, amount: string, over: Partial<MainnetPayout> = {}): MainnetPayout {
  return {
    paymentId: `pay-${name}`,
    holder: { partyId: `${name}::1220aa`, displayName: `Holder ${name}` },
    receiver: `${name.toLowerCase()}-main::1220aabbccddeeff`,
    amount,
    memo: 'Mithra Northwind Income Fund September 2026',
    status: 'to-sign',
    link: null,
    ...over,
  };
}

function list(payouts: MainnetPayout[], feeBuffer = '1.0000000000'): MainnetPayoutsResponse {
  const total = payouts.reduce((s, p) => s + Number(p.amount), 0).toFixed(10);
  return { assetSymbol: 'CC', total, feeBuffer, payouts };
}

const A = () => payout('A', '15.0000000000');
const B = () => payout('B', '45.0000000000');
const paid = (p: MainnetPayout, updateId: string): MainnetPayout => ({
  ...p,
  status: 'paid',
  link: { updateId, href: EXPLORER.replace('{updateId}', updateId), external: true },
});

async function mount(response: MainnetPayoutsResponse, routes: Record<string, unknown> = {}) {
  const api = stubApi({ ...sessionRoutes('treasurer', 'mainnet'), [LIST]: response, ...routes });
  await sessionStore.load();
  const onchange = vi.fn();
  render(SignPayouts, { props: { cycleId: '2026-09', onchange } });
  return { api, onchange };
}

const connectButton = () => screen.findByRole('button', { name: 'Connect Grofty Wallet' });
const payButton = (name: string) =>
  screen.getByRole('button', { name: `Pay Holder ${name} in Grofty` });

beforeEach(() => {
  sessionStore.reset();
  toasts.clear();
  setMinVersion('2.0.4');
  window.localStorage.clear();
});

afterEach(() => {
  useProvider(undefined);
  vi.unstubAllGlobals();
});

describe('Sign payouts in Grofty', () => {
  it('without the extension says to install Grofty, with a link, and offers no way to sign', async () => {
    useProvider(null);
    await mount(list([A(), B()]));
    expect(
      await screen.findByText(/Install Grofty Wallet to pay on MainNet\./),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Get Grofty Wallet' })).toHaveAttribute(
      'href',
      'https://grofty.cc',
    );
    expect(screen.getByRole('heading', { name: 'Sign payouts in Grofty' })).toBeInTheDocument();
    for (const name of ['A', 'B']) expect(payButton(name)).toBeDisabled();
  });

  it('lists one row per payee with the amount and the receiver, and signs nothing before the person acts', async () => {
    const provider = healthyGrofty();
    useProvider(provider);
    await mount(list([A(), B()]));
    await connectButton();
    const rows = screen.getAllByRole('listitem');
    expect(within(rows[0]!).getByText('Holder A')).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent(/15\.00\s*CC/);
    expect(within(rows[0]!).getByTitle('a-main::1220aabbccddeeff')).toBeInTheDocument();
    expect(provider.callsTo('prepareExecuteAndWait')).toEqual([]);
    expect(provider.callsTo('connect')).toEqual([]);
  });

  it('connects, checks the balance, and pays one payee: the row stays pending until the server answers (P4)', async () => {
    const provider = healthyGrofty({
      balance: [{ symbol: 'CC', amount: '5000' }],
      update: {
        update: {
          Transaction: {
            value: {
              events: [
                {
                  CreatedEvent: {
                    templateId: 'pkg:Splice.Amulet:Amulet',
                    createArgument: { owner: 'a-main::1220aabbccddeeff' },
                  },
                },
              ],
            },
          },
        },
      },
    });
    useProvider(provider);
    const server = deferred<unknown>();
    const { api, onchange } = await mount(list([A(), B()]), {
      [RECORD('A')]: () => server.promise,
    });
    await fireEvent.click(await connectButton());
    await screen.findByText('Grofty Wallet connected');
    await waitFor(() => expect(provider.callsTo('ledgerApi').length).toBeGreaterThan(0));
    expect(payButton('A')).toBeEnabled();

    await fireEvent.click(payButton('A'));
    // The wallet is asked for one plain transfer to the server's receiver, amount and memo.
    await waitFor(() => expect(provider.callsTo('prepareExecuteAndWait')).toHaveLength(1));
    expect(provider.callsTo('prepareExecuteAndWait')[0]?.params).toEqual({
      receiver: 'a-main::1220aabbccddeeff',
      amount: '15.0000000000',
      memo: 'Mithra Northwind Income Fund September 2026',
    });
    // Grofty answered; the server has not yet: the row is pending, not Paid.
    await waitFor(() => expect(api.callsTo(RECORD('A'))).toHaveLength(1));
    expect(api.callsTo(RECORD('A'))[0]?.body).toEqual({
      updateId: '1220deadbeef',
      outcome: 'completed',
    });
    const rowA = screen.getAllByRole('listitem')[0]!;
    expect(within(rowA).getByText('Pending ledger confirmation')).toBeInTheDocument();
    expect(screen.queryByText('Paid', { exact: true })).toBeNull();
    // Sequential: while one payout is in flight no other can be started.
    expect(payButton('B')).toBeDisabled();

    // The server records it: now the row says Paid, with a link to the explorer in a new tab.
    server.resolve(list([paid(A(), '1220deadbeef'), B()]));
    await waitFor(() => expect(screen.getByText('Paid', { exact: true })).toBeInTheDocument());
    const link = screen.getByRole('link', { name: 'View on explorer' });
    expect(link).toHaveAttribute('href', 'https://explorer.example/tx/1220deadbeef');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toBe('external noopener noreferrer');
    expect(onchange).toHaveBeenCalled();
    expect(payButton('B')).toBeEnabled();
  });

  it('a transfer offer the receiver must accept is recorded as pending and shows Awaiting acceptance', async () => {
    useProvider(
      healthyGrofty({
        update: {
          events: [
            {
              created: {
                templateId: 'pkg:Splice.Wallet.TransferOffer:TransferOffer',
                createArgument: { receiver: 'a-main::1220aabbccddeeff' },
              },
            },
          ],
        },
      }),
    );
    const { api } = await mount(list([A()]), {
      [RECORD('A')]: () =>
        list([
          {
            ...paid(A(), '1220deadbeef'),
            status: 'awaiting-acceptance',
          },
        ]),
    });
    await fireEvent.click(await connectButton());
    await screen.findByText('Grofty Wallet connected');
    await fireEvent.click(payButton('A'));
    await waitFor(() => expect(api.callsTo(RECORD('A'))).toHaveLength(1));
    expect(api.callsTo(RECORD('A'))[0]?.body).toEqual({
      updateId: '1220deadbeef',
      outcome: 'pending',
    });
    expect(await screen.findByText('Awaiting acceptance')).toBeInTheDocument();
    expect(screen.queryByText('Paid', { exact: true })).toBeNull();
  });

  it('when the outcome cannot be read it records unknown', async () => {
    useProvider(healthyGrofty());
    const { api } = await mount(list([A()]), {
      [RECORD('A')]: () => list([paid(A(), '1220deadbeef')]),
    });
    await fireEvent.click(await connectButton());
    await screen.findByText('Grofty Wallet connected');
    await fireEvent.click(payButton('A'));
    await waitFor(() => expect(api.callsTo(RECORD('A'))).toHaveLength(1));
    expect(api.callsTo(RECORD('A'))[0]?.body).toMatchObject({ outcome: 'unknown' });
  });

  describe('Grofty errors, in words', () => {
    async function payWith(handler: () => unknown) {
      const provider = healthyGrofty({ handlers: { prepareExecuteAndWait: handler } });
      useProvider(provider);
      const { api } = await mount(list([A()]));
      await fireEvent.click(await connectButton());
      await screen.findByText('Grofty Wallet connected');
      await fireEvent.click(payButton('A'));
      return { provider, api };
    }

    it('declined (4001)', async () => {
      const { api } = await payWith(() => {
        throw rpcError(4001);
      });
      expect(
        await screen.findByText('You declined in Grofty. Nothing was sent.'),
      ).toBeInTheDocument();
      expect(api.callsTo(RECORD('A'))).toHaveLength(0);
      // The row can be tried again.
      expect(payButton('A')).toBeEnabled();
    });

    it('approval expired after 3 minutes (-32603)', async () => {
      await payWith(() => {
        throw rpcError(-32603);
      });
      expect(
        await screen.findByText('Your wallet approval expired after 3 minutes. Approve again.'),
      ).toBeInTheDocument();
      expect(payButton('A')).toBeEnabled();
    });

    it('locked or not connected to this site (4100)', async () => {
      await payWith(() => {
        throw rpcError(4100);
      });
      expect(
        await screen.findByText(
          'Grofty Wallet is locked or not connected to this site. Unlock it, then try again.',
        ),
      ).toBeInTheDocument();
    });

    it('an old wallet (undefined result)', async () => {
      await payWith(() => undefined);
      expect(
        await screen.findByText('Update Grofty Wallet to 2.0.4 or newer, then try again.'),
      ).toBeInTheDocument();
    });

    it('a failed connection (locked) says so and leaves the rows unsignable', async () => {
      useProvider(
        healthyGrofty({
          handlers: {
            connect: () => {
              throw rpcError(4100);
            },
          },
        }),
      );
      await mount(list([A()]));
      await fireEvent.click(await connectButton());
      expect(
        await screen.findByText(
          'Grofty Wallet is locked or not connected to this site. Unlock it, then try again.',
        ),
      ).toBeInTheDocument();
      expect(payButton('A')).toBeDisabled();
    });
  });

  describe('P5: the balance is checked in Grofty before any signature', () => {
    it('blocks with "Add funds", showing both numbers, and unblocks after a new check', async () => {
      let amount = '20';
      const provider = healthyGrofty({ balance: () => [{ symbol: 'CC', amount }] });
      useProvider(provider);
      await mount(list([A(), B()]));
      await fireEvent.click(await connectButton());
      // 15 + 45 = 60, plus the 1 CC fee buffer = 61 CC needed; the wallet holds 20.
      expect(await screen.findByText('Add funds')).toBeInTheDocument();
      const warning = screen.getByText('Add funds').closest('[role="alert"]') as HTMLElement;
      expect(warning).toHaveTextContent('Your Grofty balance is 20.00 CC');
      expect(warning).toHaveTextContent('61.00 CC');
      expect(warning).toHaveTextContent('60.00 CC plus a 1.00 CC fee buffer');
      expect(payButton('A')).toBeDisabled();
      expect(payButton('B')).toBeDisabled();
      expect(provider.callsTo('prepareExecuteAndWait')).toEqual([]);

      amount = '100';
      await fireEvent.click(screen.getByRole('button', { name: 'Check balance again' }));
      await waitFor(() => expect(payButton('A')).toBeEnabled());
      expect(screen.queryByText('Add funds')).toBeNull();
    });

    it('an exact balance is enough: total plus the fee buffer', async () => {
      useProvider(healthyGrofty({ balance: [{ symbol: 'CC', amount: '61' }] }));
      await mount(list([A(), B()]));
      await fireEvent.click(await connectButton());
      await waitFor(() => expect(payButton('A')).toBeEnabled());
      expect(screen.queryByText('Add funds')).toBeNull();
    });

    it('only the payouts still to sign count: a paid one is not needed again', async () => {
      useProvider(healthyGrofty({ balance: [{ symbol: 'CC', amount: '46' }] }));
      await mount(list([paid(A(), '1220aa'), B()]));
      await fireEvent.click(await connectButton());
      await waitFor(() => expect(payButton('B')).toBeEnabled());
    });

    it('an unreadable balance warns but does not block (Grofty refuses a transfer it cannot cover)', async () => {
      useProvider(healthyGrofty({ balance: { unexpected: true } }));
      await mount(list([A()]));
      await fireEvent.click(await connectButton());
      expect(
        await screen.findByText(/did not report a balance Mithra could read/),
      ).toBeInTheDocument();
      expect(payButton('A')).toBeEnabled();
    });
  });

  describe('recording', () => {
    it('if the server cannot record a transfer Grofty executed, it is recorded again, never sent twice', async () => {
      const provider = healthyGrofty();
      useProvider(provider);
      let attempts = 0;
      const { api } = await mount(list([A()]), {
        [RECORD('A')]: () => {
          attempts += 1;
          return attempts === 1
            ? errorResponse(503, 'ledger_unavailable', 'The ledger is not reachable right now.')
            : list([paid(A(), '1220deadbeef')]);
        },
      });
      await fireEvent.click(await connectButton());
      await screen.findByText('Grofty Wallet connected');
      await fireEvent.click(payButton('A'));
      expect(
        await screen.findByText(/Grofty sent this transfer, but Mithra could not record it/),
      ).toBeInTheDocument();
      expect(screen.queryByText('Paid', { exact: true })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Pay Holder A in Grofty' })).toBeNull();

      await fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));
      await waitFor(() => expect(screen.getByText('Paid', { exact: true })).toBeInTheDocument());
      // The second record carried the same transfer; the wallet was asked once.
      expect(api.callsTo(RECORD('A'))).toHaveLength(2);
      expect(api.callsTo(RECORD('A'))[1]?.body).toEqual(api.callsTo(RECORD('A'))[0]?.body);
      expect(provider.callsTo('prepareExecuteAndWait')).toHaveLength(1);
    });

    it('after a reload an unrecorded transfer is offered for recording, not for paying again', async () => {
      useProvider(healthyGrofty());
      window.localStorage.setItem(
        'mithra.unrecorded.2026-09',
        JSON.stringify({ 'pay-A': { updateId: '1220cafe', outcome: 'completed' } }),
      );
      await mount(list([A()]), { [RECORD('A')]: () => list([paid(A(), '1220cafe')]) });
      expect(
        await screen.findByText(/Grofty sent this transfer, but Mithra has not recorded it yet/),
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Pay Holder A in Grofty' })).toBeNull();
      await fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));
      await waitFor(() => expect(screen.getByText('Paid', { exact: true })).toBeInTheDocument());
      expect(window.localStorage.getItem('mithra.unrecorded.2026-09')).toBe('{}');
    });

    it('remembers the transfer as soon as Grofty executed it, so a reload while the outcome is read cannot pay twice', async () => {
      const hang = deferred<unknown>();
      const provider = healthyGrofty({ update: () => hang.promise });
      useProvider(provider);
      const { api } = await mount(list([A()]), {
        [RECORD('A')]: () => list([paid(A(), '1220deadbeef')]),
      });
      await fireEvent.click(await connectButton());
      await screen.findByText('Grofty Wallet connected');
      await fireEvent.click(payButton('A'));
      await waitFor(() => expect(provider.callsTo('prepareExecuteAndWait')).toHaveLength(1));
      // Grofty sent it; Mithra has not recorded it, and the outcome is still being read.
      await waitFor(() =>
        expect(
          JSON.parse(window.localStorage.getItem('mithra.unrecorded.2026-09') ?? '{}'),
        ).toEqual({ 'pay-A': { updateId: '1220deadbeef', outcome: 'unknown' } }),
      );
      expect(api.callsTo(RECORD('A'))).toHaveLength(0);

      // The treasurer reloads the page: the row offers recording, not paying.
      cleanup();
      render(SignPayouts, { props: { cycleId: '2026-09' } });
      expect(
        await screen.findByText(/Grofty sent this transfer, but Mithra has not recorded it yet/),
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Pay Holder A in Grofty' })).toBeNull();
      await fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));
      await waitFor(() => expect(api.callsTo(RECORD('A'))).toHaveLength(1));
      expect(api.callsTo(RECORD('A'))[0]?.body).toEqual({
        updateId: '1220deadbeef',
        outcome: 'unknown',
      });
      expect(provider.callsTo('prepareExecuteAndWait')).toHaveLength(1);
      await waitFor(() =>
        expect(window.localStorage.getItem('mithra.unrecorded.2026-09')).toBe('{}'),
      );
    });

    it('updates the remembered transfer with the real outcome before recording', async () => {
      useProvider(
        healthyGrofty({
          update: {
            events: [
              {
                created: {
                  templateId: 'pkg:Splice.Wallet.TransferOffer:TransferOffer',
                  createArgument: { receiver: 'a-main::1220aabbccddeeff' },
                },
              },
            ],
          },
        }),
      );
      await mount(list([A()]), {
        [RECORD('A')]: () =>
          errorResponse(503, 'ledger_unavailable', 'The ledger is not reachable right now.'),
      });
      await fireEvent.click(await connectButton());
      await screen.findByText('Grofty Wallet connected');
      await fireEvent.click(payButton('A'));
      await screen.findByText(/Grofty sent this transfer, but Mithra could not record it/);
      expect(JSON.parse(window.localStorage.getItem('mithra.unrecorded.2026-09') ?? '{}')).toEqual({
        'pay-A': { updateId: '1220deadbeef', outcome: 'pending' },
      });
    });

    it('"Mark as accepted" records the same transfer as completed once the holder accepted it', async () => {
      useProvider(healthyGrofty());
      const waiting: MainnetPayout = {
        ...paid(A(), '1220deadbeef'),
        status: 'awaiting-acceptance',
      };
      const { api } = await mount(list([waiting]), {
        [RECORD('A')]: () => list([paid(A(), '1220deadbeef')]),
      });
      await fireEvent.click(await screen.findByRole('button', { name: 'Mark as accepted' }));
      await waitFor(() => expect(api.callsTo(RECORD('A'))).toHaveLength(1));
      expect(api.callsTo(RECORD('A'))[0]?.body).toEqual({
        updateId: '1220deadbeef',
        outcome: 'completed',
      });
      await waitFor(() =>
        expect(screen.getByText('Every payout is recorded.')).toBeInTheDocument(),
      );
    });
  });

  it('shows what failed, with a retry, when the payouts cannot be loaded', async () => {
    useProvider(new FakeProvider());
    await mount(list([A()]), {
      [LIST]: () =>
        errorResponse(409, 'not_ready_to_sign', 'September 2026 has no payouts to sign yet.'),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('has no payouts to sign yet');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
