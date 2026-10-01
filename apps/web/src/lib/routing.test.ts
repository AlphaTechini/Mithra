import type { SessionResponse } from '@mithra/shared';
import { describe, expect, it } from 'vitest';
import { homeFor, localnetHomeFor, redirectFor } from './routing';

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

describe('localnetHomeFor', () => {
  it('takes the demo party "Auditor" without a role to the Audit workspace', () => {
    expect(localnetHomeFor({ displayName: 'Auditor', primaryRole: null })).toBe('/auditor');
  });

  it('leaves every other party where homeFor sends it', () => {
    expect(localnetHomeFor({ displayName: 'Holder A', primaryRole: null })).toBe('/start');
    expect(localnetHomeFor({ displayName: 'Auditor', primaryRole: 'auditor' })).toBe('/auditor');
    expect(localnetHomeFor({ displayName: 'Auditor', primaryRole: 'holder' })).toBe('/holder');
    expect(localnetHomeFor({ displayName: 'Treasurer', primaryRole: 'treasurer' })).toBe(
      '/app/overview',
    );
    expect(localnetHomeFor(null)).toBe('/start');
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

  it('lets a party with no role into a layout that lists null (the auditor workspace)', () => {
    expect(redirectFor(session({}), ['auditor', null])).toBeNull();
    expect(redirectFor(holder, ['auditor', null])).toBe('/holder');
    expect(redirectFor(session({}), ['auditor'])).toBe('/start');
  });
});
