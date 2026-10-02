import { HealthResponseSchema } from '@mithra/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiDelete, apiGet, apiPost } from './client';

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

describe('fetchJson retry and writes', () => {
  it('retries a GET once when the network call fails', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('failed'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'ok', network: 'localnet', version: '1' })),
      );
    vi.stubGlobal('fetch', fn);
    await expect(apiGet('/health', HealthResponseSchema)).resolves.toMatchObject({ status: 'ok' });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry a GET after an HTTP error', async () => {
    respond(JSON.stringify({ error: { code: 'x', message: 'y' } }), 500);
    await expect(apiGet('/health', HealthResponseSchema)).rejects.toMatchObject({ status: 500 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('never retries a POST', async () => {
    const fn = vi.fn(() => Promise.reject(new TypeError('failed')));
    vi.stubGlobal('fetch', fn);
    await expect(apiPost('/session/sign-out', null)).rejects.toMatchObject({ status: 0 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('posts JSON with same-origin credentials', async () => {
    respond(JSON.stringify({ status: 'ok', network: 'localnet', version: '1' }));
    await apiPost('/x', HealthResponseSchema, { a: 1 });
    const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(url).toBe('/api/x');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{"a":1}' });
    expect(init?.headers).toMatchObject({ 'content-type': 'application/json' });
  });

  it('accepts an empty 204 response when no schema is given', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
    );
    await expect(apiPost('/session/sign-out', null)).resolves.toBeUndefined();
    await expect(apiDelete('/things/1', null)).resolves.toBeUndefined();
    expect(vi.mocked(fetch).mock.calls[1]?.[1]).toMatchObject({ method: 'DELETE' });
  });
});
