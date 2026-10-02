import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, ENV_DESCRIPTIONS, loadConfig, loadDotEnv } from './env';

const PARTY = (name: string): string => `${name}::1220abcdef`;

const nodes = JSON.stringify([
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
]);

const common = {
  DATABASE_URL: 'postgres://x@localhost/x',
  SESSION_SECRET: 's'.repeat(32),
  LLM_API_KEY: 'key',
  LLM_MODEL: 'model',
  LEDGER_JSON_API_URL: 'http://localhost:3975',
  LEDGER_USER_ID: 'ledger-api-user',
  LEDGER_AUDIENCE: 'https://canton.network.global',
  TREASURY_PARTY: PARTY('treasury'),
  AGENT_PARTY: PARTY('agent'),
  OPERATOR_PARTY: PARTY('operator'),
  ASSET_ADMIN_PARTY: PARTY('dso'),
  REGISTRY_URL: 'http://localhost:3000/api/validator/v0/scan-proxy',
};

const localnet = {
  ...common,
  NETWORK: 'localnet',
  LOCALNET_DEMO_PASSWORD: 'demo',
  LOCALNET_DEMO_PARTIES: JSON.stringify([
    { partyId: PARTY('treasurer'), displayName: 'Treasurer' },
  ]),
  LOCALNET_NODES: nodes,
  DECMAN_GOVERNANCE_RULES_CID: '00rulescid',
  DECMAN_MEMBER_PARTIES: JSON.stringify({ a: PARTY('member-a'), b: PARTY('member-b') }),
};

// MainNet means "MainNet payouts": the records stay on LocalNet, so it needs everything LocalNet needs.
const mainnet = {
  ...localnet,
  NETWORK: 'mainnet',
  MAINNET_EXPLORER_TX_URL: 'https://explorer.example/tx/{updateId}',
};

