/** Shared fixtures and a fetch stub for the M8 tests. Not imported by any screen. */
import type { HolderPosition, SessionResponse } from '@mithra/shared';
import { vi } from 'vitest';

export const HOLDER_A = {
  partyId: 'holderA::1220aaaa00000000000000000000000000000000000000000000000000000001',
  displayName: 'Holder A',
};

/** A second holder. Nothing of this may ever appear on holder A's screens (U7). */
export const HOLDER_B = {
  partyId: 'holderB::1220bbbb00000000000000000000000000000000000000000000000000000002',
  displayName: 'Holder B',
  units: 7777,
  amount: '4321.5678',
};

export function holderSession(network: 'localnet' | 'mainnet' = 'localnet'): SessionResponse {
  return {
    network,
    testMode: true,
    signedIn: true,
    party: { ...HOLDER_A, roles: ['holder'], primaryRole: 'holder' },
  };
}

export function signedOutSession(network: 'localnet' | 'mainnet' = 'localnet'): SessionResponse {
  return { network, testMode: true, signedIn: false, party: null };
}

export function configFor(network: 'localnet' | 'mainnet' = 'localnet') {
  return {
    network,
    testMode: true,
    payoutRail: network === 'mainnet' ? 'grofty-mainnet' : 'ledger',
    assetSymbol: 'CC',
    explorerTxUrlTemplate: network === 'mainnet' ? 'https://explorer.example/tx/{updateId}' : null,
    groftyMinVersion: '0.2.0',
    demoVideoUrl: null,
  };
}

export function position(overrides: Partial<HolderPosition> = {}): HolderPosition {
  return {
    orgName: 'Northwind Fund',
    assetSymbol: 'CC',
    units: 2500,
    sharePct: '25.0000',
    totalReceived: '1250.5000000000',
    nextPaymentDate: '2026-11-01',
    autoReceive: true,
    pendingUnits: [],
    payments: [],
    ...overrides,
  };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;

/**
 * Stubs `fetch` with a route table keyed by "METHOD /api/path". Unknown routes answer 404 with
 * an API error body. Returns the mock so tests can inspect calls.
 */
// `unknown` is deliberate: a route is either a handler function or a plain JSON body.
export function stubApi(routes: Record<string, unknown>) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    const route = routes[key];
    if (route === undefined) {
      return Promise.resolve(
        json({ error: { code: 'not_found', message: `No route for ${key}` } }, 404),
      );
    }
    if (typeof route === 'function') return Promise.resolve((route as Handler)(init));
    return Promise.resolve(json(route));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export function callsTo(fetchMock: ReturnType<typeof stubApi>, key: string): number {
  return fetchMock.mock.calls.filter(([url, init]) => `${init?.method ?? 'GET'} ${url}` === key)
    .length;
}
