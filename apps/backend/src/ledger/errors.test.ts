import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LedgerError,
  NODES_DID_NOT_CONFIRM_MESSAGE,
  NODE_CONFIRMATION_ERROR_IDS,
  cleanCause,
  isNodeConfirmationFailure,
  ledgerErrorFromResponse,
  ledgerUnreachable,
  setNodeConfirmationLogger,
} from './errors';

describe('cleanCause', () => {
  it('keeps the Daml assertion message', () => {
    expect(
      cleanCause(
        'Interpretation error: Error: User failure: UNHANDLED_EXCEPTION/DA.Exception.AssertionFailed:AssertionFailed (error category 9): Total 5,000.0000000001 CC is above the auto-execute cap of 5,000 CC',
      ),
    ).toBe('Total 5,000.0000000001 CC is above the auto-execute cap of 5,000 CC');
  });

  it('handles the hash suffix form and abort messages', () => {
    expect(
      cleanCause(
        'Interpretation error: Error: User failure: UNHANDLED_EXCEPTION/DA.Exception.GeneralError:GeneralError@3f4deaf1: The transfer failed',
      ),
    ).toBe('The transfer failed');
  });

  it('turns a failed ensure into a short sentence', () => {
    const cause =
      "Interpretation error: Error: User failure: UNHANDLED_EXCEPTION/DA.Exception.PreconditionFailed:PreconditionFailed (error category 9): Template precondition violated: Organization {treasury = 'x', approvers = []}";
    expect(cleanCause(cause)).toContain('Organization');
    expect(cleanCause(cause)).not.toContain('UNHANDLED_EXCEPTION');
    expect(cleanCause(cause)).not.toContain('treasury =');
  });

  it('leaves other messages alone', () => {
    expect(cleanCause('Contract could not be found with id 00ab')).toBe(
      'Contract could not be found with id 00ab',
    );
  });
});

describe('ledgerErrorFromResponse', () => {
  it('maps a Daml failure to a non-retryable error with the clean message', () => {
    const error = ledgerErrorFromResponse(400, {
      code: 'DAML_FAILURE',
      cause:
        'Interpretation error: Error: User failure: UNHANDLED_EXCEPTION/DA.Exception.AssertionFailed:AssertionFailed (error category 9): Payees and amounts must equal the pro-rata split',
      errorCategory: 9,
      definiteAnswer: null,
    });
    expect(error).toBeInstanceOf(LedgerError);
    expect(error).toMatchObject({
      code: 'DAML_FAILURE',
      message: 'Payees and amounts must equal the pro-rata split',
      retryable: false,
      status: 400,
      category: 9,
    });
  });

  it('marks transient categories and gateway statuses retryable, unless the answer is definite', () => {
    expect(
      ledgerErrorFromResponse(503, { code: 'X', cause: 'busy', errorCategory: 1 }).retryable,
    ).toBe(true);
    expect(
      ledgerErrorFromResponse(409, { code: 'X', cause: 'contention', errorCategory: 2 }).retryable,
    ).toBe(true);
    expect(ledgerErrorFromResponse(502, 'Bad gateway').retryable).toBe(true);
    expect(
      ledgerErrorFromResponse(503, {
        code: 'X',
        cause: 'busy',
        errorCategory: 1,
        definiteAnswer: true,
      }).retryable,
    ).toBe(false);
    expect(
      ledgerErrorFromResponse(400, {
        code: 'PARTY_ALLOCATION_WITHOUT_CONNECTED_SYNCHRONIZER',
        cause: 'wait',
      }).retryable,
    ).toBe(true);
  });

  it('retries a command whose input contracts routing does not know yet', () => {
    const error = ledgerErrorFromResponse(400, {
      code: 'UNKNOWN_CONTRACT_SYNCHRONIZERS',
      cause:
        'The synchronizers for the contracts (00f3, 004a) are currently unknown due to ongoing contract reassignments or disconnected synchronizers.',
      errorCategory: 9,
    });
    expect(error.retryable).toBe(true);
    expect(error.code).toBe('UNKNOWN_CONTRACT_SYNCHRONIZERS');
  });

  it('copes with a body that is not a ledger error', () => {
    expect(ledgerErrorFromResponse(404, 'not here')).toMatchObject({
      code: 'HTTP_404',
      message: 'not here',
    });
    expect(ledgerErrorFromResponse(500, undefined).message).toBe(
      'The ledger answered with HTTP 500',
    );
  });
});

