import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { NetworkSchema, type Network } from '@mithra/shared';
import { z } from 'zod';

/**
 * Description of every environment variable the backend reads. These strings are printed in
 * startup errors and must match the comment above the variable in `.env.example`
 * (a test enforces that).
 */
export const ENV_DESCRIPTIONS = {
  NETWORK: 'Network to run against: localnet or mainnet. Selects endpoints and wallet behavior.',
  HOST: 'Interface the backend binds to.',
  PORT: 'Port the backend listens on.',
  WEB_ORIGIN: 'Origin of the web dev server, allowed by CORS in development.',
  WEB_DIST_DIR:
    'Path to the built web app (apps/web/build) that the backend serves in production; leave empty in dev.',
  LOG_LEVEL: 'Log level for the backend: fatal, error, warn, info, debug, trace or silent.',
  HOLD_COUNTDOWN_SECONDS:
    'Seconds of the Hold countdown before an auto-execute distribution is paid (default 30).',
  DATABASE_URL: 'PostgreSQL connection string for the application database.',
  SESSION_SECRET:
    'Secret that signs the session cookie, at least 32 characters (for example: openssl rand -hex 32).',
  LLM_BASE_URL: 'Base URL of the OpenAI-compatible LLM endpoint.',
  LLM_API_KEY: 'API key for the OpenAI-compatible LLM endpoint.',
  LLM_MODEL: 'Model name sent to the LLM endpoint.',
  LLM_TIMEOUT_MS: 'Timeout in milliseconds for one LLM request.',
  LLM_STRICT_TOOLS:
    'Send strict: true on the agent tool definitions (true for OpenAI; leave false for providers that reject it). Default false.',
  LLM_MAX_TOOL_ROUNDS:
    'Maximum number of tool-calling rounds the agent runs for one message before it must answer (default 4).',
  MITHRA_PACKAGE:
    'Daml package reference of the Mithra model used in ledger requests, for example #mithra-v1.',
  LEDGER_JSON_API_URL:
    'JSON Ledger API v2 base URL of the participant node that hosts the agent and operator parties.',
  LEDGER_USER_ID:
    'Ledger user the backend acts as; it needs act-as rights for the agent and operator.',
  LEDGER_AUTH_MODE:
    'How the backend authenticates to the ledger: unsafe-hmac, oidc-client-credentials or none (default unsafe-hmac on localnet, required on mainnet).',
  LEDGER_HMAC_SECRET:
    'HMAC secret that signs ledger tokens in unsafe-hmac mode (LocalNet default: unsafe).',
  LEDGER_AUDIENCE: 'Audience claim of ledger tokens in unsafe-hmac mode.',
  LEDGER_OIDC_TOKEN_URL: 'OIDC token endpoint for the ledger in oidc-client-credentials mode.',
  LEDGER_OIDC_CLIENT_ID: 'OIDC client id for the ledger in oidc-client-credentials mode.',
  LEDGER_OIDC_CLIENT_SECRET: 'OIDC client secret for the ledger in oidc-client-credentials mode.',
  LEDGER_OIDC_AUDIENCE: 'OIDC audience for the ledger token in oidc-client-credentials mode.',
  LEDGER_OIDC_SCOPE: 'OIDC scope for the ledger token in oidc-client-credentials mode.',
  TREASURY_PARTY:
    'Party id of the treasury (on LocalNet the Decentralized Party, on MainNet the treasurer).',
  AGENT_PARTY: 'Party id of the Mithra agent, hosted on the node at LEDGER_JSON_API_URL.',
  OPERATOR_PARTY: 'Party id of the Mithra operator, hosted on the node at LEDGER_JSON_API_URL.',
  ASSET_ADMIN_PARTY: 'Party id of the distributed instrument admin (the DSO party for CC).',
  ASSET_ID: 'Instrument id of the distributed asset (Amulet for CC).',
  ASSET_SYMBOL: 'Symbol shown to people for the distributed asset.',
  REGISTRY_URL: 'Base URL of the token standard registry API for the distributed asset.',
  LOCALNET_DEMO_PASSWORD: 'LocalNet only: the password people type to enter the demo.',
  LOCALNET_DEMO_PARTIES:
    'LocalNet only: JSON list of demo parties for the role switcher, [{"partyId":"...","displayName":"Treasurer"}].',
  LOCALNET_READ_AS_TREASURY:
    'LocalNet only: true if the ledger user may read as the treasury party (default true).',
  LOCALNET_NODES:
    'LocalNet only: JSON list of exactly three nodes [{"id","name","operator","jsonApiUrl","decmanUrl","autoConfirm"}].',
  DECMAN_GOVERNANCE_THRESHOLD:
    'LocalNet only: number of node confirmations the Decentralization Manager needs for a governed action (default 2).',
  DECMAN_GOVERNANCE_RULES_CID:
    'LocalNet only: contract id of the treasury GovernanceRules, used to confirm and execute governed actions such as sealing a Mandate (scripts/localnet-up.sh writes it).',
  DECMAN_MEMBER_PARTIES:
    'LocalNet only: JSON object mapping a node id to the party that represents that node in governance, {"a":"member-a::1220..."}.',
  MAINNET_EXPLORER_TX_URL:
    'MainNet only: block explorer link for a transaction, containing {updateId}.',
  GROFTY_MIN_VERSION:
    'MainNet only: minimum Grofty Wallet version the signing flow needs (default 2.0.4).',
} as const;

