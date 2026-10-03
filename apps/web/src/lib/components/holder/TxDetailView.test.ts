import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionStore } from '$lib/stores/session.svelte';
import { deferred } from '../../../test/treasury/stub';
import { configFor, HOLDER_A, HOLDER_B, holderSession, json, stubApi } from './fixtures';
import TxDetailView from './TxDetailView.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn(() => Promise.resolve()) }));

const tx = {
  updateId: '1220deadbeef',
  recordTime: '2026-10-01T09:00:04.123Z',
  payments: [
    { holder: HOLDER_A, amount: '300.0000000000', status: 'paid', cycleLabel: 'September 2026' },
    {
      holder: { partyId: HOLDER_B.partyId, displayName: HOLDER_B.displayName },
      amount: HOLDER_B.amount,
      status: 'paid',
      cycleLabel: 'September 2026',
    },
  ],
};

beforeEach(async () => {
  sessionStore.reset();
  stubApi({
    'GET /api/session': holderSession(),
    'GET /api/config/public': configFor(),
  });
  await sessionStore.load();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TxDetailView', () => {
  it('holder view: update id, record time and only the holder own payment, with no names', async () => {
    stubApi({ 'GET /api/tx/1220deadbeef': tx });
    const { container } = render(TxDetailView, { updateId: '1220deadbeef', viewer: 'holder' });
    expect(await screen.findByText('1220deadbeef')).toBeInTheDocument();
    expect(screen.getByText('2026-10-01 09:00:04 UTC')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy transaction ID' })).toBeInTheDocument();
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows).toHaveLength(2); // header + the holder's own payment
    expect(container.textContent).toContain('300.00');
    expect(container.textContent).not.toContain(HOLDER_B.displayName);
    expect(container.textContent).not.toContain(HOLDER_A.displayName);
    expect(container.textContent).not.toContain('4,321.56');
  });

  it('staff view: shows every payment the server returned with holder names', async () => {
    stubApi({ 'GET /api/tx/1220deadbeef': tx });
    render(TxDetailView, { updateId: '1220deadbeef', viewer: 'staff' });
    expect(await screen.findByText('Holder B')).toBeInTheDocument();
    expect(screen.getByText('Holder A')).toBeInTheDocument();
  });

  it('shows the server message when the transaction is not available', async () => {
    stubApi({
      'GET /api/tx/1220deadbeef': () =>
        json({ error: { code: 'not_found', message: 'No such transaction.' } }, 404),
    });
    render(TxDetailView, { updateId: '1220deadbeef', viewer: 'holder' });
    expect(await screen.findByRole('alert')).toHaveTextContent('No such transaction.');
  });
  it('loads again when the update id changes', async () => {
    stubApi({
      'GET /api/tx/1220aaaa': { ...tx, updateId: '1220aaaa' },
      'GET /api/tx/1220bbbb': { ...tx, updateId: '1220bbbb' },
    });
    const view = render(TxDetailView, { updateId: '1220aaaa', viewer: 'holder' });
    expect(await screen.findByText('1220aaaa')).toBeInTheDocument();
    await view.rerender({ updateId: '1220bbbb', viewer: 'holder' });
    expect(await screen.findByText('1220bbbb')).toBeInTheDocument();
    expect(screen.queryByText('1220aaaa')).toBeNull();
  });

  it('applies only the latest response when the id changes while an older request is out', async () => {
    const slow = deferred<unknown>();
    stubApi({
      'GET /api/tx/1220aaaa': () => slow.promise.then((body) => json(body)),
      'GET /api/tx/1220bbbb': { ...tx, updateId: '1220bbbb' },
    });
    const view = render(TxDetailView, { updateId: '1220aaaa', viewer: 'holder' });
    await view.rerender({ updateId: '1220bbbb', viewer: 'holder' });
    expect(await screen.findByText('1220bbbb')).toBeInTheDocument();
    slow.resolve({ ...tx, updateId: '1220aaaa' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText('1220aaaa')).toBeNull();
    expect(screen.getByText('1220bbbb')).toBeInTheDocument();
  });

  it('a failed retry keeps showing the error, and a retry that works replaces it', async () => {
    let attempts = 0;
    stubApi({
      'GET /api/tx/1220deadbeef': () =>
        ++attempts < 3
          ? json({ error: { code: 'not_found', message: 'No such transaction.' } }, 404)
          : json(tx),
    });
    render(TxDetailView, { updateId: '1220deadbeef', viewer: 'holder' });
    expect(await screen.findByRole('alert')).toHaveTextContent('No such transaction.');
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(attempts).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await screen.findByRole('alert')).toHaveTextContent('No such transaction.');
    expect(screen.queryByText('1220deadbeef')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('1220deadbeef')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('after an id change the old transaction is gone while the new one loads or fails', async () => {
    stubApi({
      'GET /api/tx/1220aaaa': { ...tx, updateId: '1220aaaa' },
      'GET /api/tx/1220cccc': () =>
        json({ error: { code: 'not_found', message: 'No such transaction.' } }, 404),
    });
    const view = render(TxDetailView, { updateId: '1220aaaa', viewer: 'holder' });
    expect(await screen.findByText('1220aaaa')).toBeInTheDocument();
    await view.rerender({ updateId: '1220cccc', viewer: 'holder' });
    expect(await screen.findByRole('alert')).toHaveTextContent('No such transaction.');
    expect(screen.queryByText('1220aaaa')).toBeNull();
  });
});
