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

async function readErrorBody(res: Response): Promise<{ code: string; message: string }> {
  try {
    const body: unknown = await res.json();
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const error = body.error;
      if (typeof error === 'object' && error !== null) {
        const { code, message } = error as { code?: unknown; message?: unknown };
        if (typeof code === 'string' && typeof message === 'string') return { code, message };
      }
    }
  } catch {
    // Not JSON; fall through to the generic error.
  }
  return { code: 'http_error', message: `Request failed with status ${res.status}` };
}

/** GET `/api<path>` and parse the JSON response with `schema`. */
export async function apiGet<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  let res: Response;
  try {
    res = await fetch('/api' + path, { headers: { accept: 'application/json' } });
  } catch {
    throw new ApiError(0, 'network_error', 'Could not reach the Mithra backend');
  }

  if (!res.ok) {
    const { code, message } = await readErrorBody(res);
    throw new ApiError(res.status, code, message);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ApiError(res.status, 'invalid_response', 'The backend returned invalid JSON');
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