type EnvName = keyof typeof ENV_DESCRIPTIONS;

/** Parses a JSON string and validates it with `schema`; JSON errors become a normal issue. */
function jsonOf<T extends z.ZodType>(schema: T) {
  return z
    .string()
    .transform((text, ctx): unknown => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        ctx.addIssue({ code: 'custom', message: 'must be valid JSON' });
        return z.NEVER;
      }
    })
    .pipe(schema);
}

const booleanString = z.enum(['true', 'false']).transform((v) => v === 'true');

const LedgerAuthModeSchema = z.enum(['unsafe-hmac', 'oidc-client-credentials', 'none']);
export type LedgerAuthMode = z.infer<typeof LedgerAuthModeSchema>;

const DemoPartiesSchema = z
  .array(z.object({ partyId: z.string().min(1), displayName: z.string().min(1) }))
  .min(1, 'must list at least one party');

const NodesSchema = z
  .array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      operator: z.string().min(1),
      jsonApiUrl: z.url(),
      decmanUrl: z.url(),
      autoConfirm: z.boolean(),
    }),
  )
  .length(3, 'must list exactly 3 nodes');

/** Variables that apply on every network. */
const commonShape = {
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  WEB_ORIGIN: z.url().default('http://localhost:5173'),
  WEB_DIST_DIR: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  HOLD_COUNTDOWN_SECONDS: z.coerce.number().int().min(0).max(3600).default(30),
  DATABASE_URL: z.url(),
  SESSION_SECRET: z.string().min(32, 'must be at least 32 characters long'),
  LLM_BASE_URL: z.url().default('https://api.openai.com/v1'),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().min(1),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1).default(30000),
  LLM_STRICT_TOOLS: booleanString.default(false),
  LLM_MAX_TOOL_ROUNDS: z.coerce.number().int().min(1).max(10).default(4),
  MITHRA_PACKAGE: z.string().min(1).default('#mithra-v1'),
  LEDGER_JSON_API_URL: z.url(),
  LEDGER_USER_ID: z.string().min(1),
  TREASURY_PARTY: z.string().min(1),
  AGENT_PARTY: z.string().min(1),
  OPERATOR_PARTY: z.string().min(1),
  ASSET_ADMIN_PARTY: z.string().min(1),
  ASSET_ID: z.string().min(1).default('Amulet'),
  ASSET_SYMBOL: z.string().min(1).default('CC'),
  REGISTRY_URL: z.url(),
};

