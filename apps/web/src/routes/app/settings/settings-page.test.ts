import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { live } from '$lib/stores/live.svelte';
import { sessionStore } from '$lib/stores/session.svelte';
import {
  TREASURER,
  APPROVER_1,
  APPROVER_2,
  APPROVER_3,
  draft,
  mandate,
  sessionRoutes,
} from '../../../test/treasury/fixtures';
import { stubApi } from '../../../test/treasury/stub';
import Page from './+page.svelte';

const goto = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('$app/navigation', () => ({ goto }));

const ORG = {
  setupStep: 'done',
  organization: {
    name: 'Acme Fund',
    treasury: { partyId: 'treasury::1220ff', displayName: 'Treasury' },
    treasurer: TREASURER,
    approvers: [APPROVER_1, APPROVER_2, APPROVER_3],
    approvalThreshold: 2,
    assetSymbol: 'CC',
  },
  mandate: mandate(),
};

const infra = (overrides: Record<string, unknown> = {}) => ({
  treasuryParty: 'treasury::1220ff',
  hostingThreshold: 2,
  nodes: [
    { id: 'n1', name: 'Node 1', operator: 'Operator A', online: true, hostsTreasury: true },
    { id: 'n2', name: 'Node 2', operator: 'Operator B', online: false, hostsTreasury: true },
    { id: 'n3', name: 'Node 3', operator: 'Operator C', online: true, hostsTreasury: true },
  ],
  summary: 'Still running on 2 of 3 nodes',
  ...overrides,
});

beforeEach(() => {
  sessionStore.reset();
  live.reset();
  goto.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('settings page', () => {
  it('shows the organization, the mandate terms and the infrastructure with icon plus word status', async () => {
    stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/org': ORG,
      'GET /api/infrastructure': infra(),
    });
    await sessionStore.load();
    render(Page);

    expect(await screen.findByText('Acme Fund')).toBeInTheDocument();
    expect(
      screen.getByText('Changes to the organization require re-sealing the mandate.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Monthly on the 1st at 09:00 UTC')).toBeInTheDocument();
    expect(screen.getByText(/LocalNet test mode/)).toBeInTheDocument();

    expect(await screen.findByText('Still running on 2 of 3 nodes')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Hosting nodes' });
    expect(within(table).getAllByText('Online')).toHaveLength(2);
    expect(within(table).getAllByText('Offline')).toHaveLength(1);
    const section = screen.getByRole('heading', { name: 'Infrastructure' }).closest('section')!;
    expect(within(section).getByText('2 of 3', { selector: 'dd' })).toBeInTheDocument();
  });

  it('starts "Edit and re-seal" from the current mandate and goes to the policy step', async () => {
    const api = stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/org': ORG,
      'GET /api/infrastructure': infra(),
      'PUT /api/policy/draft': draft({ source: 'current-mandate' }),
    });
    await sessionStore.load();
    render(Page);
    await fireEvent.click(await screen.findByRole('button', { name: 'Edit and re-seal' }));
    await waitFor(() => expect(goto).toHaveBeenCalledWith('/setup/policy', expect.anything()));
    const sent = api.callsTo('PUT /api/policy/draft')[0]?.body as {
      fields: { cap: string; approvers: string[] };
    };
    expect(sent.fields.cap).toBe('5000');
    expect(sent.fields.approvers).toEqual([
      APPROVER_1.partyId,
      APPROVER_2.partyId,
      APPROVER_3.partyId,
    ]);
  });

  it('hides the infrastructure panel on MainNet', async () => {
    stubApi({
      ...sessionRoutes('treasurer', 'mainnet'),
      'GET /api/org': ORG,
      'GET /api/infrastructure': infra({ nodes: [] }),
    });
    await sessionStore.load();
    render(Page);
    await screen.findByText('Acme Fund');
    expect(screen.queryByRole('heading', { name: 'Infrastructure' })).toBeNull();
    expect(screen.getByText(/MainNet\. Payments move real CC/)).toBeInTheDocument();
  });
});
