import '@testing-library/jest-dom/vitest';
import type { SessionResponse } from '@mithra/shared';
import { render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configFor, stubApi } from '$lib/components/holder/fixtures';
import { sessionStore } from '$lib/stores/session.svelte';
import Page from './+page.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn(() => Promise.resolve()) }));

const noRole: SessionResponse = {
  network: 'localnet',
  testMode: true,
  signedIn: true,
  party: { partyId: 'auditor::1220aa', displayName: 'Auditor', roles: [], primaryRole: null },
};

beforeEach(() => {
  sessionStore.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('start page', () => {
  it('offers a party with no role three ways in, the third for an auditor (userflow 11.1)', async () => {
    stubApi({ 'GET /api/session': noRole, 'GET /api/config/public': configFor() });
    render(Page);
    expect(await screen.findByRole('heading', { name: 'Set up a treasury' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'I was invited' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: "I'm an auditor" })).toBeInTheDocument();
    expect(screen.getByText('Ask this fund for access to specific records.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the audit workspace' })).toHaveAttribute(
      'href',
      '/auditor',
    );
  });
});
