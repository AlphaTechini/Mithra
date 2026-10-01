import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError, ENV_DESCRIPTIONS, loadConfig } from './env';

const required = {
  NETWORK: 'localnet',
  DATABASE_URL: 'postgres://x@localhost/x',
  LLM_API_KEY: 'key',
  LLM_MODEL: 'model',
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

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig(required)).toEqual({
      network: 'localnet',
      host: '0.0.0.0',
      port: 8787,
      webOrigin: 'http://localhost:5173',
      webDistDir: undefined,
      logLevel: 'info',
      databaseUrl: 'postgres://x@localhost/x',
      llm: { baseUrl: 'https://api.openai.com/v1', apiKey: 'key', model: 'model' },
    });
  });

  it('reads explicit values and accepts mainnet', () => {
    const config = loadConfig({
      ...required,
      NETWORK: 'mainnet',
      PORT: '9000',
      HOST: '127.0.0.1',
      WEB_DIST_DIR: 'apps/web/build',
      LOG_LEVEL: 'debug',
      LLM_BASE_URL: 'http://localhost:11434/v1',
    });
    expect(config).toMatchObject({
      network: 'mainnet',
      port: 9000,
      host: '127.0.0.1',
      webDistDir: 'apps/web/build',
      logLevel: 'debug',
      llm: { baseUrl: 'http://localhost:11434/v1' },
    });
  });

  it('names every missing variable in one error, one per line, with its description', () => {
    const error = errorOf({ NETWORK: 'localnet' });
    const lines = error.message.split('\n');
    for (const name of ['DATABASE_URL', 'LLM_API_KEY', 'LLM_MODEL'] as const) {
      expect(lines).toContain(
        `  - Missing required environment variable ${name}: ${ENV_DESCRIPTIONS[name]}`,
      );
    }
    expect(error.problems).toHaveLength(3);
  });

  it('reports a missing NETWORK together with the other missing variables', () => {
    const error = errorOf({});
    expect(error.problems).toHaveLength(4);
    expect(error.message).toContain('NETWORK');
    expect(error.message).toContain('DATABASE_URL');
    expect(error.message).toContain('LLM_API_KEY');
    expect(error.message).toContain('LLM_MODEL');
  });

  it('treats empty values as missing', () => {
    const error = errorOf({ ...required, LLM_API_KEY: '' });
    expect(error.message).toContain('Missing required environment variable LLM_API_KEY');
  });

  it('rejects an invalid NETWORK', () => {
    const error = errorOf({ ...required, NETWORK: 'testnet' });
    expect(error.message).toContain('Invalid environment variable NETWORK');
    expect(error.message).toContain('testnet');
  });

  it('rejects invalid values and still lists missing ones', () => {
    const error = errorOf({ NETWORK: 'localnet', PORT: 'abc', LOG_LEVEL: 'loud' });
    expect(error.message).toContain('Invalid environment variable PORT');
    expect(error.message).toContain('Invalid environment variable LOG_LEVEL');
    expect(error.message).toContain('Missing required environment variable DATABASE_URL');
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
});