function errorOf(env: NodeJS.ProcessEnv): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig on localnet', () => {
  it('applies defaults', () => {
    expect(loadConfig(localnet)).toEqual({
      network: 'localnet',
      host: '0.0.0.0',
      port: 8787,
      webOrigin: 'http://localhost:5173',
      webDistDir: undefined,
      logLevel: 'info',
      holdCountdownSeconds: 30,
      databaseUrl: 'postgres://x@localhost/x',
      sessionSecret: 's'.repeat(32),
      llm: {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'key',
        model: 'model',
        timeoutMs: 30000,
        strictTools: false,
        maxToolRounds: 4,
      },
      ledger: {
        jsonApiUrl: 'http://localhost:3975',
        userId: 'ledger-api-user',
        auth: { mode: 'unsafe-hmac', secret: 'unsafe', audience: 'https://canton.network.global' },
        mithraPackage: '#mithra-v1',
        readAsTreasury: true,
      },
      parties: { treasury: PARTY('treasury'), agent: PARTY('agent'), operator: PARTY('operator') },
      asset: { adminParty: PARTY('dso'), id: 'Amulet', symbol: 'CC' },
      registryUrl: 'http://localhost:3000/api/validator/v0/scan-proxy',
      localnet: {
        demoPassword: 'demo',
        demoParties: [{ partyId: PARTY('treasurer'), displayName: 'Treasurer' }],
        nodes: JSON.parse(nodes) as unknown[],
        decmanGovernanceThreshold: 2,
        decmanGovernanceRulesCid: '00rulescid',
        decmanMemberParties: { a: PARTY('member-a'), b: PARTY('member-b') },
      },
    });
  });

  it('reads explicit values', () => {
    const config = loadConfig({
      ...localnet,
      PORT: '9000',
      HOST: '127.0.0.1',
      WEB_DIST_DIR: 'apps/web/build',
      LOG_LEVEL: 'debug',
      LLM_BASE_URL: 'http://localhost:11434/v1',
      LLM_TIMEOUT_MS: '5000',
      LLM_STRICT_TOOLS: 'true',
      LLM_MAX_TOOL_ROUNDS: '2',
      MITHRA_PACKAGE: '#mithra-v2',
      LEDGER_AUTH_MODE: 'none',
      LOCALNET_READ_AS_TREASURY: 'false',
      DECMAN_GOVERNANCE_THRESHOLD: '3',
      HOLD_COUNTDOWN_SECONDS: '5',
      ASSET_ID: 'USDCx',
      ASSET_SYMBOL: 'USDC',
    });
    expect(config).toMatchObject({
      port: 9000,
      host: '127.0.0.1',
      webDistDir: 'apps/web/build',
      logLevel: 'debug',
      llm: {
        baseUrl: 'http://localhost:11434/v1',
        timeoutMs: 5000,
        strictTools: true,
        maxToolRounds: 2,
      },
      ledger: { auth: { mode: 'none' }, mithraPackage: '#mithra-v2', readAsTreasury: false },
      asset: { id: 'USDCx', symbol: 'USDC' },
      localnet: { decmanGovernanceThreshold: 3 },
      holdCountdownSeconds: 5,
    });
  });

  it('names every missing variable in one error, one per line, with its description', () => {
    const error = errorOf({ NETWORK: 'localnet' });
    const lines = error.message.split('\n');
    const expected = [
      'DATABASE_URL',
      'SESSION_SECRET',
      'LLM_API_KEY',
      'LLM_MODEL',
      'LEDGER_JSON_API_URL',
      'LEDGER_USER_ID',
      'TREASURY_PARTY',
      'AGENT_PARTY',
      'OPERATOR_PARTY',
      'ASSET_ADMIN_PARTY',
      'REGISTRY_URL',
      'LOCALNET_DEMO_PASSWORD',
      'LOCALNET_DEMO_PARTIES',
      'LOCALNET_NODES',
      'DECMAN_GOVERNANCE_RULES_CID',
      'DECMAN_MEMBER_PARTIES',
    ] as const;
    for (const name of expected) {
      expect(lines).toContain(
        `  - Missing required environment variable ${name}: ${ENV_DESCRIPTIONS[name]}`,
      );
    }
    // LEDGER_AUDIENCE is needed because the default auth mode on LocalNet is unsafe-hmac.
    expect(error.message).toContain('LEDGER_AUDIENCE');
    expect(error.problems).toHaveLength(expected.length + 1);
  });

  it('names a single missing LocalNet variable', () => {
    const { LOCALNET_DEMO_PASSWORD: _omitted, ...rest } = localnet;
    void _omitted;
    const error = errorOf(rest);
    expect(error.problems).toEqual([
      `Missing required environment variable LOCALNET_DEMO_PASSWORD: ${ENV_DESCRIPTIONS.LOCALNET_DEMO_PASSWORD}`,
    ]);
  });

  it('reports a missing NETWORK together with the other missing variables', () => {
    const error = errorOf({});
    expect(error.message).toContain('NETWORK');
    expect(error.message).toContain('DATABASE_URL');
    expect(error.message).toContain('SESSION_SECRET');
    expect(error.message).toContain('LEDGER_JSON_API_URL');
    expect(error.message).not.toContain('LOCALNET_');
  });

  it('treats empty values as missing', () => {
    const error = errorOf({ ...localnet, LLM_API_KEY: '' });
    expect(error.message).toContain('Missing required environment variable LLM_API_KEY');
  });

  it('rejects an invalid NETWORK', () => {
    const error = errorOf({ ...localnet, NETWORK: 'testnet' });
    expect(error.message).toContain('Invalid environment variable NETWORK');
    expect(error.message).toContain('testnet');
  });

  it('rejects invalid values and still lists missing ones', () => {
    const error = errorOf({
      NETWORK: 'localnet',
      PORT: 'abc',
      LOG_LEVEL: 'loud',
      SESSION_SECRET: 'short',
    });
    expect(error.message).toContain('Invalid environment variable PORT');
    expect(error.message).toContain('Invalid environment variable LOG_LEVEL');
    expect(error.message).toContain(
      'Invalid environment variable SESSION_SECRET: must be at least 32 characters',
    );
    expect(error.message).toContain('Missing required environment variable DATABASE_URL');
  });

  it('rejects malformed JSON and a wrong number of nodes', () => {
    expect(errorOf({ ...localnet, LOCALNET_DEMO_PARTIES: '{oops' }).message).toContain(
      'Invalid environment variable LOCALNET_DEMO_PARTIES: must be valid JSON',
    );
    const two = JSON.stringify((JSON.parse(nodes) as unknown[]).slice(0, 2));
    expect(errorOf({ ...localnet, LOCALNET_NODES: two }).message).toContain(
      'must list exactly 3 nodes',
    );
    const noName = JSON.stringify([{ partyId: 'p', displayName: '' }]);
    expect(errorOf({ ...localnet, LOCALNET_DEMO_PARTIES: noName }).message).toContain(
      '[0].displayName',
    );
  });

  it('does not ask for MainNet variables', () => {
    expect(errorOf({ ...localnet, DATABASE_URL: '' }).message).not.toContain(
      'MAINNET_EXPLORER_TX_URL',
    );
  });
});