/** Optional ledger auth variables; which ones are required depends on LEDGER_AUTH_MODE. */
const ledgerAuthShape = {
  LEDGER_HMAC_SECRET: z.string().min(1).optional(),
  LEDGER_AUDIENCE: z.string().min(1).optional(),
  LEDGER_OIDC_TOKEN_URL: z.url().optional(),
  LEDGER_OIDC_CLIENT_ID: z.string().min(1).optional(),
  LEDGER_OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  LEDGER_OIDC_AUDIENCE: z.string().min(1).optional(),
  LEDGER_OIDC_SCOPE: z.string().min(1).optional(),
};

/** Network-specific variables. */
const networkShapes = {
  localnet: {
    LOCALNET_DEMO_PASSWORD: z.string().min(1),
    LOCALNET_DEMO_PARTIES: jsonOf(DemoPartiesSchema),
    LOCALNET_READ_AS_TREASURY: booleanString.default(true),
    LOCALNET_NODES: jsonOf(NodesSchema),
    DECMAN_GOVERNANCE_THRESHOLD: z.coerce.number().int().min(1).max(3).default(2),
    DECMAN_GOVERNANCE_RULES_CID: z.string().min(1),
    DECMAN_MEMBER_PARTIES: jsonOf(z.record(z.string().min(1), z.string().min(1))),
  },
  mainnet: {
    MAINNET_EXPLORER_TX_URL: z
      .string()
      .min(1)
      .refine((v) => v.includes('{updateId}'), 'must contain the placeholder {updateId}'),
    GROFTY_MIN_VERSION: z.string().min(1).default('2.0.4'),
  },
} satisfies Record<Network, z.ZodRawShape>;

const commonSchema = z.object({ ...commonShape, ...ledgerAuthShape });
const localnetSchema = z.object({ ...commonShape, ...ledgerAuthShape, ...networkShapes.localnet });
const mainnetSchema = z.object({ ...commonShape, ...ledgerAuthShape, ...networkShapes.mainnet });

export type LedgerAuthConfig =
  | { mode: 'unsafe-hmac'; secret: string; audience: string }
  | {
      mode: 'oidc-client-credentials';
      tokenUrl: string;
      clientId: string;
      clientSecret: string;
      audience: string;
      scope: string;
    }
  | { mode: 'none' };

export interface LocalnetNode {
  id: string;
  name: string;
  operator: string;
  jsonApiUrl: string;
  decmanUrl: string;
  autoConfirm: boolean;
}

export interface LocalnetConfig {
  demoPassword: string;
  demoParties: { partyId: string; displayName: string }[];
  nodes: LocalnetNode[];
  decmanGovernanceThreshold: number;
  /** Contract id of the treasury's GovernanceRules in DecMan. */
  decmanGovernanceRulesCid: string;
  /** Node id to the member party that represents the node in governance. */
  decmanMemberParties: Record<string, string>;
}

export interface MainnetConfig {
  explorerTxUrl: string;
  groftyMinVersion: string;
}

export interface BaseConfig {
  host: string;
  port: number;
  webOrigin: string;
  /** Absolute or relative path to the built web app; when set the backend serves it. */
  webDistDir: string | undefined;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  /** Seconds of the Hold countdown before an auto-execute distribution is paid. Absent means 30. */
  holdCountdownSeconds?: number;
  databaseUrl: string;
  /** Secret that signs the session cookie. */
  sessionSecret: string;
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
    /** Send `strict: true` on function tools. Absent means false. */
    strictTools?: boolean;
    /** Tool-calling rounds per agent message. Absent means 4. */
    maxToolRounds?: number;
  };
  ledger: {
    jsonApiUrl: string;
    userId: string;
    auth: LedgerAuthConfig;
    /** Package reference used in template ids, `#mithra-v1`. */
    mithraPackage: string;
    /** True when the ledger user may read as the treasury party (LocalNet). */
    readAsTreasury: boolean;
  };
  parties: { treasury: string; agent: string; operator: string };
  asset: { adminParty: string; id: string; symbol: string };
  registryUrl: string;
}

