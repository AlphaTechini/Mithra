import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionStore } from '$lib/stores/session.svelte';
import { HOLDER_A, holderRow, sessionRoutes } from '../../../test/treasury/fixtures';
import { stubApi } from '../../../test/treasury/stub';
import IssueUnitsDialog from './IssueUnitsDialog.svelte';

const DEMO = [
  { partyId: 'treasurer::1220aa', displayName: 'Treasurer', roles: ['treasurer'] },
  { partyId: 'approver1::1220b1', displayName: 'Approver 1', roles: ['approver'] },
  { partyId: 'holderA::1220c1', displayName: 'Holder A', roles: [] },
  { partyId: 'holderB::1220c2', displayName: 'Holder B', roles: [] },
  { partyId: 'holderC::1220c3', displayName: 'Holder C', roles: [] },
  { partyId: 'auditor::1220dd', displayName: 'Auditor', roles: [] },
];

function groups(container: HTMLElement): { label: string; options: string[] }[] {
  return Array.from(container.querySelectorAll('optgroup')).map((g) => ({
    label: g.label,
    options: Array.from(g.querySelectorAll('option')).map((o) => o.textContent ?? ''),
  }));
}

beforeEach(() => {
  sessionStore.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('IssueUnitsDialog holder choices', () => {
  it('LocalNet: lists the demo parties that are not treasurer or approvers, existing holders first', async () => {
    stubApi({ ...sessionRoutes('treasurer'), 'GET /api/session/demo-parties': { parties: DEMO } });
    await sessionStore.load();
    const { container } = render(IssueUnitsDialog, {
      props: {
        holders: [holderRow({ holder: HOLDER_A })],
        onclose: () => {},
        ondone: () => {},
        oninvite: () => {},
      },
    });
    await screen.findByRole('option', { name: 'Holder B' });
    expect(groups(container)).toEqual([
      { label: 'Current holders', options: ['Holder A'] },
      { label: 'Demo parties', options: ['Holder B', 'Holder C', 'Auditor'] },
    ]);
    expect(screen.getByRole('option', { name: 'Another party id…' })).toBeInTheDocument();
  });

  it('LocalNet, fresh setup: no holders yet, so every demo party but the team is offered', async () => {
    stubApi({ ...sessionRoutes('treasurer'), 'GET /api/session/demo-parties': { parties: DEMO } });
    await sessionStore.load();
    const { container } = render(IssueUnitsDialog, {
      props: { holders: [], onclose: () => {}, ondone: () => {}, oninvite: () => {} },
    });
    await screen.findByRole('option', { name: 'Holder A' });
    expect(groups(container)).toEqual([
      { label: 'Demo parties', options: ['Holder A', 'Holder B', 'Holder C', 'Auditor'] },
    ]);
  });

  it('MainNet: only the existing holders and another party id, and no demo lookup', async () => {
    const stub = stubApi({ ...sessionRoutes('treasurer', 'mainnet') });
    await sessionStore.load();
    const { container } = render(IssueUnitsDialog, {
      props: {
        holders: [holderRow({ holder: HOLDER_A })],
        onclose: () => {},
        ondone: () => {},
        oninvite: () => {},
      },
    });
    await screen.findByRole('option', { name: 'Holder A' });
    expect(groups(container)).toEqual([{ label: 'Current holders', options: ['Holder A'] }]);
    expect(stub.callsTo('GET /api/session/demo-parties')).toHaveLength(0);
  });
});
