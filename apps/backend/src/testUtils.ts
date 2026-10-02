/** Helpers for tests that stub `fetch`. Not used by the application. */

/** The URL of a `fetch` input as a string. */
export function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** The body of a `fetch` init as parsed JSON (undefined when there is none). */
export function jsonBodyOf(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
}
