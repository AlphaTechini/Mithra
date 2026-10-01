import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecimalString, HealthResponseSchema, PublicConfigSchema } from '@mithra/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp, type ErrorBody } from './app';
import type { Config } from './config/env';
import { localnetTestConfig, mainnetTestConfig } from './testConfig';

const baseConfig: Config = localnetTestConfig();

const INDEX_HTML = '<!doctype html><html lang="en"><body>mithra shell</body></html>';

let app: FastifyInstance | undefined;
let dist: string | undefined;

beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), 'mithra-web-'));
  writeFileSync(join(dist, 'index.html'), INDEX_HTML);
  mkdirSync(join(dist, '_app'));
  writeFileSync(join(dist, '_app', 'app.js'), 'export {};');
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (dist) rmSync(dist, { recursive: true, force: true });
});

describe('GET /api/health', () => {
  it('returns status, network and version', async () => {
    app = buildApp(mainnetTestConfig());
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = HealthResponseSchema.parse(res.json());
    expect(body.network).toBe('mainnet');
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('allows the web origin through CORS in dev', async () => {
    app = buildApp(baseConfig);
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
});

describe('GET /api/config/public', () => {
  it('describes LocalNet as test mode without an explorer link', async () => {
    app = buildApp(baseConfig);
    const res = await app.inject({ method: 'GET', url: '/api/config/public' });
    expect(res.statusCode).toBe(200);
    expect(PublicConfigSchema.parse(res.json())).toEqual({
      network: 'localnet',
      testMode: true,
      assetSymbol: 'CC',
      explorerTxUrlTemplate: null,
      groftyMinVersion: '2.0.4',
    });
  });

  it('gives MainNet the explorer template and the Grofty version', async () => {
    app = buildApp(mainnetTestConfig());
    const res = await app.inject({ method: 'GET', url: '/api/config/public' });
    expect(PublicConfigSchema.parse(res.json())).toEqual({
      network: 'mainnet',
      testMode: false,
      assetSymbol: 'CC',
      explorerTxUrlTemplate: 'https://explorer.example/tx/{updateId}',
      groftyMinVersion: '2.0.4',
    });
  });

  it('does not expose session or ledger routes when the app has no dependencies', async () => {
    app = buildApp(baseConfig);
    for (const url of ['/api/session', '/api/status']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe('unknown API routes and errors', () => {
  it('returns a JSON 404 for /api/unknown without static serving', async () => {
    app = buildApp(baseConfig);
    const res = await app.inject({ method: 'GET', url: '/api/unknown' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toEqual({
      error: { code: 'not_found', message: 'Route GET /api/unknown not found' },
    });
  });

  it('returns a JSON 404 for /api/unknown even when the web app is served', async () => {
    app = buildApp({ ...baseConfig, webDistDir: dist });
    const res = await app.inject({ method: 'GET', url: '/api/unknown' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('returns a JSON 404 for non-GET requests on client routes', async () => {
    app = buildApp({ ...baseConfig, webDistDir: dist });
    const res = await app.inject({ method: 'POST', url: '/treasurer/overview' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('hides internals of unexpected errors', async () => {
    app = buildApp(baseConfig);
    app.get('/api/boom', () => {
      throw new Error('secret database password leaked');
    });
    const res = await app.inject({ method: 'GET', url: '/api/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: 'internal_error', message: 'Internal server error' },
    });
    expect(res.body).not.toContain('secret');
    expect(res.body).not.toContain('at ');
  });

  it('maps malformed request bodies to a 400 error body', async () => {
    app = buildApp(baseConfig);
    app.post('/api/echo', (request) => request.body);
    const res = await app.inject({
      method: 'POST',
      url: '/api/echo',
      payload: '{',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'bad_request' } });
  });

  it('maps Zod validation failures to a 400 error body', async () => {
    app = buildApp(baseConfig);
    app.get('/api/zod', () => z.object({ amount: DecimalString }).parse({ amount: '1e5' }));
    const res = await app.inject({ method: 'GET', url: '/api/zod' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'validation_error' } });
    expect(res.json<ErrorBody>().error.message).toContain('amount');
  });
});

describe('static web app', () => {
  it('serves index.html for client routes such as /treasurer/overview', async () => {
    app = buildApp({ ...baseConfig, webDistDir: dist });
    const res = await app.inject({ method: 'GET', url: '/treasurer/overview' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toBe(INDEX_HTML);
  });

  it('serves real files and the root', async () => {
    app = buildApp({ ...baseConfig, webDistDir: dist });
    const js = await app.inject({ method: 'GET', url: '/_app/app.js' });
    expect(js.statusCode).toBe(200);
    expect(js.body).toBe('export {};');
    const root = await app.inject({ method: 'GET', url: '/' });
    expect(root.body).toBe(INDEX_HTML);
  });

  it('still serves the health route', async () => {
    app = buildApp({ ...baseConfig, webDistDir: dist });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
  });

  it('does not serve the web app when WEB_DIST_DIR is unset', async () => {
    app = buildApp(baseConfig);
    const res = await app.inject({ method: 'GET', url: '/treasurer/overview' });
    expect(res.statusCode).toBe(404);
  });

  it('fails fast when WEB_DIST_DIR has no index.html', () => {
    expect(() => buildApp({ ...baseConfig, webDistDir: join(dist ?? '', 'missing') })).toThrow(
      /index\.html/,
    );
  });
});
