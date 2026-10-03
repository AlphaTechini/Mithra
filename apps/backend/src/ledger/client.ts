import { randomUUID } from 'node:crypto';
import type { TokenProvider } from './auth';
import { LedgerError, ledgerErrorFromResponse, ledgerUnreachable } from './errors';
import { isSecureForCredentials, originOf } from './secureUrl';
import {
  entityOf,
  type ActiveContract,
  type ActiveContractsQuery,
  type ConnectedSynchronizer,
  type InterfaceView,
  type LedgerEvent,
  type PartyDetails,
  type SubmitInput,
  type Transaction,
} from './types';

export interface RetryPolicy {
  /** Total attempts including the first. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/** The part of a WebSocket the client uses; the global `WebSocket` of Node 22 fits. */
export interface WebSocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send(data: string): void;
  close(code?: number): void;
}

/** Opens a WebSocket with the given subprotocols (tests hand in a fake). */
export type WebSocketFactory = (url: string, protocols: string[]) => WebSocketLike;

export interface LedgerClientOptions {
  baseUrl: string;
  /** The ledger user; sent as `userId` in commands. */
  userId: string;
  tokens: TokenProvider;
  /** Per request timeout. Default 30 s. */
  timeoutMs?: number;
  retry?: RetryPolicy;
  fetch?: typeof fetch;
  /** Replaces the real delay between retries (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Replaces the global `WebSocket` used for the active contracts stream (tests). */
  webSocket?: WebSocketFactory;
}

const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 2000 };
const DEFAULT_TIMEOUT_MS = 30_000;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`Ledger response has no ${what}`);
  return value;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function parseInterfaceViews(value: unknown): InterfaceView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v): InterfaceView[] =>
    isObject(v) && typeof v['interfaceId'] === 'string'
      ? [{ interfaceId: v['interfaceId'], viewValue: v['viewValue'] ?? null }]
      : [],
  );
}

function parseCreated(e: JsonObject): Extract<LedgerEvent, { kind: 'created' }> {
  const templateId = str(e['templateId'], 'templateId');
  const blob =
    typeof e['createdEventBlob'] === 'string' && e['createdEventBlob'] !== ''
      ? e['createdEventBlob']
      : undefined;
  return {
    kind: 'created',
    contractId: str(e['contractId'], 'contractId'),
    templateId,
    entity: entityOf(templateId),
    createArgument: e['createArgument'],
    signatories: strings(e['signatories']),
    observers: strings(e['observers']),
    createdAt: str(e['createdAt'], 'createdAt'),
    offset: typeof e['offset'] === 'number' ? e['offset'] : 0,
    ...(blob === undefined ? {} : { createdEventBlob: blob }),
    interfaceViews: parseInterfaceViews(e['interfaceViews']),
  };
}

function parseEvent(raw: unknown): LedgerEvent | undefined {
  if (!isObject(raw)) return undefined;
  const created = raw['CreatedEvent'];
  if (isObject(created)) return parseCreated(created);
  const archived = raw['ArchivedEvent'];
  if (isObject(archived)) {
    const templateId = str(archived['templateId'], 'templateId');
    return {
      kind: 'archived',
      contractId: str(archived['contractId'], 'contractId'),
      templateId,
      entity: entityOf(templateId),
    };
  }
  const exercised = raw['ExercisedEvent'];
  if (isObject(exercised)) {
    const templateId = str(exercised['templateId'], 'templateId');
    return {
      kind: 'exercised',
      contractId: str(exercised['contractId'], 'contractId'),
      templateId,
      entity: entityOf(templateId),
      choice: str(exercised['choice'], 'choice'),
      choiceArgument: exercised['choiceArgument'],
      exerciseResult: exercised['exerciseResult'],
      consuming: exercised['consuming'] === true,
      actingParties: strings(exercised['actingParties']),
    };
  }
  return undefined;
}

