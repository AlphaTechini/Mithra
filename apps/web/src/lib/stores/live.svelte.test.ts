import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { live } from './live.svelte';
import { sessionStore } from './session.svelte';
import { sessionRoutes } from '../../test/treasury/fixtures';
import { FakeEventSource, installFakeEventSource, stubApi } from '../../test/treasury/stub';

beforeEach(() => {
  sessionStore.reset();
  live.reset();
  installFakeEventSource();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  live.reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function signedIn(): Promise<void> {
  stubApi(sessionRoutes('treasurer'));
  await sessionStore.load();
}

describe('live events', () => {
  it('opens one EventSource for all subscribers and dispatches typed events', async () => {
    await signedIn();
    const onCycle = vi.fn();
    const onActivity = vi.fn();
    live.subscribe('cycle', onCycle);
    live.subscribe('activity', onActivity);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.latest.url).toBe('/api/events');

    FakeEventSource.latest.emit({ type: 'cycle', cycleId: '2026-09', status: 'countdown' });
    expect(onCycle).toHaveBeenCalledWith({
      type: 'cycle',
      cycleId: '2026-09',
      status: 'countdown',
    });
    expect(onActivity).not.toHaveBeenCalled();
  });

  it('ignores events that do not match the contract', async () => {
    await signedIn();
    const onCycle = vi.fn();
    live.subscribe('cycle', onCycle);
    FakeEventSource.latest.emit({ type: 'cycle', cycleId: '2026-09', status: 'made-up' });
    expect(onCycle).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe and closes when nobody listens', async () => {
    await signedIn();
    const handler = vi.fn();
    const off = live.subscribe('seal', handler);
    const source = FakeEventSource.latest;
    off();
    source.emit({
      type: 'seal',
      seal: {
        sealId: 's1',
        state: 'sealed',
        treasurerSigned: true,
        nodeConfirmations: null,
        mandateVersion: 1,
        error: null,
      },
    });
    expect(handler).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3500);
    expect(source.readyState).toBe(2);
  });

  it('reconnects with backoff after the connection is closed by an error', async () => {
    await signedIn();
    live.subscribe('cycle', vi.fn());
    const first = FakeEventSource.latest;
    first.open();
    first.fail();
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.latest.fail();
    vi.advanceTimersByTime(1500);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(600);
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it('tells pages to refetch after a reconnect', async () => {
    await signedIn();
    live.subscribe('cycle', vi.fn());
    const onReconnect = vi.fn();
    live.onReconnect(onReconnect);
    FakeEventSource.latest.open();
    expect(onReconnect).not.toHaveBeenCalled();
    FakeEventSource.latest.fail();
    vi.advanceTimersByTime(1000);
    FakeEventSource.latest.open();
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('after a party switch the first open is not a reconnect, so no reconnect handler fires', async () => {
    stubApi({
      ...sessionRoutes('treasurer'),
      'POST /api/session/switch': {
        network: 'localnet',
        testMode: true,
        signedIn: true,
        party: {
          partyId: 'approver1::1220b1',
          displayName: 'Approver 1',
          roles: ['approver'],
          primaryRole: 'approver',
        },
      },
    });
    await sessionStore.load();
    live.subscribe('cycle', vi.fn());
    const onReconnect = vi.fn();
    live.onReconnect(onReconnect);
    FakeEventSource.latest.open();

    await sessionStore.switchParty('approver1::1220b1');
    flushSync();
    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.latest.open();
    expect(onReconnect).not.toHaveBeenCalled();

    // A real drop for the new party is still a reconnect.
    FakeEventSource.latest.fail();
    vi.advanceTimersByTime(1000);
    FakeEventSource.latest.open();
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('a stream closed on purpose and opened again is a first open, not a reconnect', async () => {
    await signedIn();
    live.subscribe('cycle', vi.fn());
    const onReconnect = vi.fn();
    live.onReconnect(onReconnect);
    FakeEventSource.latest.open();
    live.stop();
    live.subscribe('activity', vi.fn());
    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.latest.open();
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it('does not connect when nobody is signed in', () => {
    live.subscribe('cycle', vi.fn());
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
