import { randomUUID } from 'node:crypto';
import type { TokenProvider } from './auth';
import { LedgerError, ledgerErrorFromResponse, ledgerUnreachable } from './errors';
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

  constructor(options: LedgerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.userId = options.userId;
    this.tokens = options.tokens;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retry = options.retry ?? DEFAULT_RETRY;
    this.doFetch = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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
    const policy = options.retry ?? this.retry;
    const url = `${this.baseUrl}${path}`;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.callOnce(method, url, options);
      } catch (error) {
        const ledgerError = error instanceof LedgerError ? error : undefined;
        if (!ledgerError?.retryable || attempt >= policy.maxAttempts) throw error;
        await this.sleep(this.backoff(attempt, policy));
      }
    }
  }

  private async callOnce(
    method: 'GET' | 'POST',
    url: string,
    options: { json?: unknown; bytes?: Uint8Array },
  ): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const token = await this.tokens.getToken();
    if (token) headers['authorization'] = `Bearer ${token}`;
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
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw ledgerUnreachable(this.baseUrl, cause);
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
    const result = await this.call('POST', '/v2/state/active-contracts', {
      json: { activeAtOffset, eventFormat: eventFormat([...new Set(query.parties)], filters) },
    });
    const items = Array.isArray(result) ? result : [];
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
