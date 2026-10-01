import { z } from 'zod';
import { LedgerError } from '../ledger/errors';
import { RegistryError } from '../wallet/tokenStandard';

/** Body of every API error response. */
export interface ErrorBody {
  error: { code: string; message: string };
}

export function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

/** An error with an HTTP status and a message that says what happened and what to do next. */
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

/** Validates `value` with `schema`; throws a 400 `invalid_request` naming the first problem. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  throw new ApiError(400, 'invalid_request', `${where}${issue?.message ?? 'Invalid request'}`);
}

/** The HTTP response for a ledger or registry failure. */
export function upstreamErrorResponse(
  error: unknown,
): { status: number; body: ErrorBody } | undefined {
  if (error instanceof LedgerError) {
    if (error.status === 0 || error.retryable) {
      return {
        status: 503,
        body: errorBody(
          'ledger_unavailable',
          'The ledger is not reachable right now. Check that the node is running, then try again.',
        ),
      };
    }
    if (error.status >= 400 && error.status < 500) {
      // The ledger refused the command (a Daml rule, a missing contract, no permission).
      return { status: 422, body: errorBody('ledger_rejected', error.message) };
    }
    return {
      status: 502,
      body: errorBody(
        'ledger_error',
        'The ledger could not process the request. Try again in a moment.',
      ),
    };
  }
  if (error instanceof RegistryError) {
    return {
      status: 502,
      body: errorBody(
        'registry_unavailable',
        'The token registry did not answer. Try again in a moment.',
      ),
    };
  }
  return undefined;
}
