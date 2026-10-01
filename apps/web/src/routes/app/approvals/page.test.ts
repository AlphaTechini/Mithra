import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callsTo, json, stubApi } from '$lib/components/holder/fixtures';
import Page from './+page.svelte';

const pending = [
  {
    cycleId: 'cyc-1',
    proposalId: 'prop-1',
    label: 'September 2026',
    total: '1200.0000000000',
    flagCount: 2,
    approvals: { have: 1, need: 2 },
    youApproved: true,
    createdAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
  },
  {
    cycleId: 'cyc-2',
    proposalId: 'prop-2',
    label: 'October 2026',
    total: '300.0000000000',
    flagCount: 0,
    approvals: { have: 0, need: 2 },
    youApproved: false,
    createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  },
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('approvals inbox', () => {
  it('lists pending proposals with total, flags, age and progress, each opening the cycle', async () => {
    stubApi({ 'GET /api/approvals': { pending } });
    render(Page);

    const first = await screen.findByRole('link', { name: /September 2026/ });
    expect(first).toHaveAttribute('href', '/app/cycles/cyc-1');
    expect(first).toHaveTextContent('1,200.00');
    expect(first).toHaveTextContent('2 flags');
    expect(first).toHaveTextContent('3 hours ago');
    expect(first).toHaveTextContent('1 of 2 approved');
    expect(first).toHaveTextContent('You approved');

    const second = screen.getByRole('link', { name: /October 2026/ });
    expect(second).toHaveAttribute('href', '/app/cycles/cyc-2');
    expect(second).toHaveTextContent('No flags');
    expect(second).toHaveTextContent('2 days ago');
    expect(second).toHaveTextContent('0 of 2 approved');
    expect(second).not.toHaveTextContent('You approved');
  });

  it('shows the empty state when nothing is pending', async () => {
    stubApi({ 'GET /api/approvals': { pending: [] } });
    render(Page);
    expect(await screen.findByText('Nothing waiting for your approval.')).toBeInTheDocument();
  });

  it('shows what failed with a retry when the inbox cannot load', async () => {
    stubApi({
      'GET /api/approvals': () =>
        json({ error: { code: 'forbidden', message: 'Only approvers can open the inbox.' } }, 403),
    });
    render(Page);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only approvers can open the inbox.',
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('refreshes every 15 seconds and when the window regains focus', async () => {
    const fetchMock = stubApi({ 'GET /api/approvals': { pending: [] } });
    render(Page);
    await screen.findByText('Nothing waiting for your approval.');
    expect(callsTo(fetchMock, 'GET /api/approvals')).toBe(1);

    await vi.advanceTimersByTimeAsync(15_000);
    await waitFor(() => expect(callsTo(fetchMock, 'GET /api/approvals')).toBe(2));

    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(callsTo(fetchMock, 'GET /api/approvals')).toBe(3));
  });
});
