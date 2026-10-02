/**
 * Grofty Wallet, the only module that touches `@groftylabs/dapp-sdk` (N4).
 *
 * What the browser does with it, and nothing else: connect and prove who the holder is
 * (`signMessage`), read the treasurer's balance (P5), and send plain CC transfers to the receivers
 * and amounts the server lists (`prepareExecuteAndWait`). It never submits anything else to Canton.
 * Grofty signs as a single party; approvals expire after 3 minutes (error -32603); Grofty Wallet
 * 2.0.4 or newer is needed (older versions resolve `prepareExecuteAndWait` with `undefined`).
 */
import {
  GroftyClient,
  GroftyNotFoundError,
  INTERNAL_ERROR,
  UNAUTHORIZED,
  USER_REJECTED,
  createGroftyClient,
  isGroftyRpcError,
  type Cip0103Provider,
} from '@groftylabs/dapp-sdk';

/** The only network Grofty reports. */
export const MAINNET_NETWORK_ID = 'canton:da-mainnet';
export const GROFTY_URL = 'https://grofty.cc';
export const DEFAULT_MIN_VERSION = '2.0.4';

export type GroftyErrorKind =
  | 'not-installed'
  | 'declined'
  | 'expired'
  | 'locked'
  | 'old-wallet'
  | 'wrong-network'
  | 'no-account'
  | 'failed';

/** An error whose message is already the copy people read. */
export class GroftyWalletError extends Error {
  constructor(
    readonly kind: GroftyErrorKind,
    message: string,
    /** Where to send the person to fix it, when there is such a place. */
    readonly helpUrl: string | null = null,
  ) {
    super(message);
    this.name = 'GroftyWalletError';
  }
}

export interface GroftyAccount {
  partyId: string;
  /** The Ed25519 public key as Grofty reports it (base64 or hex, unverified). */
  publicKey: string;
  networkId: string;
}

export interface GroftyTransfer {
  /** The MainNet update id of the executed transfer. */
  updateId: string;
  commandId: string;
}

/** How Grofty's own view of a transfer reads, see `transferOutcome`. */
export type TransferOutcome = 'completed' | 'pending' | 'unknown';

let providerOverride: Cip0103Provider | null | undefined;
let minVersion = DEFAULT_MIN_VERSION;
let cached: { client: GroftyClient | null } | null = null;

/** Sets the minimum wallet version shown in the "update Grofty" copy (from the server's config). */
export function setMinVersion(version: string): void {
  minVersion = version;
}

/**
 * Tests: use this provider instead of looking for the extension. `null` means "not installed";
 * `undefined` goes back to real discovery.
 */
export function useProvider(provider: Cip0103Provider | null | undefined): void {
  providerOverride = provider;
  cached = null;
}

async function clientOrNull(): Promise<GroftyClient | null> {
  if (providerOverride !== undefined) {
    return providerOverride === null ? null : new GroftyClient(providerOverride);
  }
  if (cached) return cached.client;
  const client = await createGroftyClient({ discoveryTimeoutMs: 1500 });
  // A missing wallet is not cached: the extension may be installed while the page is open.
  if (client) cached = { client };
  return client;
}

async function requireClient(): Promise<GroftyClient> {
  const client = await clientOrNull();
  if (!client) {
    throw new GroftyWalletError(
      'not-installed',
      'Install Grofty Wallet to pay on MainNet.',
      GROFTY_URL,
    );
  }
  return client;
}

/** The copy for anything Grofty (or the SDK) throws. Branches on `code`, never on the wording. */
export function describeGroftyError(
  error: unknown,
  fallback = 'Grofty Wallet could not do that.',
): GroftyWalletError {
  if (error instanceof GroftyWalletError) return error;
  if (error instanceof GroftyNotFoundError) {
    return new GroftyWalletError(
      'not-installed',
      'Install Grofty Wallet to pay on MainNet.',
      GROFTY_URL,
    );
  }
  const code = isGroftyRpcError(error)
    ? error.code
    : typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
  switch (code) {
    case USER_REJECTED:
      return new GroftyWalletError('declined', 'You declined in Grofty. Nothing was sent.');
    case INTERNAL_ERROR:
      // The 3-minute approval timeout is reported as an internal error, not as a rejection.
      return new GroftyWalletError(
        'expired',
        'Your wallet approval expired after 3 minutes. Approve again.',
      );
    case UNAUTHORIZED:
      return new GroftyWalletError(
        'locked',
        'Grofty Wallet is locked or not connected to this site. Unlock it, then try again.',
      );
    default:
      return new GroftyWalletError('failed', fallback);
  }
}

