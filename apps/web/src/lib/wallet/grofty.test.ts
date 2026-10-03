import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAINNET_ACCOUNT, healthyGrofty, rpcError, FakeProvider } from '../../test/grofty';
import * as grofty from './grofty';

beforeEach(() => grofty.setMinVersion('2.0.4'));
afterEach(() => grofty.useProvider(undefined));

const errorOf = async (promise: Promise<unknown>): Promise<grofty.GroftyWalletError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof grofty.GroftyWalletError) return error;
    throw error;
  }
  throw new Error('expected a GroftyWalletError');
};

describe('detect', () => {
  it('is true when the extension is there and false when it is not installed', async () => {
    grofty.useProvider(healthyGrofty());
    expect(await grofty.detect()).toBe(true);
    grofty.useProvider(null);
    expect(await grofty.detect()).toBe(false);
  });
});

describe('connect', () => {
  it('connects, checks the network and returns the primary account', async () => {
    const provider = healthyGrofty();
    grofty.useProvider(provider);
    expect(await grofty.connect()).toEqual({
      partyId: MAINNET_ACCOUNT.partyId,
      publicKey: MAINNET_ACCOUNT.publicKey,
      networkId: 'canton:da-mainnet',
    });
    expect(provider.calls.map((c) => c.method)).toEqual([
      'connect',
      'getActiveNetwork',
      'getPrimaryAccount',
    ]);
  });

  it('refuses a wallet that is not on Canton MainNet', async () => {
    grofty.useProvider(
      healthyGrofty({ handlers: { getActiveNetwork: () => ({ networkId: 'canton:da-testnet' }) } }),
    );
    const error = await errorOf(grofty.connect());
    expect(error.kind).toBe('wrong-network');
    expect(error.message).toBe(
      'Grofty Wallet is not on Canton MainNet. Switch it to MainNet, then try again.',
    );
  });

  it('says to install Grofty when it is not installed, with a link', async () => {
    grofty.useProvider(null);
    const error = await errorOf(grofty.connect());
    expect(error).toMatchObject({
      kind: 'not-installed',
      message: 'Install Grofty Wallet to pay on MainNet.',
      helpUrl: 'https://grofty.cc',
    });
  });

  it('maps a locked wallet (4100), a declined connection (4001) and a timeout (-32603)', async () => {
    grofty.useProvider(
      healthyGrofty({
        handlers: {
          connect: () => {
            throw rpcError(4100);
          },
        },
      }),
    );
    expect(await errorOf(grofty.connect())).toMatchObject({
      kind: 'locked',
      message: 'Grofty Wallet is locked or not connected to this site. Unlock it, then try again.',
    });
    grofty.useProvider(
      healthyGrofty({
        handlers: {
          connect: () => {
            throw rpcError(4001);
          },
        },
      }),
    );
    expect(await errorOf(grofty.connect())).toMatchObject({
      kind: 'declined',
      message: 'You declined in Grofty. Nothing was sent.',
    });
    grofty.useProvider(
      healthyGrofty({
        handlers: {
          connect: () => {
            throw rpcError(-32603);
          },
        },
      }),
    );
    expect(await errorOf(grofty.connect())).toMatchObject({
      kind: 'expired',
      message: 'Your wallet approval expired after 3 minutes. Approve again.',
    });
  });

  it('treats a connection the wallet did not accept as locked, and a wallet without accounts as such', async () => {
    grofty.useProvider(
      healthyGrofty({ handlers: { connect: () => ({ isConnected: false, reason: 'locked' }) } }),
    );
    expect((await errorOf(grofty.connect())).kind).toBe('locked');
    grofty.useProvider(healthyGrofty({ handlers: { getPrimaryAccount: () => null } }));
    expect((await errorOf(grofty.connect())).kind).toBe('no-account');
  });
});

