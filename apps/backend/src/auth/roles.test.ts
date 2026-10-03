import { describe, expect, it } from 'vitest';
import type { RoleFacts } from '../ledger';
import { computeRoles } from './roles';

const contract = <T>(payload: T) => ({
  contractId: '00x',
  payload,
  createdAt: '2026-10-01T00:00:00Z',
});

const base = { treasury: 't', treasurer: 'r', agent: 'g' };

function facts(overrides: Partial<RoleFacts> = {}): RoleFacts {
  return {
    organization: contract({
      ...base,
      operator: 'o',
      name: 'Acme',
      asset: { admin: 'dso', id: 'Amulet' },
      approvers: ['a1', 'a2'],
      approvalThreshold: 2,
      mandateVersion: 1,
    }),
    register: contract({
      ...base,
      changes: [
        {
          holder: 'h1',
          delta: 100,
          effectiveDate: '2026-01-01',
          recordedAt: '2026-01-01T00:00:00Z',
          seeded: false,
        },
        {
          holder: 'h2',
          delta: 50,
          effectiveDate: '2026-01-01',
          recordedAt: '2026-01-01T00:00:00Z',
          seeded: false,
        },
        {
          holder: 'h2',
          delta: -50,
          effectiveDate: '2026-02-01',
          recordedAt: '2026-02-01T00:00:00Z',
          seeded: false,
        },
        {
          holder: 'r',
          delta: 10,
          effectiveDate: '2026-02-01',
          recordedAt: '2026-02-01T00:00:00Z',
          seeded: false,
        },
      ],
    }),
    auditRequests: [],
    grants: [],
    closed: [],
    denied: [],
    ...overrides,
  };
}

const none = new Set<string>();

describe('computeRoles', () => {
  it('finds the treasurer, approvers and holders from the ledger', () => {
    expect(computeRoles('r', facts(), none).roles).toEqual(['treasurer', 'holder']);
    expect(computeRoles('a1', facts(), none)).toEqual({
      roles: ['approver'],
      primaryRole: 'approver',
    });
    expect(computeRoles('h1', facts(), none)).toEqual({ roles: ['holder'], primaryRole: 'holder' });
  });

  it('does not make a party with a zero balance a holder', () => {
    expect(computeRoles('h2', facts(), none)).toEqual({ roles: [], primaryRole: null });
  });

  it('orders the primary role treasurer, approver, auditor, holder', () => {
    const f = facts({
      auditRequests: [
        contract({
          ...base,
          auditor: 'r',
          requestId: 'q',
          question: '',
          scope: [],
          excluded: '',
          requestedAt: '2026-10-01T00:00:00Z',
        }),
      ],
    });
    expect(computeRoles('r', f, none)).toEqual({
      roles: ['treasurer', 'auditor', 'holder'],
      primaryRole: 'treasurer',
    });
    const f2 = facts({
      organization: contract({
        ...base,
        operator: 'o',
        name: 'Acme',
        asset: { admin: 'dso', id: 'Amulet' },
        approvers: ['h1'],
        approvalThreshold: 1,
        mandateVersion: 1,
      }),
    });
    expect(computeRoles('h1', f2, none)).toEqual({
      roles: ['approver', 'holder'],
      primaryRole: 'approver',
    });
  });

  it('makes the auditor of any request, grant, closed grant or denial an auditor', () => {
    const grant = {
      ...base,
      auditor: 'u1',
      grantId: 'g',
      requestId: 'q',
      question: '',
      recordIds: [],
      sharedCids: [],
      grantedAt: '2026-10-01T00:00:00Z',
      expiresAt: '2026-10-02T00:00:00Z',
    };
    expect(computeRoles('u1', facts({ grants: [contract(grant)] }), none).primaryRole).toBe(
      'auditor',
    );
    const closed = {
      ...base,
      auditor: 'u2',
      grantId: 'g',
      requestId: 'q',
      closedAt: '2026-10-01T00:00:00Z',
      closedBy: 'g',
      reason: 'expired',
    };
    expect(computeRoles('u2', facts({ closed: [contract(closed)] }), none).primaryRole).toBe(
      'auditor',
    );
    const denied = {
      ...base,
      auditor: 'u3',
      requestId: 'q',
      reason: 'no',
      at: '2026-10-01T00:00:00Z',
    };
    expect(computeRoles('u3', facts({ denied: [contract(denied)] }), none).primaryRole).toBe(
      'auditor',
    );
  });

  it('makes a party with an unused auditor invite an auditor', () => {
    expect(computeRoles('newcomer', facts(), new Set(['newcomer']))).toEqual({
      roles: ['auditor'],
      primaryRole: 'auditor',
    });
  });

  it('gives an unknown party no roles, also before an organization exists', () => {
    expect(computeRoles('stranger', facts(), none)).toEqual({ roles: [], primaryRole: null });
    const empty: RoleFacts = {
      organization: null,
      register: null,
      auditRequests: [],
      grants: [],
      closed: [],
      denied: [],
    };
    expect(computeRoles('r', empty, none)).toEqual({ roles: [], primaryRole: null });
  });
});