export type Config = BaseConfig &
  (
    | { network: 'localnet'; localnet: LocalnetConfig; mainnet?: undefined }
    | { network: 'mainnet'; mainnet: MainnetConfig; localnet?: undefined }
  );

/** Thrown by `loadConfig`; the message lists every problem, one per line. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `Invalid configuration (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        '\nSee .env.example for every variable.',
    );
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

function describe(name: string): string {
  return name in ENV_DESCRIPTIONS ? ENV_DESCRIPTIONS[name as EnvName] : 'see .env.example';
}

/** Treats empty strings as unset, so `FOO=` in a .env file behaves like an absent variable. */
function clean(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = value === undefined || value.trim() === '' ? undefined : value;
  }
  return out;
}

const missing = (name: string): string =>
  `Missing required environment variable ${name}: ${describe(name)}`;

/**
 * Finds `.env` starting at `startDir` and walking up (the repo root when the backend runs from
 * `apps/backend`) and loads it. Variables already set in the environment are not overridden.
 * Returns the loaded path, or undefined when there is no `.env`.
 */
export function loadDotEnv(startDir: string = process.cwd()): string | undefined {
  let dir = resolve(startDir);
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Ledger auth settings for `mode`, or the problems found. */
function readLedgerAuth(
  mode: LedgerAuthMode,
  values: Record<string, string | undefined>,
  problems: string[],
): LedgerAuthConfig {
  const need = (name: string): string => {
    const value = values[name];
    if (value === undefined)
      problems.push(`${missing(name)} (needed when LEDGER_AUTH_MODE is ${mode})`);
    return value ?? '';
  };
  switch (mode) {
    case 'unsafe-hmac':
      return { mode, secret: need('LEDGER_HMAC_SECRET'), audience: need('LEDGER_AUDIENCE') };
    case 'oidc-client-credentials':
      return {
        mode,
        tokenUrl: need('LEDGER_OIDC_TOKEN_URL'),
        clientId: need('LEDGER_OIDC_CLIENT_ID'),
        clientSecret: need('LEDGER_OIDC_CLIENT_SECRET'),
        audience: need('LEDGER_OIDC_AUDIENCE'),
        scope: need('LEDGER_OIDC_SCOPE'),
      };
    case 'none':
      return { mode };
  }
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const input = clean(env);
  const problems: string[] = [];

  const networkResult = NetworkSchema.safeParse(input['NETWORK']);
  if (!networkResult.success) {
    problems.push(
      input['NETWORK'] === undefined
        ? `Missing required environment variable NETWORK: ${ENV_DESCRIPTIONS.NETWORK}`
        : `Invalid environment variable NETWORK: got "${input['NETWORK']}", expected one of ${NetworkSchema.options.join(', ')}. ${ENV_DESCRIPTIONS.NETWORK}`,
    );
  }
  const network = networkResult.success ? networkResult.data : undefined;

  // The ledger auth mode defaults to unsafe-hmac on LocalNet and must be given on MainNet.
  let authMode: LedgerAuthMode | undefined;
  const rawMode = input['LEDGER_AUTH_MODE'];
  if (rawMode === undefined) {
    if (network === 'localnet') authMode = 'unsafe-hmac';
    else if (network === 'mainnet') problems.push(missing('LEDGER_AUTH_MODE'));
  } else {
    const parsedMode = LedgerAuthModeSchema.safeParse(rawMode);
    if (parsedMode.success) authMode = parsedMode.data;
    else {
      problems.push(
        `Invalid environment variable LEDGER_AUTH_MODE: got "${rawMode}", expected one of ${LedgerAuthModeSchema.options.join(', ')}. ${describe('LEDGER_AUTH_MODE')}`,
      );
    }
  }

  const localnetParsed = network === 'localnet' ? localnetSchema.safeParse(input) : undefined;
  const mainnetParsed = network === 'mainnet' ? mainnetSchema.safeParse(input) : undefined;
  const parsed = localnetParsed ?? mainnetParsed ?? commonSchema.safeParse(input);

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const name = String(issue.path[0] ?? 'environment');
      const rest = issue.path
        .slice(1)
        .map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`))
        .join('');
      problems.push(
        input[name] === undefined
          ? missing(name)
          : `Invalid environment variable ${name}: ${rest ? `${rest.replace(/^\./, '')}: ` : ''}${issue.message}. ${describe(name)}`,
      );
    }
  }

  // Auth variables that the chosen mode requires. The shape check above already reported any
  // that are present but malformed (for example a token URL that is not a URL).
  let auth: LedgerAuthConfig = { mode: 'none' };
  if (authMode !== undefined) {
    const authProblems: string[] = [];
    // LocalNet's ledger accepts tokens signed with the well-known demo secret "unsafe".
    const authInput = { ...input };
    if (network === 'localnet') authInput['LEDGER_HMAC_SECRET'] ??= 'unsafe';
    auth = readLedgerAuth(authMode, authInput, authProblems);
    problems.push(...authProblems);
  }

  if (problems.length > 0 || network === undefined || !parsed.success) {
    throw new ConfigError(problems);
  }

  const values = parsed.data;
  const base: BaseConfig = {
    host: values.HOST,
    port: values.PORT,
    webOrigin: values.WEB_ORIGIN,
    webDistDir: values.WEB_DIST_DIR,
    logLevel: values.LOG_LEVEL,
    holdCountdownSeconds: values.HOLD_COUNTDOWN_SECONDS,
    databaseUrl: values.DATABASE_URL,
    sessionSecret: values.SESSION_SECRET,
    llm: {
      baseUrl: values.LLM_BASE_URL,
      apiKey: values.LLM_API_KEY,
      model: values.LLM_MODEL,
      timeoutMs: values.LLM_TIMEOUT_MS,
      strictTools: values.LLM_STRICT_TOOLS,
      maxToolRounds: values.LLM_MAX_TOOL_ROUNDS,
    },
    ledger: {
      jsonApiUrl: values.LEDGER_JSON_API_URL,
      userId: values.LEDGER_USER_ID,
      auth,
      mithraPackage: values.MITHRA_PACKAGE,
      readAsTreasury: false,
    },
    parties: {
      treasury: values.TREASURY_PARTY,
      agent: values.AGENT_PARTY,
      operator: values.OPERATOR_PARTY,
    },
    asset: {
      adminParty: values.ASSET_ADMIN_PARTY,
      id: values.ASSET_ID,
      symbol: values.ASSET_SYMBOL,
    },
    registryUrl: values.REGISTRY_URL,
  };

  if (localnetParsed?.success) {
    const local = localnetParsed.data;
    return {
      ...base,
      ledger: { ...base.ledger, readAsTreasury: local.LOCALNET_READ_AS_TREASURY },
      network: 'localnet',
      localnet: {
        demoPassword: local.LOCALNET_DEMO_PASSWORD,
        demoParties: local.LOCALNET_DEMO_PARTIES,
        nodes: local.LOCALNET_NODES,
        decmanGovernanceThreshold: local.DECMAN_GOVERNANCE_THRESHOLD,
        decmanGovernanceRulesCid: local.DECMAN_GOVERNANCE_RULES_CID,
        decmanMemberParties: local.DECMAN_MEMBER_PARTIES,
      },
    };
  }
  if (!mainnetParsed?.success) throw new ConfigError(problems);
  const main = mainnetParsed.data;
  return {
    ...base,
    network: 'mainnet',
    mainnet: {
      explorerTxUrl: main.MAINNET_EXPLORER_TX_URL,
      groftyMinVersion: main.GROFTY_MIN_VERSION,
    },
  };
}