function oldWallet(): GroftyWalletError {
  return new GroftyWalletError(
    'old-wallet',
    `Update Grofty Wallet to ${minVersion} or newer, then try again.`,
    GROFTY_URL,
  );
}

/** True when the Grofty extension is on this page. */
export async function detect(): Promise<boolean> {
  try {
    return (await clientOrNull()) !== null;
  } catch {
    return false;
  }
}

/** The connected wallet's primary account, or null when it has none. Never opens a prompt. */
export async function account(): Promise<GroftyAccount | null> {
  const client = await requireClient();
  try {
    const primary = await client.getPrimaryAccount();
    return primary
      ? { partyId: primary.partyId, publicKey: primary.publicKey, networkId: primary.networkId }
      : null;
  } catch (error) {
    throw describeGroftyError(error);
  }
}

/**
 * Connects this site to Grofty (the wallet asks the person), checks the wallet is on Canton
 * MainNet and returns its primary account.
 */
export async function connect(): Promise<GroftyAccount> {
  const client = await requireClient();
  try {
    const result = await client.connect();
    if (!result.isConnected) {
      throw new GroftyWalletError(
        'locked',
        'Grofty Wallet is locked or not connected to this site. Unlock it, then try again.',
      );
    }
    const network = await client.getActiveNetwork();
    if (network.networkId !== MAINNET_NETWORK_ID) {
      throw new GroftyWalletError(
        'wrong-network',
        'Grofty Wallet is not on Canton MainNet. Switch it to MainNet, then try again.',
      );
    }
    const primary = await client.getPrimaryAccount();
    if (!primary) {
      throw new GroftyWalletError(
        'no-account',
        'Grofty Wallet has no account to use. Create or unlock one, then try again.',
      );
    }
    return { partyId: primary.partyId, publicKey: primary.publicKey, networkId: primary.networkId };
  } catch (error) {
    throw describeGroftyError(error);
  }
}

/** Asks the wallet to sign `message` (Ed25519 over its UTF-8 bytes); resolves to the signature. */
export async function signMessage(message: string): Promise<string> {
  const client = await requireClient();
  try {
    return await client.signMessage(message);
  } catch (error) {
    throw describeGroftyError(error);
  }
}

/**
 * The wallet's CC balance as a decimal string, or null when the answer has a shape this code does
 * not know. UNVERIFIED (docs/verification.md): `getBalance()` is typed as unknown by the SDK. The
 * reader accepts the shapes a wallet plausibly returns: a number or string, an object keyed by
 * symbol, an object with `amount`/`available`/`total`, or a list of such entries (CC first).
 */
export async function balance(symbol = 'CC'): Promise<string | null> {
  const client = await requireClient();
  try {
    return readBalance(await client.getBalance(), symbol);
  } catch (error) {
    throw describeGroftyError(error);
  }
}

const DECIMAL = /^-?\d+(\.\d+)?$/;

function asDecimal(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && DECIMAL.test(value.trim())) return value.trim();
  return null;
}

