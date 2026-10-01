import { HealthResponseSchema } from '@mithra/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiGet } from './client';

function respond(body: string, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(body, { status }))),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiGet', () => {
  it('requests /api<path> and parses the response', async () => {
    respond(JSON.stringify({ status: 'ok', network: 'localnet', version: '1.2.3' }));
    const result = await apiGet('/health', HealthResponseSchema);
    expect(result).toEqual({ status: 'ok', network: 'localnet', version: '1.2.3' });
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('/api/health');
  });

  it('throws ApiError with code and message from the error body', async () => {
    respond(JSON.stringify({ error: { code: 'not_found', message: 'nope' } }), 404);
    await expect(apiGet('/x', HealthResponseSchema)).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      code: 'not_found',
      message: 'nope',
    });
  });

  it('throws a generic ApiError for non-JSON error responses', async () => {
    respond('<html>bad gateway</html>', 502);
    await expect(apiGet('/x', HealthResponseSchema)).rejects.toMatchObject({
      status: 502,
      code: 'http_error',
    });
  });

  it('rejects responses that do not match the schema', async () => {
    respond(JSON.stringify({ status: 'ok', network: 'devnet', version: '1' }));
    await expect(apiGet('/health', HealthResponseSchema)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('maps fetch failures to status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('failed'))),
    );
    const error = await apiGet('/health', HealthResponseSchema).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 0, code: 'network_error' });
  });
});
