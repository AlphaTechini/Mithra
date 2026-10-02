import { GroftyRpcError, type Cip0103Provider } from '@groftylabs/dapp-sdk';

type Handler = (params: unknown) => unknown;
type Listener = (...args: unknown[]) => void;

/**
 * A stand-in for the injected `window.cantonWallet` provider, in the shape of the SDK's own fake:
 * `request` looks a handler up by method name and rejects with METHOD_NOT_FOUND like the wallet
 * does; handlers may throw a `GroftyRpcError` (or any object with a numeric `code`).
 */
export class FakeProvider implements Cip0103Provider {
  readonly calls: { method: string; params?: unknown }[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(private readonly handlers: Record<string, Handler> = {}) {}

  async request<T = unknown>(args: { method: string; params?: unknown }): Promise<T> {
    this.calls.push(args.params === undefined ? { method: args.method } : args);
    const handler = this.handlers[args.method];
    if (!handler) throw new GroftyRpcError(`Unsupported method: ${args.method}`, -32601);
    return (await handler(args.params)) as T;
  }

  on(event: string, listener: Listener): this {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  removeListener(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  callsTo(method: string): { method: string; params?: unknown }[] {
    return this.calls.filter((c) => c.method === method);
  }
}

export const MAINNET_ACCOUNT = {
  primary: true,
  partyId: 'treasurer-wallet::1220aabbccdd',
  status: 'allocated',
  hint: 'treasurer-wallet',
  publicKey: 'cHVibGljLWtleS1ieXRlcy0zMi1sb25nLWVub3VnaCE=',
  namespace: '1220aabbccdd',
  networkId: 'canton:da-mainnet',
  signingProviderId: 'grofty',
};

export interface HealthyOptions {
  /** What `getBalance()` (the `ledgerApi` resource `balance`) answers. */
  balance?: unknown;
  /** What `getUpdateById()` answers (or a function that throws). */
  update?: unknown;
  /** Handlers that replace the healthy ones, by provider method. */
  handlers?: Record<string, Handler>;
  /** Already connected to this site (default: false, like a wallet the person has not approved yet). */
  connected?: boolean;
}

/** A value, or a function that produces it (and may throw). */
function answer(value: unknown): unknown {
  return typeof value === 'function' ? (value as () => unknown)() : value;
}

/** A healthy Grofty Wallet on MainNet; `handlers` breaks one thing at a time. */
export function healthyGrofty(options: HealthyOptions = {}): FakeProvider {
  const { balance = [{ symbol: 'CC', amount: '5000.0' }], update = {}, handlers = {} } = options;
  let connected = options.connected ?? false;
  return new FakeProvider({
    connect: () => {
      connected = true;
      return { isConnected: true, isNetworkConnected: true };
    },
    getActiveNetwork: () => ({ networkId: 'canton:da-mainnet' }),
    getPrimaryAccount: () => {
      // Like the wallet: unauthorized until this site was connected.
      if (!connected) throw rpcError(4100, 'Not connected');
      return MAINNET_ACCOUNT;
    },
    listAccounts: () => [MAINNET_ACCOUNT],
    signMessage: () => ({ signature: 'c2lnbmVk' }),
    ledgerApi: (params) => {
      const resource = (params as { resource?: string } | undefined)?.resource;
      if (resource === 'balance') return answer(balance);
      if (resource === '/v2/updates/update-by-id') return answer(update);
      throw rpcError(-32601, `Unsupported resource ${String(resource)}`);
    },
    prepareExecuteAndWait: () => ({
      tx: {
        status: 'executed',
        commandId: 'cmd-1',
        payload: { updateId: '1220deadbeef', completionOffset: 42 },
      },
    }),
    ...handlers,
  });
}

export const rpcError = (code: number, message = 'wallet said no'): GroftyRpcError =>
  new GroftyRpcError(message, code);
