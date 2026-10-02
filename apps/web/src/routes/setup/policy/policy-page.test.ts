import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PolicyFields } from '@mithra/shared';
import { live } from '$lib/stores/live.svelte';
import { sessionStore } from '$lib/stores/session.svelte';
import { draft, sessionRoutes } from '../../../test/treasury/fixtures';
import { errorResponse, stubApi } from '../../../test/treasury/stub';
import Page from './+page.svelte';

const goto = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('$app/navigation', () => ({ goto }));

const ORG = {
  setupStep: 'policy',
  organization: null,
  mandate: null,
};

function putBody(call: { body: unknown }): PolicyFields {
  return (call.body as { fields: PolicyFields }).fields;
}

beforeEach(() => {
  sessionStore.reset();
  live.reset();
  goto.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('setup policy page', () => {
  it('updates the summary from the PUT response, not from local text', async () => {
    const api = stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/org': ORG,
      'GET /api/policy/draft': draft(),
      'PUT /api/policy/draft': (call: { body: unknown }) =>
        draft({
          fields: putBody(call),
          source: 'edited',
          summary: `Server summary: cap ${putBody(call).cap} CC, approvals ${putBody(call).approvalThreshold}.`,
        }),
    });
    render(Page);

    expect(
      await screen.findByText('Pays monthly on the 1st. Auto-pays up to 5,000 CC.'),
    ).toBeInTheDocument();
    const cap = screen.getByLabelText('Auto-execute cap (CC)');
    await fireEvent.input(cap, { target: { value: '3000' } });
    await fireEvent.input(cap, { target: { value: '3000.5' } });

    // Not saved yet: the summary is still the server's last one.
    expect(screen.queryByText(/Server summary/)).toBeNull();
    await waitFor(() => expect(api.callsTo('PUT /api/policy/draft')).toHaveLength(1), {
      timeout: 3000,
    });
    // Two quick edits, one save after the 400 ms pause, with the latest value.
    expect(putBody(api.callsTo('PUT /api/policy/draft')[0]!).cap).toBe('3000.5');
    expect(
      await screen.findByText('Server summary: cap 3000.5 CC, approvals 2.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Edited by you.')).toBeInTheDocument();
  });

  it('flags a malformed field and does not save it', async () => {
    const api = stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/org': ORG,
      'GET /api/policy/draft': draft(),
      'PUT /api/policy/draft': draft(),
    });
    render(Page);
    const cap = await screen.findByLabelText('Auto-execute cap (CC)');
    await fireEvent.input(cap, { target: { value: 'lots' } });
    expect(
      await screen.findByText('Enter the cap as a number above zero, like 5000.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review mandate' })).toBeDisabled();
    await new Promise((r) => setTimeout(r, 600));
    expect(api.callsTo('PUT /api/policy/draft')).toHaveLength(0);
  });

  it('asks the agent, fills the card from its draft and keeps the box for the next prompt', async () => {
    const api = stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/org': ORG,
      'GET /api/policy/draft': () => errorResponse(404, 'no_draft', 'No draft yet'),
      'POST /api/policy/draft': () =>
        draft({ fields: { ...draft().fields, cap: '3000' }, summary: 'Cap is 3,000 CC.' }),
    });
    render(Page);

    await screen.findByText(/No policy yet/);
    const prompt = screen.getByLabelText('Describe your policy');
    expect(prompt).toHaveAttribute(
      'placeholder',
      expect.stringContaining('Pay monthly yield on the 1st'),
    );
    await fireEvent.input(prompt, { target: { value: 'make the cap 3,000' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Ask the agent' }));

    expect(await screen.findByText('Cap is 3,000 CC.')).toBeInTheDocument();
    expect(api.callsTo('POST /api/policy/draft')[0]?.body).toEqual({
      prompt: 'make the cap 3,000',
    });
    expect(screen.getByLabelText('Auto-execute cap (CC)')).toHaveValue('3000');
    expect(screen.getByLabelText('Describe your policy')).toBeInTheDocument();
  });

  it('shows the 503 message and keeps the form usable when the model is unavailable', async () => {
    stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/org': ORG,
      'GET /api/policy/draft': draft(),
      'POST /api/policy/draft': () =>
        errorResponse(
          503,
          'llm_unavailable',
          'The agent can’t reach its language model. Edit the fields yourself, or try again in a minute.',
        ),
    });
    render(Page);
    await fireEvent.input(await screen.findByLabelText('Describe your policy'), {
      target: { value: 'pay monthly' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Ask the agent' }));
    expect(await screen.findByText(/can’t reach its language model/)).toBeInTheDocument();
    expect(screen.getByLabelText('Auto-execute cap (CC)')).toBeEnabled();
    expect(screen.getByLabelText('Describe your policy')).toBeEnabled();
  });

  it('shows a skeleton while the agent drafts', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/org': ORG,
      'GET /api/policy/draft': () => errorResponse(404, 'no_draft', 'No draft yet'),
      'POST /api/policy/draft': () => gate.then(() => draft()),
    });
    render(Page);
    await fireEvent.input(await screen.findByLabelText('Describe your policy'), {
      target: { value: 'pay monthly' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Ask the agent' }));
    expect(await screen.findByRole('status', { name: '' })).toBeTruthy();
    expect(screen.getByText('The agent is drafting your policy')).toBeInTheDocument();
    release();
    expect(
      await screen.findByText('Pays monthly on the 1st. Auto-pays up to 5,000 CC.'),
    ).toBeInTheDocument();
  });

  it('saves a pending edit before moving on to the mandate', async () => {
    const api = stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/org': ORG,
      'GET /api/policy/draft': draft(),
      'PUT /api/policy/draft': (call: { body: unknown }) => draft({ fields: putBody(call) }),
    });
    render(Page);
    await fireEvent.input(await screen.findByLabelText('Auto-execute cap (CC)'), {
      target: { value: '2500' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Review mandate' }));
    await waitFor(() => expect(goto).toHaveBeenCalledWith('/setup/mandate', expect.anything()));
    expect(api.callsTo('PUT /api/policy/draft')).toHaveLength(1);
    expect(putBody(api.callsTo('PUT /api/policy/draft')[0]!).cap).toBe('2500');
  });
});
