import { describe, expect, it } from 'vitest';
import { LedgerError, cleanCause, ledgerErrorFromResponse, ledgerUnreachable } from './errors';

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