describe('ledger auth modes', () => {
  it('requires the HMAC audience when the mode is unsafe-hmac', () => {
    const { LEDGER_AUDIENCE: _omitted, ...rest } = localnet;
    void _omitted;
    expect(errorOf(rest).problems).toEqual([
      `Missing required environment variable LEDGER_AUDIENCE: ${ENV_DESCRIPTIONS.LEDGER_AUDIENCE} (needed when LEDGER_AUTH_MODE is unsafe-hmac)`,
    ]);
  });

  it('requires every OIDC variable when the mode is oidc-client-credentials', () => {
    const error = errorOf({ ...localnet, LEDGER_AUTH_MODE: 'oidc-client-credentials' });
    for (const name of [
      'LEDGER_OIDC_TOKEN_URL',
      'LEDGER_OIDC_CLIENT_ID',
      'LEDGER_OIDC_CLIENT_SECRET',
      'LEDGER_OIDC_AUDIENCE',
      'LEDGER_OIDC_SCOPE',
    ]) {
      expect(error.message).toContain(`Missing required environment variable ${name}`);
    }
    expect(error.problems).toHaveLength(5);
  });

  it('needs no auth variables when the mode is none', () => {
    const { LEDGER_AUDIENCE: _omitted, ...rest } = localnet;
    void _omitted;
    expect(loadConfig({ ...rest, LEDGER_AUTH_MODE: 'none' }).ledger.auth).toEqual({ mode: 'none' });
  });

  it('rejects an unknown mode', () => {
    expect(errorOf({ ...localnet, LEDGER_AUTH_MODE: 'basic' }).message).toContain(
      'Invalid environment variable LEDGER_AUTH_MODE: got "basic"',
    );
  });

  it('reads the OIDC settings', () => {
    expect(
      loadConfig({
        ...localnet,
        LEDGER_AUTH_MODE: 'oidc-client-credentials',
        LEDGER_OIDC_TOKEN_URL: 'https://idp.example/oauth/token',
        LEDGER_OIDC_CLIENT_ID: 'client',
        LEDGER_OIDC_CLIENT_SECRET: 'secret',
        LEDGER_OIDC_AUDIENCE: 'https://ledger.example',
        LEDGER_OIDC_SCOPE: 'daml_ledger_api',
      }).ledger.auth,
    ).toEqual({
      mode: 'oidc-client-credentials',
      tokenUrl: 'https://idp.example/oauth/token',
      clientId: 'client',
      clientSecret: 'secret',
      audience: 'https://ledger.example',
      scope: 'daml_ledger_api',
    });
  });
});

