/**
 * Live updates from the backend over Server-Sent Events (`GET /api/events`). One EventSource is
 * shared by the whole app and is opened when the first page subscribes and a party is signed in.
 * It reconnects with backoff, reconnects as the new party after a role switch, and closes on
 * sign-out. Events never carry data the viewer could not fetch: pages treat them as "something
 * changed, refetch" (or patch the one field the event carries, like a timeline step).
 */
import { LiveEventSchema, type LiveEvent } from '@mithra/shared';
import { sessionStore } from './session.svelte';

type EventType = LiveEvent['type'];
type Handler<T extends EventType> = (event: Extract<LiveEvent, { type: T }>) => void;
type AnyHandler = (event: LiveEvent) => void;

const EVENT_TYPES: readonly EventType[] = [
  'timeline',
  'cycle',
  'seal',
  'activity',
  'agent',
  'holder',
  'audit',
];
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000] as const;

const handlers: Partial<Record<EventType, AnyHandler[]>> = {};
let reconnectHandlers: (() => void)[] = [];
const state = $state({ connected: false });

let source: EventSource | null = null;
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let connectedAs: string | null = null;
let watcher: (() => void) | null = null;
let hadOpen = false;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function subscriberCount(): number {
  return EVENT_TYPES.reduce((n, type) => n + (handlers[type]?.length ?? 0), 0);
}

function addHandler(type: EventType, handler: AnyHandler): void {
  (handlers[type] ??= []).push(handler);
}

function removeHandler(type: EventType, handler: AnyHandler): void {
  handlers[type] = (handlers[type] ?? []).filter((h) => h !== handler);
}

function close(): void {
  if (retryTimer !== undefined) clearTimeout(retryTimer);
  retryTimer = undefined;
  source?.close();
  source = null;
  state.connected = false;
  connectedAs = null;
  // A stream closed on purpose (sign-out, party switch, no subscribers) starts over: the next
  // open is a first open, not a reconnect, and must not fire the reconnect handlers.
  hadOpen = false;
}

function dispatch(raw: string): void {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return;
  }
  const parsed = LiveEventSchema.safeParse(json);
  if (!parsed.success) return;
  for (const handler of [...(handlers[parsed.data.type] ?? [])]) handler(parsed.data);
}

function open(): void {
  if (typeof EventSource === 'undefined') return;
  const partyId = sessionStore.session?.signedIn ? (sessionStore.party?.partyId ?? null) : null;
  if (partyId === null || subscriberCount() === 0) return;
  if (source && connectedAs === partyId) return;
  // Reopening for the same party after a drop is a reconnect; any other open is not.
  const reconnecting = hadOpen && connectedAs === partyId;
  close();
  hadOpen = reconnecting;
  connectedAs = partyId;
  const es = new EventSource('/api/events');
  source = es;
  es.onopen = () => {
    state.connected = true;
    retry = 0;
    // After a reconnect, anything may have changed while we were away.
    if (hadOpen) for (const handler of reconnectHandlers) handler();
    hadOpen = true;
  };
  for (const type of EVENT_TYPES) {
    es.addEventListener(type, (event) => dispatch((event as MessageEvent<string>).data));
  }
  es.onerror = () => {
    state.connected = false;
    if (source !== es) return;
    // The browser retries on its own for network drops, but a closed source (an HTTP error
    // such as an expired session) needs a fresh one.
    if (es.readyState === 2) {
      es.close();
      source = null;
      const delay = BACKOFF_MS[Math.min(retry, BACKOFF_MS.length - 1)] ?? 15000;
      retry++;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        open();
      }, delay);
    }
  };
}

function ensureWatcher(): void {
  if (watcher) return;
  // Follow the session: a role switch reconnects as the new party; sign-out closes the stream.
  watcher = $effect.root(() => {
    $effect(() => {
      const signedIn = sessionStore.session?.signedIn ?? false;
      const partyId = sessionStore.party?.partyId ?? null;
      if (!signedIn || partyId === null) {
        close();
        return;
      }
      if (connectedAs !== null && connectedAs !== partyId) close();
      open();
    });
  });
}

export const live = {
  get connected(): boolean {
    return state.connected;
  },

  /** Listen for one event type. Returns the unsubscribe function (use it as an `$effect` cleanup). */
  subscribe<T extends EventType>(type: T, handler: Handler<T>): () => void {
    const entry = handler as AnyHandler;
    addHandler(type, entry);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
    ensureWatcher();
    open();
    return () => {
      removeHandler(type, entry);
      if (subscriberCount() === 0 && idleTimer === undefined) {
        // Moving between pages unsubscribes and resubscribes; keep the stream through that.
        idleTimer = setTimeout(() => {
          idleTimer = undefined;
          if (subscriberCount() === 0) close();
        }, 3000);
      }
    };
  },

  /** Called when the stream comes back after a drop, so pages can refetch what they missed. */
  onReconnect(handler: () => void): () => void {
    reconnectHandlers.push(handler);
    return () => {
      reconnectHandlers = reconnectHandlers.filter((h) => h !== handler);
    };
  },

  /** Close the stream now, for example on sign-out. It reopens on the next subscription. */
  stop(): void {
    close();
  },

  /** Test helper: drop every subscriber and the connection. */
  reset(): void {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
    close();
    hadOpen = false;
    for (const type of EVENT_TYPES) delete handlers[type];
    reconnectHandlers = [];
    watcher?.();
    watcher = null;
    retry = 0;
  },
};