export function parseTransaction(raw: unknown): Transaction {
  if (!isObject(raw)) throw new Error('Ledger response has no transaction');
  const events = Array.isArray(raw['events'])
    ? raw['events'].flatMap((e): LedgerEvent[] => {
        const parsed = parseEvent(e);
        return parsed ? [parsed] : [];
      })
    : [];
  return {
    updateId: str(raw['updateId'], 'updateId'),
    ...(typeof raw['commandId'] === 'string' && raw['commandId'] !== ''
      ? { commandId: raw['commandId'] }
      : {}),
    offset: typeof raw['offset'] === 'number' ? raw['offset'] : 0,
    effectiveAt: str(raw['effectiveAt'], 'effectiveAt'),
    recordTime: typeof raw['recordTime'] === 'string' ? raw['recordTime'] : '',
    synchronizerId: typeof raw['synchronizerId'] === 'string' ? raw['synchronizerId'] : '',
    events,
  };
}

function eventFormat(parties: string[], filters: unknown[]): JsonObject {
  const filtersByParty: Record<string, unknown> = {};
  for (const party of parties) filtersByParty[party] = { cumulative: filters };
  return { filtersByParty, verbose: false };
}

const WILDCARD = {
  identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } },
};

/**
 * Client for the JSON Ledger API v2. Everything the application does on the ledger goes through
 * here. Uses the global `fetch`. Retries only network failures and errors the ledger marks
 * retryable; submissions carry a command id that stays the same across retries, so the ledger
 * deduplicates them.
 */
export class LedgerClient {
  readonly baseUrl: string;
  readonly userId: string;
  private readonly tokens: TokenProvider;
  private readonly timeoutMs: number;
  private readonly retry: RetryPolicy;
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly openSocket: WebSocketFactory;

  constructor(options: LedgerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.userId = options.userId;
    this.tokens = options.tokens;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retry = options.retry ?? DEFAULT_RETRY;
    this.doFetch = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.openSocket =
      options.webSocket ??
      ((url, protocols) => new WebSocket(url, protocols) as unknown as WebSocketLike);
  }

  /** A client for another node's JSON Ledger API with the same credentials (status checks). */
  atUrl(
    baseUrl: string,
    overrides: Partial<Pick<LedgerClientOptions, 'timeoutMs' | 'retry'>> = {},
  ): LedgerClient {
    return new LedgerClient({
      baseUrl,
      userId: this.userId,
      tokens: this.tokens,
      timeoutMs: overrides.timeoutMs ?? this.timeoutMs,
      retry: overrides.retry ?? this.retry,
      fetch: this.doFetch,
      sleep: this.sleep,
      webSocket: this.openSocket,
    });
  }

  /** A token goes only to an https URL, or to the same machine. */
  assertSecure(): void {
    if (isSecureForCredentials(this.baseUrl)) return;
    throw new LedgerError({
      code: 'LEDGER_INSECURE_URL',
      message: `The ledger URL ${originOf(this.baseUrl)} is not https, so the ledger token would cross the network in cleartext. Use an https:// URL for LEDGER_JSON_API_URL (a localhost address is the only http exception).`,
      retryable: false,
      status: 0,
    });
  }

  private backoff(attempt: number, policy: RetryPolicy): number {
    return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  }

  /** One HTTP call with bounded retries. Returns the parsed JSON body (undefined for no body). */
  private async call(
    method: 'GET' | 'POST',
    path: string,
    options: {
      json?: unknown;
      bytes?: Uint8Array;
      retry?: RetryPolicy;
    } = {},
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    return this.withRetries(options.retry ?? this.retry, () =>
      this.callOnce(method, url, path, options),
    );
  }

  /** Runs `attempt` again, with backoff, while it fails with a retryable `LedgerError`. */
  private async withRetries<T>(policy: RetryPolicy, attempt: () => Promise<T>): Promise<T> {
    for (let n = 1; ; n += 1) {
      try {
        return await attempt();
      } catch (error) {
        const ledgerError = error instanceof LedgerError ? error : undefined;
        if (!ledgerError?.retryable || n >= policy.maxAttempts) throw error;
        await this.sleep(this.backoff(n, policy));
      }
    }
  }

