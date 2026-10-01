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
  DATABASE_URL: 'PostgreSQL connection string for the application database.',
  LLM_BASE_URL: 'Base URL of the OpenAI-compatible LLM endpoint.',
  LLM_API_KEY: 'API key for the OpenAI-compatible LLM endpoint.',
  LLM_MODEL: 'Model name sent to the LLM endpoint.',
} as const;

type EnvName = keyof typeof ENV_DESCRIPTIONS;

/** Variables that apply on every network. */
const commonShape = {
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  WEB_ORIGIN: z.url().default('http://localhost:5173'),
  WEB_DIST_DIR: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url(),
  LLM_BASE_URL: z.url().default('https://api.openai.com/v1'),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().min(1),
};

/**
 * Network-specific variables. Later milestones add the variables of each network (ledger
 * endpoints, party IDs, keys, wallet settings) by extending the object for that network here;
 * nothing else in this file needs to change. Descriptions for new variables go in
 * `ENV_DESCRIPTIONS` and `.env.example`.
 */
const networkShapes = {
  localnet: {},
  mainnet: {},
} satisfies Record<Network, z.ZodRawShape>;

export interface Config {
  network: Network;
  host: string;
  port: number;
  webOrigin: string;
  /** Absolute or relative path to the built web app; when set the backend serves it. */
  webDistDir: string | undefined;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  databaseUrl: string;
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
}

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

  const shape: z.ZodRawShape = {
    ...commonShape,
    ...(networkResult.success ? networkShapes[networkResult.data] : {}),
  };
  const parsed = z.object(shape).safeParse(input);

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const name = String(issue.path[0] ?? 'environment');
      problems.push(
        input[name] === undefined
          ? `Missing required environment variable ${name}: ${describe(name)}`
          : `Invalid environment variable ${name}: ${issue.message}. ${describe(name)}`,
      );
    }
  }

  if (problems.length > 0 || !networkResult.success || !parsed.success) {
    throw new ConfigError(problems);
  }

  // The shape is built dynamically, so the parsed value is read through the common schema type.
  const values = z.object(commonShape).parse(parsed.data);
  return {
    network: networkResult.data,
    host: values.HOST,
    port: values.PORT,
    webOrigin: values.WEB_ORIGIN,
    webDistDir: values.WEB_DIST_DIR,
    logLevel: values.LOG_LEVEL,
    databaseUrl: values.DATABASE_URL,
    llm: {
      baseUrl: values.LLM_BASE_URL,
      apiKey: values.LLM_API_KEY,
      model: values.LLM_MODEL,
    },
  };
}