describe('signMessage', () => {
  it('asks the wallet to sign and returns the signature (envelope or bare string)', async () => {
    const provider = healthyGrofty();
    grofty.useProvider(provider);
    expect(await grofty.signMessage('hello')).toBe('c2lnbmVk');
    expect(provider.callsTo('signMessage')[0]?.params).toEqual({ message: 'hello' });
    grofty.useProvider(healthyGrofty({ handlers: { signMessage: () => 'YmFyZQ==' } }));
    expect(await grofty.signMessage('hello')).toBe('YmFyZQ==');
  });

  it('maps a decline', async () => {
    grofty.useProvider(
      healthyGrofty({
        handlers: {
          signMessage: () => {
            throw rpcError(4001);
          },
        },
      }),
    );
    expect((await errorOf(grofty.signMessage('x'))).kind).toBe('declined');
  });
});

describe('balance', () => {
  const balanceOf = async (answer: unknown): Promise<string | null> => {
    grofty.useProvider(healthyGrofty({ balance: answer }));
    return grofty.balance('CC');
  };

  it('reads the shapes a wallet plausibly answers', async () => {
    expect(await balanceOf([{ symbol: 'CC', amount: '12.5' }])).toBe('12.5');
    expect(
      await balanceOf([
        { symbol: 'USDCx', amount: '1' },
        { symbol: 'CC', amount: '7' },
      ]),
    ).toBe('7');
    expect(await balanceOf({ CC: '3.25' })).toBe('3.25');
    expect(await balanceOf({ balances: [{ tokenSymbol: 'CC', available: '99' }] })).toBe('99');
    expect(await balanceOf({ amount: '42' })).toBe('42');
    expect(await balanceOf('1,5')).toBeNull();
    expect(await balanceOf({ unrelated: true })).toBeNull();
  });

  it('accepts amounts only as decimal strings and rejects numbers', async () => {
    expect(await balanceOf({ amount: 42 })).toBeNull();
    expect(await balanceOf(42)).toBeNull();
    expect(await balanceOf(1e-7)).toBeNull();
    expect(await balanceOf([{ symbol: 'CC', amount: 0.1 + 0.2 }])).toBeNull();
    expect(await balanceOf({ CC: 1.2345678901234567e19 })).toBeNull();
    // The same amount as a string keeps every digit.
    expect(await balanceOf({ amount: '0.0000001' })).toBe('0.0000001');
    expect(await balanceOf('12345678901234567890.1234567890')).toBe(
      '12345678901234567890.1234567890',
    );
  });

  it('asks the wallet for the balance resource', async () => {
    const provider = healthyGrofty();
    grofty.useProvider(provider);
    await grofty.balance();
    expect(provider.callsTo('ledgerApi')[0]?.params).toMatchObject({ resource: 'balance' });
  });
});