  private async callOnce(
    method: 'GET' | 'POST',
    url: string,
    path: string,
    options: { json?: unknown; bytes?: Uint8Array },
  ): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const token = await this.tokens.getToken();
    if (token) {
      this.assertSecure();
      headers['authorization'] = `Bearer ${token}`;
    }
    let body: string | Uint8Array | undefined;
    if (options.bytes) {
      headers['content-type'] = 'application/octet-stream';
      body = options.bytes;
    } else if (options.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.json);
    }
    let response: Response;
    try {
      response = await this.doFetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: body as RequestInit['body'] }),
        // A redirect would resend the token to whatever host it names: never follow one.
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      // The path lets a submission that timed out read as "the treasury's nodes did not confirm".
      throw ledgerUnreachable(this.baseUrl, cause, path);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      throw new LedgerError({
        code: 'LEDGER_REDIRECT',
        message: `The ledger at ${this.baseUrl} answered with a redirect (HTTP ${response.status}${location ? ` to ${originOf(location, url)}` : ''}). Mithra does not follow redirects because that could send the ledger token to another host. Set LEDGER_JSON_API_URL to the address the redirect points to.`,
        retryable: false,
        status: response.status,
      });
    }
    const text = await response.text().catch(() => '');
    let parsed: unknown = undefined;
    if (text !== '') {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) throw ledgerErrorFromResponse(response.status, parsed);
    return parsed;
  }

  /** Submits commands and waits for the transaction. */
  async submit(input: SubmitInput): Promise<Transaction> {
    const actAs = [...new Set(input.actAs)];
    const readAs = [...new Set(input.readAs ?? [])].filter((p) => !actAs.includes(p));
    const commands: JsonObject = {
      commandId: input.commandId ?? randomUUID(),
      userId: this.userId,
      actAs,
      readAs,
      commands: input.commands,
      ...(input.disclosedContracts && input.disclosedContracts.length > 0
        ? { disclosedContracts: input.disclosedContracts }
        : {}),
    };
    const body: JsonObject = { commands };
    if (input.shape) {
      body['transactionFormat'] = {
        transactionShape:
          input.shape === 'LEDGER_EFFECTS'
            ? 'TRANSACTION_SHAPE_LEDGER_EFFECTS'
            : 'TRANSACTION_SHAPE_ACS_DELTA',
        eventFormat: eventFormat([...actAs, ...readAs], [WILDCARD]),
      };
    }
    const result = await this.call('POST', '/v2/commands/submit-and-wait-for-transaction', {
      json: body,
    });
    if (!isObject(result)) throw new Error('Ledger response has no transaction');
    return parseTransaction(result['transaction']);
  }

  /** The active contracts the given parties can see, optionally filtered by template/interface. */
  async activeContracts(query: ActiveContractsQuery): Promise<ActiveContract[]> {
    if (query.parties.length === 0) return [];
    const blobs = query.includeBlobs === true;
    const filters: unknown[] = [];
    for (const templateId of query.templateIds ?? []) {
      filters.push({
        identifierFilter: {
          TemplateFilter: { value: { templateId, includeCreatedEventBlob: blobs } },
        },
      });
    }
    for (const interfaceId of query.interfaceIds ?? []) {
      filters.push({
        identifierFilter: {
          InterfaceFilter: {
            value: { interfaceId, includeInterfaceView: true, includeCreatedEventBlob: blobs },
          },
        },
      });
    }
    if (filters.length === 0) {
      filters.push({
        identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: blobs } } },
      });
    }
    const activeAtOffset = await this.ledgerEnd();
    const request = {
      activeAtOffset,
      eventFormat: eventFormat([...new Set(query.parties)], filters),
    };
    let items: unknown[];
    try {
      const result = await this.call('POST', '/v2/state/active-contracts', { json: request });
      items = Array.isArray(result) ? result : [];
    } catch (error) {
      // The HTTP read refuses a result larger than the participant's
      // `http-list-max-elements-limit` (HTTP 413). The stream has no such limit.
      if (!(error instanceof LedgerError) || error.status !== 413) throw error;
      items = await this.withRetries(this.retry, () => this.streamActiveContracts(request));
    }
    const out = new Map<string, ActiveContract>();
    for (const item of items) {
      if (!isObject(item)) continue;
      const entry = item['contractEntry'];
      if (!isObject(entry)) continue;
      const active = entry['JsActiveContract'];
      if (!isObject(active) || !isObject(active['createdEvent'])) continue;
      const created = parseCreated(active['createdEvent']);
      const seen = out.get(created.contractId);
      if (seen) {
        // The same contract can arrive once per queried party: keep what each entry adds.
        for (const view of created.interfaceViews) {
          if (!seen.interfaceViews.some((v) => v.interfaceId === view.interfaceId))
            seen.interfaceViews.push(view);
        }
        if (seen.createdEventBlob === undefined && created.createdEventBlob !== undefined) {
          seen.createdEventBlob = created.createdEventBlob;
        }
        continue;
      }
      out.set(created.contractId, {
        contractId: created.contractId,
        templateId: created.templateId,
        entity: created.entity,
        payload: created.createArgument,
        signatories: created.signatories,
        observers: created.observers,
        createdAt: created.createdAt,
        offset: created.offset,
        synchronizerId:
          typeof active['synchronizerId'] === 'string' ? active['synchronizerId'] : '',
        ...(created.createdEventBlob === undefined
          ? {}
          : { createdEventBlob: created.createdEventBlob }),
        interfaceViews: created.interfaceViews,
      });
    }
    return [...out.values()];
  }

  /**
   * The same read as `POST /v2/state/active-contracts`, over the WebSocket stream of the JSON API
   * (`GET /v2/state/active-contracts` upgraded): the request is the first message, every active
   * contract arrives as one message, and the server closes the stream with code 1000 at the end.
   * Authentication is by subprotocol: `jwt.token.<token>` next to `daml.ws.auth`. The
   * `daml.ws.auth` protocol is also sent without a token, because the server always answers with
   * it and Node's WebSocket fails the handshake when the answer was not asked for.
   */
  private async streamActiveContracts(request: unknown): Promise<unknown[]> {
    const path = '/v2/state/active-contracts';
    const token = await this.tokens.getToken();
    if (token) this.assertSecure();
    const url = `${this.baseUrl.replace(/^http/, 'ws')}${path}`;
    const protocols = token ? [`jwt.token.${token}`, 'daml.ws.auth'] : ['daml.ws.auth'];
    return new Promise<unknown[]>((resolve, reject) => {
      const items: unknown[] = [];
      let settled = false;
      let idle: NodeJS.Timeout | undefined;
      let socket: WebSocketLike | undefined;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(idle);
        try {
          socket?.close();
        } catch {
          // Already closed.
        }
        if (error) reject(error);
        else resolve(items);
      };
      // The timeout is per message, so a large result that keeps arriving is not cut off.
      const arm = (): void => {
        clearTimeout(idle);
        idle = setTimeout(() => {
          finish(
            ledgerUnreachable(
              this.baseUrl,
              Object.assign(new Error('idle'), { name: 'TimeoutError' }),
              path,
            ),
          );
        }, this.timeoutMs);
      };
      try {
        socket = this.openSocket(url, protocols);
      } catch (cause) {
        reject(ledgerUnreachable(this.baseUrl, cause, path));
        return;
      }
      arm();
      socket.onopen = () => {
        arm();
        socket?.send(JSON.stringify(request));
      };
      socket.onmessage = (event) => {
        arm();
        let message: unknown;
        try {
          message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
        } catch {
          finish(
            new Error('The ledger sent a message on the active contracts stream that is not JSON'),
          );
          return;
        }
        // Errors arrive as a message (`{ code, cause, … }`), followed by a normal close.
        if (
          isObject(message) &&
          typeof message['code'] === 'string' &&
          !('contractEntry' in message)
        ) {
          finish(ledgerErrorFromResponse(400, message));
          return;
        }
        items.push(message);
      };
      socket.onerror = (cause) => {
        finish(
          ledgerUnreachable(
            this.baseUrl,
            cause instanceof Error ? cause : new Error('WebSocket error'),
            path,
          ),
        );
      };
      socket.onclose = (event) => {
        if (event.code === 1000) finish();
        else {
          finish(
            new LedgerError({
              code: 'LEDGER_STREAM_CLOSED',
              message: `The ledger closed the active contracts stream early (code ${event.code}${event.reason ? `: ${event.reason}` : ''}). Try again.`,
              retryable: true,
              status: 0,
            }),
          );
        }
      };
    });
  }

  /** Offset of the end of the ledger. */
  async ledgerEnd(): Promise<number> {
    const result = await this.call('GET', '/v2/state/ledger-end');
    if (!isObject(result) || typeof result['offset'] !== 'number') {
      throw new Error('Ledger response has no offset');
    }
    return result['offset'];
  }

  /**
   * Allocates a local party. A freshly started node needs a while before it accepts party
   * allocation (no connected synchronizer yet), so this waits up to about 30 seconds.
   */
  async allocateParty(hint: string): Promise<string> {
    const result = await this.call('POST', '/v2/parties', {
      json: { partyIdHint: hint, identityProviderId: '' },
      retry: { maxAttempts: 16, baseDelayMs: 2000, maxDelayMs: 2000 },
    });
    const details = isObject(result) ? result['partyDetails'] : undefined;
    if (!isObject(details)) throw new Error('Ledger response has no partyDetails');
    return str(details['party'], 'party');
  }

  async listParties(): Promise<PartyDetails[]> {
    const parties: PartyDetails[] = [];
    let pageToken = '';
    do {
      const query = pageToken === '' ? '' : `?pageToken=${encodeURIComponent(pageToken)}`;
      const result = await this.call('GET', `/v2/parties${query}`);
      if (!isObject(result)) break;
      const details = Array.isArray(result['partyDetails']) ? result['partyDetails'] : [];
      for (const d of details) {
        if (isObject(d) && typeof d['party'] === 'string') {
          parties.push({ party: d['party'], isLocal: d['isLocal'] === true });
        }
      }
      pageToken = typeof result['nextPageToken'] === 'string' ? result['nextPageToken'] : '';
    } while (pageToken !== '');
    return parties;
  }

  /** Grants a ledger user act-as and read-as rights for parties. */
  async grantRights(userId: string, actAs: string[], readAs: string[]): Promise<void> {
    const rights = [
      ...actAs.map((party) => ({ kind: { CanActAs: { value: { party } } } })),
      ...readAs.map((party) => ({ kind: { CanReadAs: { value: { party } } } })),
    ];
    if (rights.length === 0) return;
    await this.call('POST', `/v2/users/${encodeURIComponent(userId)}/rights`, {
      json: { userId, rights },
    });
  }

  /** Uploads a DAR (raw bytes) to the participant. */
  async uploadDar(bytes: Uint8Array): Promise<void> {
    await this.call('POST', '/v2/dars', { bytes });
  }

  /** The ledger's version string and the raw response. */
  async version(): Promise<{ version: string }> {
    const result = await this.call('GET', '/v2/version');
    if (!isObject(result) || typeof result['version'] !== 'string') {
      throw new Error('Ledger response has no version');
    }
    return { version: result['version'] };
  }

  async connectedSynchronizers(): Promise<ConnectedSynchronizer[]> {
    const result = await this.call('GET', '/v2/state/connected-synchronizers');
    const list =
      isObject(result) && Array.isArray(result['connectedSynchronizers'])
        ? result['connectedSynchronizers']
        : [];
    return list.flatMap((s): ConnectedSynchronizer[] =>
      isObject(s) && typeof s['synchronizerId'] === 'string'
        ? [
            {
              synchronizerAlias:
                typeof s['synchronizerAlias'] === 'string' ? s['synchronizerAlias'] : '',
              synchronizerId: s['synchronizerId'],
            },
          ]
        : [],
    );
  }

  /** A transaction by its update id, as seen by `parties`. */
  async updateById(updateId: string, parties: string[]): Promise<Transaction> {
    const result = await this.call('POST', '/v2/updates/update-by-id', {
      json: {
        updateId,
        updateFormat: {
          includeTransactions: {
            eventFormat: eventFormat(parties, [WILDCARD]),
            transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS',
          },
        },
      },
    });
    const update = isObject(result) ? result['update'] : undefined;
    const wrapper = isObject(update) ? update['Transaction'] : undefined;
    const value = isObject(wrapper) ? wrapper['value'] : undefined;
    return parseTransaction(value);
  }

  /**
   * When `contractId` was created and archived, as seen by `parties`. Throws a `LedgerError` with
   * status 404 when none of the parties can see the contract.
   */
  async eventsByContractId(contractId: string, parties: string[]): Promise<ContractEvents> {
    const result = await this.call('POST', '/v2/events/events-by-contract-id', {
      json: { contractId, eventFormat: eventFormat(parties, [WILDCARD]) },
    });
    const body = isObject(result) ? result : {};
    const offsetOf = (side: unknown, key: string): number | null => {
      if (!isObject(side)) return null;
      const event = side[key];
      return isObject(event) && typeof event['offset'] === 'number' ? event['offset'] : null;
    };
    return {
      createdAtOffset: offsetOf(body['created'], 'createdEvent'),
      archivedAtOffset: offsetOf(body['archived'], 'archivedEvent'),
    };
  }

  /** The transaction at a ledger offset (with exercise events), as seen by `parties`. */
  async updateByOffset(offset: number, parties: string[]): Promise<Transaction> {
    const result = await this.call('POST', '/v2/updates/update-by-offset', {
      json: {
        offset,
        updateFormat: {
          includeTransactions: {
            eventFormat: eventFormat(parties, [WILDCARD]),
            transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS',
          },
        },
      },
    });
    const update = isObject(result) ? result['update'] : undefined;
    const wrapper = isObject(update) ? update['Transaction'] : undefined;
    const value = isObject(wrapper) ? wrapper['value'] : undefined;
    return parseTransaction(value);
  }
}

/** The events of one contract as the queried parties see them (`/v2/events/events-by-contract-id`). */
export interface ContractEvents {
  /** Offset of the transaction that created the contract. */
  createdAtOffset: number | null;
  /** Offset of the transaction that archived it; null while the contract is active. */
  archivedAtOffset: number | null;
}

/** Contracts created by a transaction, optionally only of one entity (`Module:Entity`). */
export function createdIn(tx: Transaction, entity?: string) {
  return tx.events.filter(
    (e): e is Extract<LedgerEvent, { kind: 'created' }> =>
      e.kind === 'created' && (entity === undefined || e.entity === entity),
  );
}

/**
 * The result of the first exercise of `choice` in a LEDGER_EFFECTS transaction. Throws if the
 * transaction was not requested with that shape or the choice was not exercised.
 */
export function exerciseResultOf(tx: Transaction, choice: string): unknown {
  const event = tx.events.find(
    (e): e is Extract<LedgerEvent, { kind: 'exercised' }> =>
      e.kind === 'exercised' && e.choice === choice,
  );
  if (!event) {
    throw new Error(
      `The transaction has no exercise of ${choice}; submit with shape LEDGER_EFFECTS to read choice results`,
    );
  }
  return event.exerciseResult;
}
