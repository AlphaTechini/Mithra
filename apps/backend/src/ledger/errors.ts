/**
 * Error from the ledger. `message` is for people (the Daml `assertMsg` text when there is one);
 * `code` is the Canton error code, for example `DAML_FAILURE`.
 */
export class LedgerError extends Error {
  readonly code: string;
  /** True when sending the same request again may succeed (transient failure or contention). */
  readonly retryable: boolean;
  /** HTTP status of the ledger response; 0 when no response arrived (network failure, timeout). */
  readonly status: number;
  /** Canton error category number when the ledger sent one. */
  readonly category: number | undefined;
  /** The unprocessed `cause` text from the ledger, for logs. */
  readonly rawCause: string | undefined;

  constructor(init: {
    code: string;
    message: string;
    retryable: boolean;
    status: number;
    category?: number | undefined;
    rawCause?: string | undefined;
    cause?: unknown;
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'LedgerError';
    this.code = init.code;
    this.retryable = init.retryable;
    this.status = init.status;
    this.category = init.category;
    this.rawCause = init.rawCause;
  }
}

/** Canton error categories whose requests may be repeated with the same command id. */
const RETRYABLE_CATEGORIES = new Set([1, 2, 3]);

/** Error codes that are transient although the category says otherwise. */
const RETRYABLE_CODES = new Set([
  'PARTY_ALLOCATION_WITHOUT_CONNECTED_SYNCHRONIZER',
  'NO_SYNCHRONIZER_ON_WHICH_ALL_SUBMITTERS_CAN_SUBMIT',
  'SYNCHRONIZER_NOT_CONNECTED',
]);

const USER_FAILURE_PREFIX =
  /^(?:Interpretation error: )?Error: User failure: UNHANDLED_EXCEPTION\/[\w.]+:[\w]+(?:@[0-9a-f]+)?(?: \(error category \d+\))?:\s*/;

/**
 * Turns the ledger's `cause` into a message for people. Daml `assertMsg` and `abort` text is
 * kept and the interpreter prefix is removed:
 * `Interpretation error: Error: User failure: UNHANDLED_EXCEPTION/DA.Exception.AssertionFailed:AssertionFailed (error category 9): Total 5 CC is above the cap`
 * becomes `Total 5 CC is above the cap`.
 */
export function cleanCause(cause: string): string {
  const text = cause.trim();
  const precondition = /Template precondition violated: (\w+)/.exec(text);
  if (precondition && USER_FAILURE_PREFIX.test(text)) {
    return `The ledger rejected the data: the ${precondition[1] ?? 'contract'} fields are not valid (for example a threshold above the number of approvers).`;
  }
  const stripped = text.replace(USER_FAILURE_PREFIX, '');
  // Other interpreter failures keep their own wording, minus the generic prefix.
  return stripped.replace(/^Interpretation error: Error: /, '').trim();
}

interface RawLedgerError {
  code?: unknown;
  cause?: unknown;
  errorCategory?: unknown;
  definiteAnswer?: unknown;
  message?: unknown;
}

/** Builds a `LedgerError` from an HTTP error response body (parsed JSON or text). */
export function ledgerErrorFromResponse(status: number, body: unknown): LedgerError {
  if (typeof body === 'object' && body !== null) {
    const raw = body as RawLedgerError;
    const code = typeof raw.code === 'string' ? raw.code : `HTTP_${status}`;
    const cause = typeof raw.cause === 'string' ? raw.cause : undefined;
    const category = typeof raw.errorCategory === 'number' ? raw.errorCategory : undefined;
    const definite = raw.definiteAnswer === true;
    const retryable =
      !definite &&
      ((category !== undefined && RETRYABLE_CATEGORIES.has(category)) ||
        RETRYABLE_CODES.has(code) ||
        status === 502 ||
        status === 503 ||
        status === 504);
    const message = cause
      ? cleanCause(cause)
      : typeof raw.message === 'string'
        ? raw.message
        : `The ledger answered with HTTP ${status}`;
    return new LedgerError({ code, message, retryable, status, category, rawCause: cause });
  }
  const text = typeof body === 'string' && body.trim() !== '' ? body.trim().slice(0, 300) : '';
  return new LedgerError({
    code: `HTTP_${status}`,
    message: text || `The ledger answered with HTTP ${status}`,
    retryable: status === 502 || status === 503 || status === 504,
    status,
  });
}

/** Wraps a failure to reach the ledger at all (connection refused, timeout, DNS). */
export function ledgerUnreachable(url: string, cause: unknown): LedgerError {
  const isTimeout =
    cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
  return new LedgerError({
    code: isTimeout ? 'LEDGER_TIMEOUT' : 'LEDGER_UNREACHABLE',
    message: isTimeout
      ? `The ledger at ${url} did not answer in time. Check that the node is running and try again.`
      : `Cannot reach the ledger at ${url}. Check LEDGER_JSON_API_URL and that the node is running.`,
    retryable: true,
    status: 0,
    cause,
  });
}