describe('transfer', () => {
  const input = {
    receiver: 'holder::1220aa',
    amount: '15.0000000000',
    memo: 'Mithra Fund September 2026',
  };

  it('sends one plain transfer and returns the update id', async () => {
    const provider = healthyGrofty();
    grofty.useProvider(provider);
    expect(await grofty.transfer(input)).toEqual({ updateId: '1220deadbeef', commandId: 'cmd-1' });
    expect(provider.callsTo('prepareExecuteAndWait')).toEqual([
      { method: 'prepareExecuteAndWait', params: input },
    ]);
  });

  it('declined: "You declined in Grofty. Nothing was sent."', async () => {
    grofty.useProvider(
      healthyGrofty({
        handlers: {
          prepareExecuteAndWait: () => {
            throw rpcError(4001);
          },
        },
      }),
    );
    expect(await errorOf(grofty.transfer(input))).toMatchObject({
      kind: 'declined',
      message: 'You declined in Grofty. Nothing was sent.',
    });
  });

  it('expired after 3 minutes (-32603): "Approve again."', async () => {
    grofty.useProvider(
      healthyGrofty({
        handlers: {
          prepareExecuteAndWait: () => {
            throw rpcError(-32603);
          },
        },
      }),
    );
    expect(await errorOf(grofty.transfer(input))).toMatchObject({
      kind: 'expired',
      message: 'Your wallet approval expired after 3 minutes. Approve again.',
    });
  });

  it('locked or not connected to this site (4100)', async () => {
    grofty.useProvider(
      healthyGrofty({
        handlers: {
          prepareExecuteAndWait: () => {
            throw rpcError(4100);
          },
        },
      }),
    );
    expect(await errorOf(grofty.transfer(input))).toMatchObject({
      kind: 'locked',
      message: 'Grofty Wallet is locked or not connected to this site. Unlock it, then try again.',
    });
  });

  it('an old wallet resolves with undefined: "Update Grofty Wallet to 2.0.4 or newer"', async () => {
    grofty.useProvider(healthyGrofty({ handlers: { prepareExecuteAndWait: () => undefined } }));
    expect(await errorOf(grofty.transfer(input))).toMatchObject({
      kind: 'old-wallet',
      message: 'Update Grofty Wallet to 2.0.4 or newer, then try again.',
    });
    grofty.setMinVersion('2.1.0');
    expect((await errorOf(grofty.transfer(input))).message).toBe(
      'Update Grofty Wallet to 2.1.0 or newer, then try again.',
    );
  });

  it('not installed', async () => {
    grofty.useProvider(null);
    expect(await errorOf(grofty.transfer(input))).toMatchObject({
      kind: 'not-installed',
      message: 'Install Grofty Wallet to pay on MainNet.',
    });
  });

  it('does not report a transfer the wallet did not confirm as sent', async () => {
    grofty.useProvider(
      healthyGrofty({
        handlers: {
          prepareExecuteAndWait: () => ({ tx: { status: 'failed', commandId: 'c', payload: {} } }),
        },
      }),
    );
    expect((await errorOf(grofty.transfer(input))).kind).toBe('failed');
  });
});

describe('transferOutcome (heuristic)', () => {
  const RECEIVER = 'holder::1220aa';
  const created = (templateId: string, createArgument: Record<string, unknown>) => ({
    update: {
      Transaction: { value: { events: [{ CreatedEvent: { templateId, createArgument } }] } },
    },
  });
  const outcomeOf = (update: unknown): Promise<grofty.TransferOutcome> => {
    grofty.useProvider(healthyGrofty({ update }));
    return grofty.transferOutcome('1220deadbeef', RECEIVER);
  };

  it('completed when a holding owned by the receiver was created', async () => {
    expect(
      await outcomeOf(created('pkg:Splice.Amulet:Amulet', { owner: RECEIVER, amount: {} })),
    ).toBe('completed');
    expect(
      await outcomeOf(created('pkg:Splice.Api.Token.HoldingV1:Holding', { owner: RECEIVER })),
    ).toBe('completed');
  });

  it('pending when a transfer offer or instruction was created', async () => {
    expect(
      await outcomeOf(
        created('pkg:Splice.Wallet.TransferOffer:TransferOffer', { receiver: RECEIVER }),
      ),
    ).toBe('pending');
    expect(
      await outcomeOf(
        created('pkg:Splice.AmuletTransferInstruction:AmuletTransferInstruction', {}),
      ),
    ).toBe('pending');
  });

  it('unknown for a holding of somebody else, for nothing recognisable and for a failed read', async () => {
    expect(await outcomeOf(created('pkg:Splice.Amulet:Amulet', { owner: 'other::1220bb' }))).toBe(
      'unknown',
    );
    expect(await outcomeOf({})).toBe('unknown');
    expect(
      await outcomeOf(() => {
        throw rpcError(-32601);
      }),
    ).toBe('unknown');
    grofty.useProvider(new FakeProvider());
    expect(await grofty.transferOutcome('x', RECEIVER)).toBe('unknown');
  });
});
