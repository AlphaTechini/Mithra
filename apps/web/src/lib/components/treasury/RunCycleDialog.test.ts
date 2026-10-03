import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionStore } from '$lib/stores/session.svelte';
import { sessionRoutes } from '../../../test/treasury/fixtures';
import { stubApi } from '../../../test/treasury/stub';
import RunCycleDialog from './RunCycleDialog.svelte';

vi.mock('$lib/nav', () => ({ navigate: vi.fn(() => Promise.resolve()) }));

const RUN = 'POST /api/cycles/run';
const MESSAGE = 'Enter the total as a number above zero, like 1200 or 1200.50.';

beforeEach(() => sessionStore.reset());
afterEach(() => vi.unstubAllGlobals());

function open() {
  const api = stubApi({ ...sessionRoutes('treasurer'), [RUN]: { cycleId: '2026-09' } });
  render(RunCycleDialog, { props: { mandate: null, onclose: vi.fn() } });
  return { api, total: screen.getByLabelText(/^Total/) };
}

describe('RunCycleDialog total', () => {
  it.each(['0', '0.00', '-5', '-1200.50', 'abc'])(
    'rejects %s and does not start the cycle',
    async (value) => {
      const { api, total } = open();
      await fireEvent.input(total, { target: { value } });
      expect(await screen.findByText(MESSAGE)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Run cycle now' })).toBeDisabled();
      await fireEvent.submit(total.closest('form')!);
      expect(api.callsTo(RUN)).toHaveLength(0);
    },
  );

  it('accepts an empty total (the mandate decides) and a positive one', async () => {
    const { api, total } = open();
    expect(screen.queryByText(MESSAGE)).toBeNull();
    await fireEvent.input(total, { target: { value: '1200.50' } });
    expect(screen.queryByText(MESSAGE)).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Run cycle now' }));
    await waitFor(() => expect(api.callsTo(RUN)).toHaveLength(1));
    expect(api.callsTo(RUN)[0]?.body).toMatchObject({ total: '1200.50' });
  });
});
