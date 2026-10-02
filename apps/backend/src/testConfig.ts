import type { Config } from './config/env';

/** Complete configurations for unit tests. Not used by the application. */
export function localnetTestConfig(overrides: Partial<Config> = {}): Config {
  const config: Config = {
    network: 'localnet',
    host: '127.0.0.1',
    port: 0,
    webOrigin: 'http://localhost:5173',
    webDistDir: undefined,
    logLevel: 'silent',
    databaseUrl: 'postgres://x@localhost/x',
    sessionSecret: 'unit-test-session-secret-0123456789ab',
    llm: { baseUrl: 'https://api.openai.com/v1', apiKey: 'key', model: 'model', timeoutMs: 30000 },
    ledger: {
      jsonApiUrl: 'http://localhost:7575',
      userId: 'ledger-api-user',
      auth: { mode: 'unsafe-hmac', secret: 'unsafe', audience: 'https://canton.network.global' },
      mithraPackage: '#mithra-v1',
      readAsTreasury: true,
    },
    parties: { treasury: 'treasury::1220aa', agent: 'agent::1220aa', operator: 'operator::1220aa' },
    asset: { adminParty: 'dso::1220aa', id: 'Amulet', symbol: 'CC' },
    registryUrl: 'http://localhost:3000/api/validator/v0/scan-proxy',
    localnet: {
      demoPassword: 'demo',
      demoParties: [{ partyId: 'treasurer::1220aa', displayName: 'Treasurer' }],
      nodes: [
        {
          id: 'a',
          name: 'Node A',
          operator: 'Op A',
          jsonApiUrl: 'http://localhost:3975',
          decmanUrl: 'http://localhost:8081',
          autoConfirm: true,
        },
        {
          id: 'b',
          name: 'Node B',
          operator: 'Op B',
          jsonApiUrl: 'http://localhost:2975',
          decmanUrl: 'http://localhost:8082',
          autoConfirm: true,
        },
        {
          id: 'c',
          name: 'Node C',
          operator: 'Op C',
          jsonApiUrl: 'http://localhost:4975',
          decmanUrl: 'http://localhost:8083',
          autoConfirm: false,
        },
      ],
      decmanGovernanceThreshold: 2,
      decmanGovernanceRulesCid: '00rules',
      decmanMemberParties: {
        a: 'member-a::1220aa',
        b: 'member-b::1220aa',
        c: 'member-c::1220aa',
      },
    },
  };
  return { ...config, ...overrides } as Config;
}

/** MainNet payouts: the records stay on the LocalNet ledger, so everything of LocalNet is there too. */
export function mainnetTestConfig(overrides: Partial<Config> = {}): Config {
  const { localnet, ...rest } = localnetTestConfig();
  if (!localnet) throw new Error('The LocalNet test config has no localnet section');
  return {
    ...rest,
    network: 'mainnet',
    localnet,
    mainnet: { explorerTxUrl: 'https://explorer.example/tx/{updateId}', groftyMinVersion: '2.0.4' },
    ...overrides,
  } as Config;
}
