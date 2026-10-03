import { ApiError } from '../http/errors';
import { LedgerError } from '../ledger';
import { RegistryError } from '../wallet/tokenStandard';

/**
 * Turns a failure on a holder route into an error that is safe to show a holder (U7, L7). Ledger
 * messages can name other parties or amounts, so only a generic sentence about what the holder
 * tried reaches the response; `detail` carries the original for the server log.
 *
 * `action` is a gerund phrase: "Accepting this payment", "Accepting these units",
 * "Turning on auto-receive", "Loading your position".
 */
export function holderError(
  error: unknown,
  action: string,
): { apiError: ApiError; detail: unknown } | undefined {
  if (error instanceof ApiError) return { apiError: error, detail: error };
  if (error instanceof LedgerError) {
    if (error.status === 0 || error.retryable) {
      return {
        apiError: new ApiError(
          503,
          'ledger_unavailable',
          `${action} did not go through because the ledger is not reachable right now. Try again in a minute.`,
        ),
        detail: error,
      };
    }
    return {
      apiError: new ApiError(
        422,
        'holder_action_failed',
        `${action} failed. Try again in a minute. If it keeps failing, contact the fund.`,
      ),
      detail: error,
    };
  }
  if (error instanceof RegistryError) {
    return {
      apiError: new ApiError(
        502,
        'registry_unavailable',
        `${action} did not go through because the token registry did not answer. Try again in a minute.`,
      ),
      detail: error,
    };
  }
  return undefined;
}