describe('ledgerUnreachable', () => {
  it('says what to check and is retryable', () => {
    const error = ledgerUnreachable('http://localhost:7575', new TypeError('fetch failed'));
    expect(error).toMatchObject({ code: 'LEDGER_UNREACHABLE', retryable: true, status: 0 });
    expect(error.message).toContain('LEDGER_JSON_API_URL');
  });

  it('distinguishes a timeout', () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    expect(ledgerUnreachable('http://x', timeout).code).toBe('LEDGER_TIMEOUT');
  });
});

describe('treasury nodes did not confirm (BitSafe, N8)', () => {
  const MESSAGE =
    "The treasury's nodes did not confirm in time. At least 2 of its 3 nodes must be online; check Settings › Infrastructure, then try again.";

  const logged: string[] = [];
  beforeEach(() => {
    logged.length = 0;
    setNodeConfirmationLogger((line) => logged.push(line));
  });
  afterEach(() => {
    setNodeConfirmationLogger((line) => process.stderr.write(`${line}\n`));
  });

  it('logs the raw error once so the id list can be corrected', () => {
    ledgerErrorFromResponse(503, {
      code: 'MEDIATOR_SAYS_TX_TIMED_OUT',
      cause: 'Rejected transaction as the mediator did not receive sufficient confirmations',
      errorCategory: 4,
    });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('[mithra-ledger] treasury nodes did not confirm:');
    expect(logged[0]).toContain('MEDIATOR_SAYS_TX_TIMED_OUT');
    expect(logged[0]).toContain('did not receive sufficient confirmations');
    ledgerErrorFromResponse(400, { code: 'DAML_FAILURE', cause: 'Total above the cap' });
    expect(logged).toHaveLength(1);
  });

  it('uses the documented message', () => {
    expect(NODES_DID_NOT_CONFIRM_MESSAGE).toBe(MESSAGE);
  });

  it.each(NODE_CONFIRMATION_ERROR_IDS)('maps %s in the code to a retryable error', (id) => {
    const error = ledgerErrorFromResponse(503, {
      code: id,
      cause: 'Some Canton text',
      errorCategory: 4,
      definiteAnswer: false,
    });
    expect(error).toMatchObject({
      code: id,
      message: MESSAGE,
      retryable: true,
      status: 503,
      category: 4,
      rawCause: 'Some Canton text',
    });
  });

  it('finds the id in the cause, ignoring case', () => {
    const error = ledgerErrorFromResponse(400, {
      code: 'SOME_WRAPPER',
      cause: 'Request failed: mediator_says_tx_timed_out (rejected by mediator)',
      errorCategory: 9,
      definiteAnswer: true,
    });
    expect(error.message).toBe(MESSAGE);
    expect(error.retryable).toBe(true);
  });

  it('maps topology errors only when they name the treasury', () => {
    const treasury = ledgerErrorFromResponse(400, {
      code: 'PARTY_NOT_KNOWN_ON_LEDGER',
      cause: 'Parties not known on ledger: mithra-treasury::1220abcd',
    });
    expect(treasury.message).toBe(MESSAGE);
    expect(treasury.retryable).toBe(true);
    const other = ledgerErrorFromResponse(400, {
      code: 'PARTY_NOT_KNOWN_ON_LEDGER',
      cause: 'Parties not known on ledger: someone-else::1220abcd',
    });
    expect(other.message).toBe('Parties not known on ledger: someone-else::1220abcd');
    expect(other.retryable).toBe(false);
  });

  it('leaves unrelated errors alone', () => {
    expect(isNodeConfirmationFailure('DAML_FAILURE', 'Total above the cap')).toBe(false);
    expect(isNodeConfirmationFailure('CONTRACT_NOT_FOUND', undefined)).toBe(false);
    expect(
      ledgerErrorFromResponse(400, { code: 'DAML_FAILURE', cause: 'Total above the cap' }).message,
    ).toBe('Total above the cap');
  });

  it('reports a submit that times out, but not other timeouts', () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const submit = ledgerUnreachable(
      'http://x',
      timeout,
      '/v2/commands/submit-and-wait-for-transaction',
    );
    expect(submit).toMatchObject({
      code: 'LEDGER_TIMEOUT',
      message: MESSAGE,
      retryable: true,
      status: 0,
    });
    const read = ledgerUnreachable('http://x', timeout, '/v2/state/active-contracts');
    expect(read.message).toContain('did not answer in time');
    // A refused connection on submit is not a missing confirmation.
    const refused = ledgerUnreachable(
      'http://x',
      new TypeError('fetch failed'),
      '/v2/commands/submit-and-wait-for-transaction',
    );
    expect(refused.code).toBe('LEDGER_UNREACHABLE');
  });
});
