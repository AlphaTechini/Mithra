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
  // Seen on the Canton 3.4 sandbox right after a transaction that archived and recreated the
  // command's input contracts: routing has not caught up yet. The command is rejected before it is
  // sequenced, so sending it again is safe; it succeeds a moment later.
  'UNKNOWN_CONTRACT_SYNCHRONIZERS',
]);

/**
 * What people read when the treasury's nodes cannot confirm a transaction (BitSafe, N8): fewer than
 * the hosting threshold of the treasury's nodes are online. The numbers are the LocalNet setup
 * (2 of 3); the Infrastructure screen shows the live count.
 */
export const NODES_DID_NOT_CONFIRM_MESSAGE =
  "The treasury's nodes did not confirm in time. At least 2 of its 3 nodes must be online; check Settings › Infrastructure, then try again.";

/**
 * Canton error ids that mean "not enough confirming nodes", "timed out waiting for confirmations"
 * or "the participant is not connected". Matched as a case-insensitive substring of the response's
 * `code` or `cause`.
 *
 * NOT VERIFIED against Canton 3.5: the ids come from the Canton error code reference as best
 * known, and the reference was not reachable when this was written. `scripts/bitsafe-demo.sh`
 * records the actual error the ledger returns while the treasury is below its hosting threshold
 * (docs/bitsafe-evidence/); correct this list from that record.
 */
export const NODE_CONFIRMATION_ERROR_IDS: readonly string[] = [
  // The mediator did not receive enough confirmation responses before the deadline.
  'MEDIATOR_SAYS_TX_TIMED_OUT',
  // The participant's own verdict wait ran out.
  'LOCAL_VERDICT_TIMEOUT',
  // The participant the command went to is not connected to a synchronizer.
  'NOT_CONNECTED_TO_ANY_SYNCHRONIZER',
  'NO_SYNCHRONIZER_FOR_SUBMISSION',
  // The command was not completed before its deadline.
  'SUBMISSION_TIMEOUT',
];

/**
 * Topology errors that also point at the treasury's hosting nodes, but only when the error names the
 * treasury party (a mistyped party id raises the same ids). Matched like `NODE_CONFIRMATION_ERROR_IDS`,
 * plus a case-insensitive "treasury" in the same text (the party id hint is `mithra-treasury`).
 * Same caveat: not verified against Canton 3.5.
 */
export const TREASURY_TOPOLOGY_ERROR_IDS: readonly string[] = [
  'PARTY_NOT_KNOWN_ON_LEDGER',
  'NO_SYNCHRONIZER_ON_WHICH_ALL_SUBMITTERS_CAN_SUBMIT',
  'UNKNOWN_INFORMEES',
];

/**
 * Where the raw ledger error behind a "treasury nodes did not confirm" message goes. The message for
 * people hides the Canton error id, and the id list above is unverified, so each mapped error is
 * written as one line to stderr (the backend's console): `scripts/bitsafe-demo.sh --backend-log FILE`
 * copies those lines into its report. Tests replace or silence it.
 */
let nodeConfirmationLogger: ((line: string) => void) | undefined = (line) => {
  process.stderr.write(`${line}\n`);
};

export function setNodeConfirmationLogger(logger: ((line: string) => void) | undefined): void {
  nodeConfirmationLogger = logger;
}

function logNodeConfirmationFailure(detail: Record<string, unknown>): void {
  nodeConfirmationLogger?.(
    `[mithra-ledger] treasury nodes did not confirm: ${JSON.stringify(detail)}`,
  );
}

/** True when the error text says the treasury's nodes could not confirm (see the lists above). */
export function isNodeConfirmationFailure(code: string, cause: string | undefined): boolean {
  const text = `${code} ${cause ?? ''}`.toLowerCase();
  const has = (ids: readonly string[]): boolean =>
    ids.some((id) => text.includes(id.toLowerCase()));
  return (
    has(NODE_CONFIRMATION_ERROR_IDS) ||
    (has(TREASURY_TOPOLOGY_ERROR_IDS) && text.includes('treasury'))
  );
}

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
    if (isNodeConfirmationFailure(code, cause)) {
      logNodeConfirmationFailure({ code, status, category, cause });
      return new LedgerError({
        code,
        message: NODES_DID_NOT_CONFIRM_MESSAGE,
        retryable: true,
        status,
        category,
        rawCause: cause,
      });
    }
    // 413 is the participant's list limit (`http-list-max-elements-limit`): the same request
    // fails the same way again, although the error category calls it transient.
    const retryable =
      !definite &&
      status !== 413 &&
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

/**
 * Wraps a failure to reach the ledger at all (connection refused, timeout, DNS). `path` is the
 * request path when the caller knows it: a command submission (`/v2/commands/...`) that times out
 * is reported as the treasury's nodes not confirming, because that is what a missing confirmation
 * looks like from the client (BitSafe, N8). Other timeouts keep the generic message.
 */
export function ledgerUnreachable(url: string, cause: unknown, path?: string): LedgerError {
  const isTimeout =
    cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
  if (isTimeout && path !== undefined && path.startsWith('/v2/commands/')) {
    logNodeConfirmationFailure({
      code: 'LEDGER_TIMEOUT',
      status: 0,
      cause: `no answer from ${url}${path} in time`,
    });
    return new LedgerError({
      code: 'LEDGER_TIMEOUT',
      message: NODES_DID_NOT_CONFIRM_MESSAGE,
      retryable: true,
      status: 0,
      cause,
    });
  }
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
