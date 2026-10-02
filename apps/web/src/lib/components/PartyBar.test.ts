import '@testing-library/jest-dom/vitest';
import { createRawSnippet } from 'svelte';
import { render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configFor, holderSession, stubApi } from '$lib/components/holder/fixtures';
import { sessionStore } from '$lib/stores/session.svelte';
import HolderLayout from '../../routes/holder/+layout.svelte';
import PartyBar from './PartyBar.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn(() => Promise.resolve()) }));

const DEMO_PARTIES = [
  { partyId: 'treasurer::1220aa', displayName: 'Treasurer', roles: ['treasurer'] },
  { partyId: 'holderA::1220cc', displayName: 'Holder A', roles: ['holder'] },
  { partyId: 'holderB::1220dd', displayName: 'Holder B', roles: ['holder'] },
];

beforeEach(async () => {
  sessionStore.reset();
  stubApi({
    'GET /api/session': holderSession('localnet'),
    'GET /api/config/public': configFor('localnet'),
    'GET /api/session/demo-parties': { parties: DEMO_PARTIES },
  });
  await sessionStore.load();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PartyBar', () => {
  it('shows the inline role switcher by default in LocalNet test mode', async () => {
    render(PartyBar);
    expect(await screen.findByRole('combobox', { name: 'Acting as' })).toBeInTheDocument();
  });

  it('link mode links to /launch and never lists other demo parties (U7)', async () => {
    render(PartyBar, { props: { switcher: 'link' } });
    expect(screen.getByRole('link', { name: 'Switch demo party' })).toHaveAttribute(
      'href',
      '/launch',
    );
    expect(screen.queryByRole('combobox', { name: 'Acting as' })).toBeNull();
    await Promise.resolve();
    expect(screen.queryByText('Holder B')).toBeNull();
    const calls = vi.mocked(fetch).mock.calls.map(([url]) => url);
    expect(calls).not.toContain('/api/session/demo-parties');
  });

  it('the holder layout uses link mode', async () => {
    const children = createRawSnippet(() => ({ render: () => '<p>Holder page</p>' }));
    render(HolderLayout, { props: { children } });
    expect(await screen.findByText('Holder page')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Switch demo party' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Acting as' })).toBeNull();
    expect(screen.queryByText('Holder B')).toBeNull();
  });
});
