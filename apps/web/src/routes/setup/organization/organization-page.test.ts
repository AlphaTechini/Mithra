import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
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

beforeEach(() => {
  sessionStore.reset();
  live.reset();
  goto.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('setup organization page', () => {
  it('lets approvers be picked from the demo parties: nothing preselected, approvers first, the rest under "Other demo parties"', async () => {
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
          { partyId: 'auditor::1220dd', displayName: 'Auditor', roles: [] },
        ],
      },
      'POST /api/org': {},
    });
    await sessionStore.load();
    render(Page);

    await fireEvent.input(await screen.findByLabelText('Treasury name'), {
      target: { value: 'Acme Fund' },
    });
    await screen.findByRole('checkbox', { name: 'Approver 2' });
    // Nothing is preselected, not even the parties that already are approvers.
    for (const box of screen.getAllByRole('checkbox')) expect(box).not.toBeChecked();
    expect(screen.queryByRole('checkbox', { name: 'Treasurer' })).toBeNull();
    // The approvers come first; holders and the auditor sit under their own sub-heading.
    const order = screen
      .getAllByRole('checkbox')
      .map((b) => b.closest('label')?.textContent?.trim());
    expect(order).toEqual(['Approver 1', 'Approver 2', 'Approver 3', 'Holder A', 'Auditor']);
    const heading = screen.getByRole('heading', { name: 'Other demo parties' });
    const others = within(heading.nextElementSibling as HTMLElement).getAllByRole('checkbox');
    expect(others.map((b) => b.closest('label')?.textContent?.trim())).toEqual([
      'Holder A',
      'Auditor',
    ]);
    expect(
      within(screen.getByRole('list', { name: 'Approver demo parties' })).getAllByRole('checkbox'),
    ).toHaveLength(3);

    await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Choose at least one approver.')).toBeInTheDocument();
    expect(api.callsTo('POST /api/org')).toHaveLength(0);

    for (const name of ['Approver 1', 'Approver 2', 'Approver 3']) {
      await fireEvent.click(screen.getByRole('checkbox', { name }));
    }

    await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(api.callsTo('POST /api/org')).toHaveLength(1));
    expect(api.callsTo('POST /api/org')[0]?.body).toEqual({
      name: 'Acme Fund',
      approvers: [APPROVER_1.partyId, APPROVER_2.partyId, APPROVER_3.partyId],
      approvalThreshold: 2,
    });
  });

  it('reads the session again once the organization exists, so the treasurer screens accept the party', async () => {
    // The party had no role when the page loaded; after POST /api/org it is the treasurer.
    let created = false;
    const roleless = {
      network: 'localnet',
      testMode: true,
      signedIn: true,
      party: { ...TREASURER, roles: [], primaryRole: null },
    };
    const api = stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/session': () =>
        created ? sessionRoutes('treasurer')['GET /api/session'] : roleless,
      'GET /api/org': FRESH,
      'GET /api/session/demo-parties': {
        parties: [{ ...APPROVER_1, roles: ['approver'] }],
      },
      'POST /api/org': () => {
        created = true;
        return {};
      },
    });
    await sessionStore.load();
    expect(sessionStore.party?.primaryRole).toBeNull();
    render(Page);
    await fireEvent.input(await screen.findByLabelText('Treasury name'), {
      target: { value: 'Acme Fund' },
    });
    await fireEvent.click(await screen.findByRole('checkbox', { name: 'Approver 1' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(goto).toHaveBeenCalled());
    expect(String((goto.mock.calls as unknown[][])[0]?.[0])).toContain('/setup/policy');
    // Read again after the organization was created, before moving on.
    expect(api.callsTo('GET /api/session').length).toBeGreaterThanOrEqual(2);
    expect(sessionStore.party?.primaryRole).toBe('treasurer');
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
        /Run scripts\/localnet-up\.sh; it creates the charter through BitSafe governance/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Treasury name')).toBeNull();
  });

  it('offers the same demo party picker when payouts run on MainNet (the records are on LocalNet)', async () => {
    stubApi({
      ...sessionRoutes('treasurer', 'mainnet'),
      'GET /api/org': FRESH,
      'GET /api/session/demo-parties': {
        parties: [
          { ...TREASURER, roles: ['treasurer'] },
          { ...APPROVER_1, roles: ['approver'] },
        ],
      },
    });
    await sessionStore.load();
    render(Page);
    expect(await screen.findByRole('checkbox', { name: 'Approver 1' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/party id/)).toBeNull();
  });
});
