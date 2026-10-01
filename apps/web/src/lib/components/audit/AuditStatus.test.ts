import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { grantedView, requestView } from './fixtures';
import AuditStatus from './AuditStatus.svelte';

function chipOf(request: Parameters<typeof render<typeof AuditStatus>>[1]) {
  const { container } = render(AuditStatus, request);
  return container.querySelector('[data-kind]');
}

describe('AuditStatus', () => {
  it('uses the shared StatusChip for a request waiting for the treasurer and a withdrawn one', () => {
    const waiting = chipOf({ request: requestView({ status: 'pending' }) });
    expect(waiting?.getAttribute('data-kind')).toBe('waiting-treasurer');
    expect(waiting?.textContent?.trim()).toBe('Waiting for the treasurer');
    const withdrawn = chipOf({ request: requestView({ status: 'withdrawn' }) });
    expect(withdrawn?.getAttribute('data-kind')).toBe('withdrawn');
    expect(withdrawn?.textContent?.trim()).toBe('Request withdrawn');
  });

  it('keeps the chips for granted and denied requests', () => {
    expect(chipOf({ request: grantedView() })?.getAttribute('data-kind')).toBe('active');
    expect(chipOf({ request: requestView({ status: 'denied' }) })?.getAttribute('data-kind')).toBe(
      'denied',
    );
  });
});