describe('credentials over cleartext', () => {
  const oidc = {
    ...localnet,
    LEDGER_AUTH_MODE: 'oidc-client-credentials',
    LEDGER_OIDC_TOKEN_URL: 'https://idp.example/oauth/token',
    LEDGER_OIDC_CLIENT_ID: 'client',
    LEDGER_OIDC_CLIENT_SECRET: 'secret',
    LEDGER_OIDC_AUDIENCE: 'https://ledger.example',
    LEDGER_OIDC_SCOPE: 'daml_ledger_api',
  };

  it('requires https for LEDGER_OIDC_TOKEN_URL and says what to change', () => {
    const error = errorOf({
      ...oidc,
      LEDGER_OIDC_CLIENT_SECRET: 's3cr3t-value',
      LEDGER_OIDC_TOKEN_URL: 'http://idp.example/oauth/token',
    });
    expect(error.problems).toHaveLength(1);
    expect(error.problems[0]).toContain('LEDGER_OIDC_TOKEN_URL');
    expect(error.problems[0]).toContain('http://idp.example');
    expect(error.problems[0]).toContain('Set LEDGER_OIDC_TOKEN_URL to an https:// URL');
    // The secret never appears in the message.
    expect(error.message).not.toContain('s3cr3t-value');
  });

  it('requires https for LEDGER_JSON_API_URL when a token is sent, but not for loopback hosts', () => {
    const error = errorOf({ ...localnet, LEDGER_JSON_API_URL: 'http://ledger.example:7575' });
    expect(error.problems[0]).toContain('LEDGER_JSON_API_URL');
    expect(error.problems[0]).toContain('Set LEDGER_JSON_API_URL to an https:// URL');
    for (const url of [
      'http://localhost:3975',
      'http://participant.localhost:3975',
      'http://127.0.0.1:3975',
      'http://[::1]:3975',
      'https://ledger.example',
    ]) {
      expect(() => loadConfig({ ...localnet, LEDGER_JSON_API_URL: url })).not.toThrow();
    }
  });

  it('allows an http ledger URL when no token is sent (LEDGER_AUTH_MODE=none)', () => {
    const { LEDGER_AUDIENCE: _omitted, ...rest } = localnet;
    void _omitted;
    expect(() =>
      loadConfig({
        ...rest,
        LEDGER_AUTH_MODE: 'none',
        LEDGER_JSON_API_URL: 'http://ledger.example',
      }),
    ).not.toThrow();
  });

  it('checks the node URLs the token is also sent to', () => {
    const remote = JSON.stringify(
      (JSON.parse(nodes) as { jsonApiUrl: string }[]).map((n, i) =>
        i === 1 ? { ...n, jsonApiUrl: 'http://node-b.example:2975' } : n,
      ),
    );
    const error = errorOf({ ...localnet, LOCALNET_NODES: remote });
    expect(error.problems[0]).toContain('LOCALNET_NODES[1].jsonApiUrl');
  });

  it('accepts the https OIDC setup', () => {
    expect(() => loadConfig(oidc)).not.toThrow();
  });
});

