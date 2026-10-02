import { ApiErrorBodySchema } from '@mithra/shared';
import type { z } from 'zod';

/** Error raised for any failed API call. `status` is 0 when the backend could not be reached. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

async function readErrorBody(res: Response): Promise<{ code: string; message: string }> {
  try {
    const parsed = ApiErrorBodySchema.safeParse(await res.json());
    if (parsed.success) return parsed.data.error;
  } catch {
    // Not JSON; fall through to the generic error.
  }
  return { code: 'http_error', message: `Request failed with status ${res.status}` };
}

async function send(method: Method, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const init: RequestInit = { method, headers, credentials: 'same-origin' };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  try {
    return await fetch('/api' + path, init);
  } catch {
    throw new ApiError(0, 'network_error', 'Could not reach the Mithra backend');
  }
}

/**
 * Sends one request to `/api<path>`. A GET is retried once when the network call itself fails
 * (never after an HTTP error response, and never for writes, which are not safe to repeat).
 */
export async function fetchJson(method: Method, path: string, body?: unknown): Promise<Response> {
  let res: Response;
  try {
    res = await send(method, path, body);
  } catch (e) {
    if (method === 'GET' && e instanceof ApiError && e.status === 0) {
      res = await send(method, path, body);
    } else {
      throw e;
    }
  }
  if (!res.ok) {
    const { code, message } = await readErrorBody(res);
    throw new ApiError(res.status, code, message);
  }
  return res;
}

async function parseBody<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    // Usually means no API answered at this path (for example a static host's index.html).
    throw new ApiError(res.status, 'invalid_json', 'The backend returned invalid JSON');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError(
      res.status,
      'invalid_response',
      'The backend response had an unexpected shape',
    );
  }
  return parsed.data;
}

/** GET `/api<path>` and parse the JSON response with `schema`. */
export async function apiGet<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  return parseBody(await fetchJson('GET', path), schema);
}

/** POST a JSON body to `/api<path>`. Pass `null` as the schema for an empty (204) response. */
export function apiPost<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T>;
export function apiPost(path: string, schema: null, body?: unknown): Promise<void>;
export async function apiPost<T>(
  path: string,
  schema: z.ZodType<T> | null,
  body?: unknown,
): Promise<T | void> {
  const res = await fetchJson('POST', path, body);
  if (schema === null) return;
  return parseBody(res, schema);
}

/** PUT a JSON body to `/api<path>` and parse the response with `schema`. */
export async function apiPut<T>(path: string, schema: z.ZodType<T>, body: unknown): Promise<T> {
  return parseBody(await fetchJson('PUT', path, body), schema);
}

/** DELETE `/api<path>`. Pass `null` as the schema for an empty (204) response. */
export function apiDelete<T>(path: string, schema: z.ZodType<T>): Promise<T>;
export function apiDelete(path: string, schema: null): Promise<void>;
export async function apiDelete<T>(path: string, schema: z.ZodType<T> | null): Promise<T | void> {
  const res = await fetchJson('DELETE', path);
  if (schema === null) return;
  return parseBody(res, schema);
}
