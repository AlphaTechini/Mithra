import { describe, expect, it } from 'vitest';
import { LedgerError, NODES_DID_NOT_CONFIRM_MESSAGE } from '../ledger/errors';
import { upstreamErrorResponse } from './errors';

describe('upstreamErrorResponse', () => {
  it('lets the "treasury nodes did not confirm" message through as a 503 with its own code', () => {
    const error = new LedgerError({
      code: 'LEDGER_TIMEOUT',
      message: NODES_DID_NOT_CONFIRM_MESSAGE,
      retryable: true,
      status: 0,
    });
    expect(upstreamErrorResponse(error)).toEqual({
      status: 503,
      body: {
        error: { code: 'treasury_nodes_unconfirmed', message: NODES_DID_NOT_CONFIRM_MESSAGE },
      },
    });
  });

  it('keeps the generic text for other retryable and unreachable ledger errors', () => {
    const unreachable = new LedgerError({
      code: 'LEDGER_UNREACHABLE',
      message: 'Cannot reach the ledger at http://x.',
      retryable: true,
      status: 0,
    });
    const response = upstreamErrorResponse(unreachable);
    expect(response?.status).toBe(503);
    expect(response?.body.error.code).toBe('ledger_unavailable');
    expect(response?.body.error.message).toContain('not reachable');
  });

  it('keeps mapping ledger rejections to 422 and other failures to 502', () => {
    const rejected = new LedgerError({
      code: 'DAML_FAILURE',
      message: 'Total above the cap',
      retryable: false,
      status: 400,
    });
    expect(upstreamErrorResponse(rejected)).toEqual({
      status: 422,
      body: { error: { code: 'ledger_rejected', message: 'Total above the cap' } },
    });
    const broken = new LedgerError({
      code: 'HTTP_500',
      message: 'boom',
      retryable: false,
      status: 500,
    });
    expect(upstreamErrorResponse(broken)?.status).toBe(502);
  });
});