function readBalance(raw: unknown, symbol: string, depth = 0): string | null {
  const direct = asDecimal(raw);
  if (direct !== null) return direct;
  if (depth > 3 || raw === null || typeof raw !== 'object') return null;
  if (Array.isArray(raw)) {
    const list: unknown[] = raw;
    const entry =
      list.find(
        (e) =>
          typeof e === 'object' &&
          e !== null &&
          ['symbol', 'tokenSymbol', 'instrument', 'id'].some(
            (k) => (e as Record<string, unknown>)[k] === symbol,
          ),
      ) ?? list[0];
    return readBalance(entry, symbol, depth + 1);
  }
  const object = raw as Record<string, unknown>;
  if (symbol in object) return readBalance(object[symbol], symbol, depth + 1);
  for (const key of ['available', 'unlocked', 'amount', 'total', 'balance', 'balances', 'tokens']) {
    if (key in object) {
      const found = readBalance(object[key], symbol, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * One plain CC transfer, signed in Grofty: `prepareExecuteAndWait({ receiver, amount, memo })`.
 * Resolves when the wallet reports it executed. A wallet older than 2.0.4 resolves with
 * `undefined`, which is reported as "update Grofty".
 */
export async function transfer(input: {
  receiver: string;
  amount: string;
  memo: string;
}): Promise<GroftyTransfer> {
  const client = await requireClient();
  let result;
  try {
    result = await client.prepareExecuteAndWait({
      receiver: input.receiver,
      amount: input.amount,
      memo: input.memo,
    });
  } catch (error) {
    throw describeGroftyError(
      error,
      'Grofty Wallet could not send this transfer. Nothing was sent.',
    );
  }
  // `undefined` is what Grofty before 2.0.4 resolves with, so it is a version problem.
  if (!result || typeof result !== 'object' || !('tx' in result) || !result.tx) throw oldWallet();
  const { tx } = result;
  if (tx.status !== 'executed' || !tx.payload?.updateId) {
    throw new GroftyWalletError(
      'failed',
      'Grofty Wallet did not confirm the transfer. Check your wallet before trying again.',
    );
  }
  return { updateId: tx.payload.updateId, commandId: tx.commandId };
}

/** Templates that mean "a transfer offer waits for the receiver to accept it". */
const OFFER_TEMPLATE = /TransferOffer|TransferInstruction/;
/** Templates that are a holding of CC: an Amulet (not a locked one) or a token-standard holding. */
const HOLDING_TEMPLATE = /:(Amulet|Holding)$/;

interface CreatedEvent {
  templateId: string;
  owner: unknown;
  receiver: unknown;
}

function createdEvents(node: unknown, found: CreatedEvent[] = [], depth = 0): CreatedEvent[] {
  if (depth > 12 || node === null || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const item of node) createdEvents(item, found, depth + 1);
    return found;
  }
  const object = node as Record<string, unknown>;
  const args = object['createArgument'] ?? object['create_arguments'] ?? object['createArguments'];
  if (typeof object['templateId'] === 'string' && typeof args === 'object' && args !== null) {
    const a = args as Record<string, unknown>;
    found.push({
      templateId: object['templateId'],
      owner: a['owner'],
      receiver:
        a['receiver'] ?? (a['transfer'] as Record<string, unknown> | undefined)?.['receiver'],
    });
  }
  for (const value of Object.values(object)) createdEvents(value, found, depth + 1);
  return found;
}

/**
 * What became of the transfer, from Grofty's view of the transaction (`getUpdateById`).
 * HEURISTIC, UNVERIFIED (docs/verification.md): the transaction's created events are read.
 * - a holding (Amulet or token-standard Holding) owned by `receiver`: `completed`, the receiver has the funds;
 * - a transfer offer or transfer instruction was created: `pending`, the receiver must accept it;
 * - anything else, or a read that fails: `unknown`. The transfer did execute (the wallet said so),
 *   so Mithra records it as paid with a note that acceptance could not be read.
 * The sender's view may not include the receiver's new holding; `unknown` is the safe answer then.
 */
export async function transferOutcome(
  updateId: string,
  receiver: string,
): Promise<TransferOutcome> {
  let update: unknown;
  try {
    const client = await requireClient();
    update = await client.getUpdateById(updateId);
  } catch {
    return 'unknown';
  }
  const created = createdEvents(update);
  if (created.some((e) => HOLDING_TEMPLATE.test(e.templateId) && e.owner === receiver)) {
    return 'completed';
  }
  if (created.some((e) => OFFER_TEMPLATE.test(e.templateId))) return 'pending';
  return 'unknown';
}
