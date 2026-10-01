import type { SessionResponse } from '@mithra/shared';
import { describe, expect, it } from 'vitest';
import { homeFor, redirectFor } from './routing';

describe('homeFor', () => {
  it('routes each primary role to its home', () => {
    expect(homeFor('treasurer')).toBe('/app/overview');
    expect(homeFor('approver')).toBe('/app/approvals');
    expect(homeFor('holder')).toBe('/holder');
    expect(homeFor('auditor')).toBe('/auditor');
  });

  it('sends an unknown party to /start', () => {
    expect(homeFor(null)).toBe('/start');
    expect(homeFor(undefined)).toBe('/start');
  });
});

function session(partial: Partial<SessionResponse>): SessionResponse {
  return { network: 'localnet', testMode: true, signedIn: true, party: null, ...partial };
}

describe('redirectFor', () => {
  const treasurer = session({
    party: {
      partyId: 'p::1',
      displayName: 'Treasurer',
      roles: ['treasurer'],
      primaryRole: 'treasurer',
    },
  });
  const holder = session({
    party: { partyId: 'h::1', displayName: 'Holder A', roles: ['holder'], primaryRole: 'holder' },
  });

  it('sends a signed-out visitor to /launch', () => {
    expect(redirectFor(null, ['treasurer'])).toBe('/launch');
    expect(redirectFor(session({ signedIn: false }), 'any')).toBe('/launch');
  });

  it('lets a matching role stay', () => {
    expect(redirectFor(treasurer, ['treasurer', 'approver'])).toBeNull();
    expect(redirectFor(holder, 'any')).toBeNull();
  });

  it('sends another role to its own home', () => {
    expect(redirectFor(holder, ['treasurer', 'approver'])).toBe('/holder');
    expect(redirectFor(treasurer, ['holder'])).toBe('/app/overview');
  });

  it('sends an unknown party to /start', () => {
    expect(redirectFor(session({}), ['treasurer'])).toBe('/start');
  });
});
