import { ApiError, upstreamErrorResponse } from '../../http/errors';

/** The message of a service error, for a card the treasurer reads: what happened, what to do. */
export function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  const upstream = upstreamErrorResponse(error);
  if (upstream) return upstream.body.error.message;
  return 'Something went wrong on our side. Try again, or use the screens.';
}
