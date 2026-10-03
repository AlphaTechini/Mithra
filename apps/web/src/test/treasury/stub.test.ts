import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeEventSource, stubApi } from './stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('stubApi', () => {
  it('prefers the handler for the exact query over the one for the bare path', async () => {
    stubApi({
      'GET /api/items': { which: 'path' },
      'GET /api/items?page=2': { which: 'query' },
    });
    const bare = (await (await fetch('/api/items')).json()) as { which: string };
    const paged = (await (await fetch('/api/items?page=2')).json()) as { which: string };
    const other = (await (await fetch('/api/items?page=3')).json()) as { which: string };
    expect(bare.which).toBe('path');
    expect(paged.which).toBe('query');
    expect(other.which).toBe('path');
  });
});

describe('FakeEventSource', () => {
  function listen(source: FakeEventSource): ReturnType<typeof vi.fn> {
    const listener = vi.fn();
    source.addEventListener('cycle', listener);
    return listener;
  }

  it('delivers only while open', () => {
    FakeEventSource.reset();
    const source = new FakeEventSource('/api/events');
    const listener = listen(source);
    source.emit({ type: 'cycle' });
    expect(listener).not.toHaveBeenCalled();
    source.open();
    source.emit({ type: 'cycle' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('dispatches nothing after close()', () => {
    FakeEventSource.reset();
    const source = new FakeEventSource('/api/events');
    const listener = listen(source);
    source.open();
    source.close();
    source.emit({ type: 'cycle' });
    expect(listener).not.toHaveBeenCalled();
  });
});
