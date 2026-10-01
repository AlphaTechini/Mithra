import { describe, expect, it } from 'vitest';
import { ApiError } from '../http/errors';
import { LedgerError } from '../ledger';
import { RegistryError } from '../wallet';
import { holderError } from './errors';

const SECRET = 'party Bob::1220ff owes 1,500 CC';

describe('holderError', () => {
  it('hides a Daml message that names another holder or amount', () => {
    const mapped = holderError(
      new LedgerError({ code: 'DAML_FAILURE', message: SECRET, retryable: false, status: 409 }),
      'Accepting this payment',
    );
    expect(mapped?.apiError.status).toBe(422);
    expect(mapped?.apiError.code).toBe('holder_action_failed');
    expect(mapped?.apiError.message).toBe(
      'Accepting this payment failed. Try again in a minute. If it keeps failing, contact the fund.',
    );
    expect(mapped?.apiError.message).not.toContain('Bob');
    expect(mapped?.apiError.message).not.toContain('1,500');
    // The original stays available for the server log.
    expect(mapped?.detail).toBeInstanceOf(LedgerError);
  });

  it('says the ledger is unreachable for transient failures', () => {
    const mapped = holderError(
      new LedgerError({ code: 'LEDGER_UNREACHABLE', message: SECRET, retryable: true, status: 0 }),
      'Accepting these units',
    );
    expect(mapped?.apiError).toMatchObject({ status: 503, code: 'ledger_unavailable' });
    expect(mapped?.apiError.message).toContain('Accepting these units');
    expect(mapped?.apiError.message).not.toContain('Bob');
  });

  it('hides registry error text', () => {
    const mapped = holderError(
      new RegistryError('registry answered HTTP 500 for receiver Bob', 500),
      'Turning on auto-receive',
    );
    expect(mapped?.apiError).toMatchObject({ status: 502, code: 'registry_unavailable' });
    expect(mapped?.apiError.message).not.toContain('Bob');
  });

  it('passes API errors through and ignores unknown errors', () => {
    const api = new ApiError(404, 'not_found', 'Nothing here. Refresh.');
    expect(holderError(api, 'x')?.apiError).toBe(api);
    expect(holderError(new Error('boom'), 'x')).toBeUndefined();
  });
});
