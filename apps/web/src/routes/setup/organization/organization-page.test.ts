import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { live } from '$lib/stores/live.svelte';
import { sessionStore } from '$lib/stores/session.svelte';
import {
  APPROVER_1,
  APPROVER_2,
  APPROVER_3,
  HOLDER_A,
  TREASURER,
  sessionRoutes,
} from '../../../test/treasury/fixtures';
import { stubApi } from '../../../test/treasury/stub';
import Page from './+page.svelte';

const goto = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('$app/navigation', () => ({ goto }));

const FRESH = { setupStep: 'organization', organization: null, mandate: null };
const ID_A = 'carol::1220aabbccdd';
const ID_B = 'dave::1220eeff0011';

beforeEach(() => {
  sessionStore.reset();
  live.reset();
  goto.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function mainnet() {
  const api = stubApi({ ...sessionRoutes('treasurer', 'mainnet'), 'GET /api/org': FRESH });
  await sessionStore.load();
  return api;
}

describe('setup organization page', () => {
  it('flags a duplicate approver on the field and does not continue', async () => {
    const api = await mainnet();
    api.route('POST /api/org', {});
    render(Page);

    await fireEvent.input(await screen.findByLabelText('Treasury name'), {
      target: { value: 'Acme Fund' },
    });
    await fireEvent.input(screen.getByLabelText('Approver 1 party id'), {
      target: { value: ID_A },
    });
    await fireEvent.input(screen.getByLabelText('Approver 2 party id'), {
      target: { value: ID_A },
    });

    expect(
      await screen.findByText(
        'This party is already in the list. Each approver can be added once.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Approver 2 party id')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Approver 1 party id')).not.toHaveAttribute('aria-invalid');

    await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(api.callsTo('POST /api/org')).toHaveLength(0);
  });

  it('flags a malformed party id', async () => {
    await mainnet();
    render(Page);
    await fireEvent.input(await screen.findByLabelText('Approver 1 party id'), {
      target: { value: 'carol' },
    });
    expect(await screen.findByText(/This is not a party id/)).toBeInTheDocument();
  });

  it('flags a missing name and missing approvers when continuing', async () => {
    const api = await mainnet();
    render(Page);
    await fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Enter a name for the treasury.')).toBeInTheDocument();
    expect(screen.getByText('Add at least one approver by party id.')).toBeInTheDocument();
    expect(api.callsTo('POST /api/org')).toHaveLength(0);
  });

  it('creates the organization and goes to the policy step, with the threshold as "2 of 3"', async () => {
    const api = await mainnet();
    api.route('POST /api/org', {});
    render(Page);

    await fireEvent.input(await screen.findByLabelText('Treasury name'), {
      target: { value: 'Acme Fund' },
    });
    await fireEvent.input(screen.getByLabelText('Approver 1 party id'), {
      target: { value: ID_A },
    });
    await fireEvent.input(screen.getByLabelText('Approver 2 party id'), {
      target: { value: ID_B },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Add approver' }));
    await fireEvent.input(screen.getByLabelText('Approver 3 party id'), {
      target: { value: 'erin::1220deadbeef' },
    });

    const threshold = screen.getByLabelText('Approval threshold');
    await fireEvent.change(threshold, { target: { value: '2' } });
    expect(screen.getByRole('option', { name: '2 of 3' })).toBeInTheDocument();
    // The ring previews the threshold with nothing signed yet.
    expect(screen.getByRole('img', { name: /^0 of 2 signatures/ })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(api.callsTo('POST /api/org')).toHaveLength(1));
    expect(api.callsTo('POST /api/org')[0]?.body).toEqual({
      name: 'Acme Fund',
      approvers: [ID_A, ID_B, 'erin::1220deadbeef'],
      approvalThreshold: 2,
    });
    await waitFor(() => expect(goto).toHaveBeenCalledWith('/setup/policy', expect.anything()));
  });

  it('lets LocalNet pick approvers from the demo parties, with the three approvers chosen', async () => {
    const api = stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/org': FRESH,
      'GET /api/session/demo-parties': {
        parties: [
          { ...TREASURER, roles: ['treasurer'] },
          { ...APPROVER_1, roles: ['approver'] },
          { ...APPROVER_2, roles: ['approver'] },
          { ...APPROVER_3, roles: ['approver'] },
          { ...HOLDER_A, roles: ['holder'] },
        ],
      },
      'POST /api/org': {},
    });
    await sessionStore.load();
    render(Page);

    await fireEvent.input(await screen.findByLabelText('Treasury name'), {
      target: { value: 'Acme Fund' },
    });
    expect(await screen.findByRole('checkbox', { name: 'Approver 2' })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: 'Treasurer' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Holder A' })).not.toBeChecked();

    await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(api.callsTo('POST /api/org')).toHaveLength(1));
    expect(api.callsTo('POST /api/org')[0]?.body).toEqual({
      name: 'Acme Fund',
      approvers: [APPROVER_1.partyId, APPROVER_2.partyId, APPROVER_3.partyId],
      approvalThreshold: 2,
    });
  });

  it('explains the missing treasury charter instead of showing the form', async () => {
    stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/org': { setupStep: 'charter', organization: null, mandate: null },
    });
    await sessionStore.load();
    render(Page);
    expect(
      await screen.findByText(
        /run scripts\/localnet-up\.sh; it creates the charter through BitSafe governance/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Treasury name')).toBeNull();
  });
});
