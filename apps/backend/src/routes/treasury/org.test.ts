import { describe, expect, it } from 'vitest';
import type { Contract, MithraPayloads } from '../../ledger';
import { setupStepOf } from './org';

const at = '2026-10-01T00:00:00Z';
const charter: Contract<MithraPayloads['TreasuryCharter']> = {
  contractId: 'c',
  createdAt: at,
  payload: { treasury: 't', treasurer: 'tr', agent: 'a', operator: 'o' },
};
const organization = { contractId: 'o', createdAt: at } as Contract<MithraPayloads['Organization']>;
const mandate = { contractId: 'm', createdAt: at } as Contract<MithraPayloads['Mandate']>;

describe('setupStepOf', () => {
  it('follows the ledger: charter, organization, policy, done', () => {
    expect(setupStepOf({ charter: null, organization: null, mandate: null })).toBe('charter');
    expect(setupStepOf({ charter, organization: null, mandate: null })).toBe('organization');
    expect(setupStepOf({ charter: null, organization, mandate: null })).toBe('policy');
    expect(setupStepOf({ charter: null, organization, mandate })).toBe('done');
  });
});
