import { describe, expect, it } from 'vitest';
import { EventBus, inAudience, TREASURY_TEAM } from './bus';

describe('EventBus', () => {
  it('delivers to subscribers until they unsubscribe', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const off = bus.subscribe(({ event }) => seen.push(event.type));
    bus.publish({ type: 'cycle', cycleId: '2026-09', status: 'running' }, TREASURY_TEAM);
    off();
    bus.publish({ type: 'cycle', cycleId: '2026-09', status: 'paid-automatically' }, TREASURY_TEAM);
    expect(seen).toEqual(['cycle']);
  });

  it('matches audiences by role or party', () => {
    expect(inAudience(TREASURY_TEAM, 'p', ['approver'])).toBe(true);
    expect(inAudience(TREASURY_TEAM, 'p', ['holder'])).toBe(false);
    expect(inAudience({ parties: ['holder-a'] }, 'holder-a', ['holder'])).toBe(true);
    expect(inAudience({ parties: ['holder-a'] }, 'holder-b', ['holder'])).toBe(false);
  });
});