describe('loadConfig on mainnet', () => {
  it('reads the MainNet settings and the LocalNet records ledger', () => {
    const config = loadConfig(mainnet);
    expect(config.network).toBe('mainnet');
    expect(config.mainnet).toEqual({
      explorerTxUrl: 'https://explorer.example/tx/{updateId}',
      groftyMinVersion: '2.0.4',
    });
    // The records stay on LocalNet, so the LocalNet settings are there too.
    expect(config.localnet).toMatchObject({
      demoPassword: 'demo',
      decmanGovernanceRulesCid: '00rulescid',
    });
    expect(config.ledger).toMatchObject({ auth: { mode: 'unsafe-hmac' }, readAsTreasury: true });
  });

  it('reads the optional demo video URL and rejects one that is not a URL', () => {
    expect(loadConfig(localnet).demoVideoUrl).toBeUndefined();
    expect(
      loadConfig({ ...localnet, DEMO_VIDEO_URL: 'https://video.example/demo' }).demoVideoUrl,
    ).toBe('https://video.example/demo');
    expect(errorOf({ ...localnet, DEMO_VIDEO_URL: 'not a url' }).message).toContain(
      'Invalid environment variable DEMO_VIDEO_URL',
    );
  });

  it('reads the optional Scan URL and a custom Grofty version', () => {
    const config = loadConfig({
      ...mainnet,
      MAINNET_SCAN_URL: 'https://scan.example/api/scan/',
      GROFTY_MIN_VERSION: '2.1.0',
    });
    expect(config.mainnet).toEqual({
      explorerTxUrl: 'https://explorer.example/tx/{updateId}',
      groftyMinVersion: '2.1.0',
      scanUrl: 'https://scan.example/api/scan',
    });
  });

  it('requires everything the LocalNet branch requires', () => {
    const error = errorOf({
      NETWORK: 'mainnet',
      MAINNET_EXPLORER_TX_URL: mainnet.MAINNET_EXPLORER_TX_URL,
    });
    for (const name of [
      'LOCALNET_DEMO_PASSWORD',
      'LOCALNET_DEMO_PARTIES',
      'LOCALNET_NODES',
      'DECMAN_GOVERNANCE_RULES_CID',
      'DECMAN_MEMBER_PARTIES',
      'DATABASE_URL',
      'TREASURY_PARTY',
    ]) {
      expect(error.message, name).toContain(`Missing required environment variable ${name}`);
    }
  });

  it('names a single missing LocalNet variable', () => {
    const { LOCALNET_NODES: _omitted, ...rest } = mainnet;
    void _omitted;
    expect(errorOf(rest).problems).toEqual([
      `Missing required environment variable LOCALNET_NODES: ${ENV_DESCRIPTIONS.LOCALNET_NODES}`,
    ]);
  });

  it('names MAINNET_EXPLORER_TX_URL when it is missing', () => {
    const { MAINNET_EXPLORER_TX_URL: _omitted, ...rest } = mainnet;
    void _omitted;
    const error = errorOf(rest);
    expect(error.problems).toEqual([
      `Missing required environment variable MAINNET_EXPLORER_TX_URL: ${ENV_DESCRIPTIONS.MAINNET_EXPLORER_TX_URL}`,
    ]);
  });

  it('requires the {updateId} placeholder in the explorer URL', () => {
    expect(
      errorOf({ ...mainnet, MAINNET_EXPLORER_TX_URL: 'https://explorer.example/tx' }).message,
    ).toContain('{updateId}');
  });

  it('rejects a Scan URL that is not a URL', () => {
    expect(errorOf({ ...mainnet, MAINNET_SCAN_URL: 'not a url' }).message).toContain(
      'Invalid environment variable MAINNET_SCAN_URL',
    );
  });
});

describe('loadDotEnv', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    delete process.env['MITHRA_TEST_DOTENV_A'];
    delete process.env['MITHRA_TEST_DOTENV_B'];
  });

  it('loads .env from a parent directory without overriding variables that are already set', () => {
    dir = mkdtempSync(join(tmpdir(), 'mithra-env-'));
    mkdirSync(join(dir, 'apps', 'backend'), { recursive: true });
    writeFileSync(
      join(dir, '.env'),
      'MITHRA_TEST_DOTENV_A=from-file\nMITHRA_TEST_DOTENV_B=from-file\n',
    );
    process.env['MITHRA_TEST_DOTENV_A'] = 'already-set';
    expect(loadDotEnv(join(dir, 'apps', 'backend'))).toBe(join(dir, '.env'));
    expect(process.env['MITHRA_TEST_DOTENV_A']).toBe('already-set');
    expect(process.env['MITHRA_TEST_DOTENV_B']).toBe('from-file');
  });

  it('returns undefined when there is no .env', () => {
    dir = mkdtempSync(join(tmpdir(), 'mithra-env-'));
    // The temp directory has no .env in it or above it.
    expect(loadDotEnv(dir)).toBeUndefined();
  });
});

describe('.env.example', () => {
  const text = readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8');
  const lines = text.split('\n');

  it.each(Object.entries(ENV_DESCRIPTIONS))('documents %s with its description', (name, desc) => {
    const index = lines.findIndex((l) => l.startsWith(`${name}=`));
    expect(index).toBeGreaterThan(0);
    expect(lines[index - 1]).toBe(`# ${desc}`);
  });

  it('holds no secrets', () => {
    for (const name of [
      'SESSION_SECRET',
      'LLM_API_KEY',
      'LEDGER_OIDC_CLIENT_SECRET',
      'LOCALNET_DEMO_PASSWORD',
    ]) {
      expect(lines).toContain(`${name}=`);
    }
  });
});
