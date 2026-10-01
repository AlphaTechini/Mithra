import { describe, expect, it } from 'vitest';
import { LedgerClient } from '../../ledger';
import { localnetTestConfig, mainnetTestConfig } from '../../testConfig';
import { createInfrastructureChecker, infrastructureSummary } from './infrastructure';

describe('infrastructureSummary', () => {
  it('says what is running and what waits', () => {
    expect(infrastructureSummary(3, 3, 2)).toBe('Running on 3 of 3 nodes');
    expect(infrastructureSummary(2, 3, 2)).toBe('Still running on 2 of 3 nodes');
    expect(infrastructureSummary(1, 3, 2)).toBe(
      'Below threshold: 1 of 3 nodes online. Payments and approvals wait until a second node is back.',
    );
    expect(infrastructureSummary(0, 3, 2)).toBe(
      'Below threshold: 0 of 3 nodes online. Payments and approvals wait until a node is back.',
    );
  });
});

/** A ledger client whose nodes answer from a table keyed by port. */
function clientFor(
  nodes: Record<string, { version: boolean; parties: string[] }>,
  calls: string[],
) {
  const fetchStub: typeof fetch = (input) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push(`${url.port}${url.pathname}`);
    const node = nodes[url.port];
    if (!node?.version) return Promise.reject(new TypeError('connection refused'));
    if (url.pathname === '/v2/version') return Promise.resolve(Response.json({ version: '3.5.8' }));
    return Promise.resolve(
      Response.json({ partyDetails: node.parties.map((party) => ({ party, isLocal: true })) }),
    );
  };
  return new LedgerClient({
    baseUrl: 'http://localhost:3975',
    userId: 'u',
    tokens: { getToken: () => Promise.resolve(null) },
    fetch: fetchStub,
  });
}

describe('createInfrastructureChecker', () => {
  const config = localnetTestConfig();
  const treasury = config.parties.treasury;

  it('reports each node with operator, online and hosting, and the summary', async () => {
    const calls: string[] = [];
    const client = clientFor(
      {
        '3975': { version: true, parties: [treasury] },
        '2975': { version: true, parties: [treasury] },
        '4975': { version: false, parties: [] },
      },
      calls,
    );
    const checker = createInfrastructureChecker({ config, client });
    const result = await checker.get();
    expect(result).toEqual({
      treasuryParty: treasury,
      hostingThreshold: 2,
      nodes: [
        { id: 'a', name: 'Node A', operator: 'Op A', online: true, hostsTreasury: true },
        { id: 'b', name: 'Node B', operator: 'Op B', online: true, hostsTreasury: true },
        { id: 'c', name: 'Node C', operator: 'Op C', online: false, hostsTreasury: false },
      ],
      summary: 'Still running on 2 of 3 nodes',
    });
  });

  it('does not count the treasury as hosted on a node that does not list it', async () => {
    const client = clientFor(
      {
        '3975': { version: true, parties: [treasury] },
        '2975': { version: true, parties: ['someone::else'] },
        '4975': { version: true, parties: [treasury] },
      },
      [],
    );
    const result = await createInfrastructureChecker({ config, client }).get();
    expect(result.nodes.map((n) => n.hostsTreasury)).toEqual([true, false, true]);
    expect(result.summary).toBe('Running on 3 of 3 nodes');
  });

  it('caches the answer for 30 seconds', async () => {
    let t = 0;
    const calls: string[] = [];
    const client = clientFor(
      {
        '3975': { version: true, parties: [treasury] },
        '2975': { version: true, parties: [treasury] },
        '4975': { version: true, parties: [treasury] },
      },
      calls,
    );
    const checker = createInfrastructureChecker({ config, client, now: () => t });
    await checker.get();
    const first = calls.length;
    t = 29_000;
    await checker.get();
    expect(calls).toHaveLength(first);
    t = 30_001;
    await checker.get();
    expect(calls.length).toBe(first * 2);
  });

  it('has no nodes on MainNet', async () => {
    const checker = createInfrastructureChecker({
      config: mainnetTestConfig(),
      client: clientFor({}, []),
    });
    expect(await checker.get()).toEqual({
      treasuryParty: mainnetTestConfig().parties.treasury,
      hostingThreshold: 1,
      nodes: [],
      summary: "Hosted by the operator's validator on MainNet",
    });
  });
});
