/**
 * Test helpers for the treasurer screens: a `fetch` stub that routes `METHOD /api/path` to
 * handlers and records every call, and a fake `EventSource` so tests can push live events.
 */
import { vi } from 'vitest';

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

export type RouteHandler = (call: RecordedCall) => unknown;

export interface ApiStub {
  calls: RecordedCall[];
  /** Replace or add a route: "GET /api/cycles/2026-09". */
  route(key: string, handler: unknown): void;
  /** Calls made to a route, in order. */
  callsTo(key: string): RecordedCall[];
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

/** Installs the stub as the global `fetch`. Values may be data, a Response, or a function of the call. */
export function stubApi(routes: Record<string, unknown>): ApiStub {
  const table = new Map<string, unknown>(Object.entries(routes));
  const calls: RecordedCall[] = [];

  const stub = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown = undefined;
    if (typeof init?.body === 'string') body = JSON.parse(init.body) as unknown;
    const call: RecordedCall = { method, path: url.pathname + url.search, body };
    calls.push(call);

    // A handler for the exact query wins over the one for the bare path.
    const handler =
      table.get(`${method} ${url.pathname}${url.search}`) ?? table.get(`${method} ${url.pathname}`);
    if (handler === undefined) {
      return Promise.resolve(
        errorResponse(404, 'not_found', `No stub for ${method} ${url.pathname}`),
      );
    }
    const result = typeof handler === 'function' ? (handler as RouteHandler)(call) : handler;
    return Promise.resolve(result).then((value) =>
      value instanceof Response ? value : jsonResponse(value),
    );
  });
  vi.stubGlobal('fetch', stub);

  return {
    calls,
    route(key, handler) {
      table.set(key, handler);
    },
    callsTo(key) {
      const [method, path] = key.split(' ') as [string, string];
      return calls.filter((c) => c.method === method && c.path.split('?')[0] === path);
    },
  };
}

/** A promise you resolve by hand, to delay a response (for example to test U3). */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

type Listener = (event: MessageEvent<string>) => void;

/** A minimal EventSource that tests drive with `emit`. */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static reset(): void {
    FakeEventSource.instances = [];
  }
  readonly url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.readyState = 2;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  /** Deliver a live event the way the backend sends it: `event:` is the type, `data:` the JSON. */
  emit(event: { type: string } & Record<string, unknown>): void {
    // Like a real EventSource: nothing is delivered once it is closed (or before it is open).
    if (this.readyState !== 1) return;
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(new MessageEvent(event.type, { data: JSON.stringify(event) }));
    }
  }
  fail(): void {
    this.readyState = 2;
    this.onerror?.();
  }

  static get latest(): FakeEventSource {
    const last = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    if (!last) throw new Error('No EventSource was opened');
    return last;
  }
}

export function installFakeEventSource(): void {
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
}
