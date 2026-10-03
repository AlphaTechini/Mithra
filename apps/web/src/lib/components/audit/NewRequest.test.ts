import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopeDraft } from '@mithra/shared';
import { toasts } from '$lib/stores/toasts.svelte';
import { deferred, stubApi } from '../../../test/treasury/stub';
import { DRAFT } from './fixtures';
import NewRequest from './NewRequest.svelte';

const FIRST = 'Show all Q3 distributions.';
const SECOND = 'Show the approvals behind the flagged cycle.';

beforeEach(() => toasts.clear());
afterEach(() => vi.unstubAllGlobals());

describe('New request', () => {
  it('ignores a proposal that arrives after the question changed, and cannot submit it', async () => {
    const first = deferred<ScopeDraft>();
    const second: ScopeDraft = {
      ...DRAFT,
      items: [DRAFT.items[2]!],
      excluded: 'Everything else.',
    };
    let calls = 0;
    const api = stubApi({
      'POST /api/audit/scope/draft': () => (++calls === 1 ? first.promise : second),
      'POST /api/audit/requests': { requestId: 'req-1' },
    });
    const oncreated = vi.fn();
    render(NewRequest, { oncreated });

    const box = screen.getByLabelText('What do you need to see?');
    await fireEvent.input(box, { target: { value: FIRST } });
    await fireEvent.click(screen.getByRole('button', { name: 'Propose scope' }));
    await waitFor(() => expect(api.callsTo('POST /api/audit/scope/draft')).toHaveLength(1));

    // The person edits the question while the first proposal is still being written.
    await fireEvent.input(box, { target: { value: SECOND } });
    first.resolve(DRAFT);
    // Let the late response be handled.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
    // The old answer is not shown for the new question and cannot be requested.
    expect(screen.queryByRole('list', { name: 'Proposed records' })).toBeNull();
    expect(screen.queryByText(DRAFT.excluded)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Request access' })).toBeNull();
    expect(api.callsTo('POST /api/audit/requests')).toHaveLength(0);

    // Proposing again answers the new question.
    await fireEvent.click(screen.getByRole('button', { name: 'Propose scope' }));
    expect(await screen.findByText('Everything else.')).toBeInTheDocument();
    expect(api.callsTo('POST /api/audit/scope/draft')[1]?.body).toEqual({ question: SECOND });
    await fireEvent.click(screen.getByRole('button', { name: 'Request access' }));
    await waitFor(() => expect(api.callsTo('POST /api/audit/requests')).toHaveLength(1));
    expect(api.callsTo('POST /api/audit/requests')[0]?.body).toMatchObject({ question: SECOND });
  });

  it('shows the proposal when the question did not change', async () => {
    stubApi({ 'POST /api/audit/scope/draft': DRAFT });
    render(NewRequest, { oncreated: vi.fn() });
    await fireEvent.input(screen.getByLabelText('What do you need to see?'), {
      target: { value: FIRST },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Propose scope' }));
    expect(await screen.findByRole('list', { name: 'Proposed records' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request access' })).toBeEnabled();
  });
});
