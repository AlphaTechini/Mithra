import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionStore } from '$lib/stores/session.svelte';
import { sessionRoutes } from '../../../test/treasury/fixtures';
import { stubApi } from '../../../test/treasury/stub';
import AddFundsDialog from './AddFundsDialog.svelte';

const FUND = 'POST /api/treasury/fund';
const MESSAGE = 'Enter an amount above zero, like 500 or 1200.50.';

beforeEach(() => sessionStore.reset());
afterEach(() => vi.unstubAllGlobals());

async function open() {
  const api = stubApi({ ...sessionRoutes('treasurer'), [FUND]: null });
  await sessionStore.load();
  const ondone = vi.fn();
  render(AddFundsDialog, { props: { required: '500', onclose: vi.fn(), ondone } });
  return { api, ondone, amount: screen.getByLabelText(/^Amount/) };
}

describe('AddFundsDialog amount', () => {
  it.each(['0', '0.0', '-500', '-0.5', 'abc'])('rejects %s and adds nothing', async (value) => {
    const { api, amount } = await open();
    await fireEvent.input(amount, { target: { value } });
    expect(await screen.findByText(MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add funds' })).toBeDisabled();
    await fireEvent.submit(amount.closest('form')!);
    expect(api.callsTo(FUND)).toHaveLength(0);
  });

  it('accepts a positive amount', async () => {
    const { api, ondone, amount } = await open();
    expect(screen.queryByText(MESSAGE)).toBeNull();
    await fireEvent.input(amount, { target: { value: '1200.50' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add funds' }));
    await waitFor(() => expect(api.callsTo(FUND)).toHaveLength(1));
    expect(api.callsTo(FUND)[0]?.body).toEqual({ amount: '1200.50' });
    await waitFor(() => expect(ondone).toHaveBeenCalled());
  });
});
