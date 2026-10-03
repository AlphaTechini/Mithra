import { ApiError } from '$lib/api/client';

export interface ErrorCopy {
  /** What failed. */
  title: string;
  /** What to do next. */
  message: string;
}

/** Turns any thrown value into copy that says what failed and what to do. Never a bare code. */
export function describeError(error: unknown, whatFailed = 'Something went wrong.'): ErrorCopy {
  if (error instanceof ApiError) {
    // 502/503/504 without an API error body come from a proxy or gateway with nothing behind it,
    // and a non-JSON 200 is a static host answering for a missing API.
    const unreachable =
      error.status === 0 ||
      error.code === 'invalid_json' ||
      (error.code === 'http_error' && [502, 503, 504].includes(error.status));
    if (unreachable) {
      return {
        title: "Mithra can't reach its server.",
        message: 'Check that the backend is running on port 8787, then retry.',
      };
    }
    if (error.status === 401) {
      return { title: 'You are signed out.', message: 'Sign in again to continue.' };
    }
    if (error.code === 'invalid_response') {
      return {
        title: whatFailed,
        message:
          'The server sent something Mithra could not read. Retry, and if it keeps happening check the backend logs.',
      };
    }
    return { title: whatFailed, message: error.message };
  }
  return { title: whatFailed, message: 'Retry, and if it keeps happening reload the page.' };
}
