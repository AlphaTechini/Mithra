import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { goto } from '$app/navigation';
import {
  configFor,
  holderSession,
  signedOutSession,
  stubApi,
} from '$lib/components/holder/fixtures';
import { sessionStore } from '$lib/stores/session.svelte';
import Page from './+page.svelte';

const current = vi.hoisted(() => ({ url: new URL('http://localhost/launch') }));
vi.mock('$app/state', () => ({
  page: {
    get url() {
      return current.url;
    },
  },
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn(() => Promise.resolve()) }));
vi.mock('@groftylabs/dapp-sdk', () => ({ createGroftyClient: vi.fn(() => Promise.resolve(null)) }));

function launchAt(query: string): void {
  current.url = new URL(`http://localhost/launch${query}`);
}

function signedIn(network: 'localnet' | 'mainnet' = 'localnet'): void {
  stubApi({
    'GET /api/session': holderSession(network),
    'GET /api/config/public': configFor(network),
    'GET /api/session/demo-parties': { parties: [] },
  });
}

beforeEach(() => {
  sessionStore.reset();
  vi.mocked(goto).mockClear();
  launchAt('');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('launch page: ?next=', () => {
  it('continues to the invite after choosing a party when next is a same-site path', async () => {
    launchAt('?next=/invite/ABC');
    signedIn();
    render(Page);
    expect(await screen.findByRole('link', { name: /Continue as Holder A/ })).toHaveAttribute(
      'href',
      '/invite/ABC',
    );
  });

  it('the role switcher sends the chosen party to next, not to its role home', async () => {
    launchAt('?next=/invite/ABC');
    const holderB = { partyId: 'holderB::1220bb', displayName: 'Holder B', roles: ['holder'] };
    stubApi({
      'GET /api/session': holderSession(),
      'GET /api/config/public': configFor(),
      'GET /api/session/demo-parties': { parties: [holderB] },
      'POST /api/session/switch': {
        network: 'localnet',
        testMode: true,
        signedIn: true,
        party: { ...holderB, primaryRole: 'holder' },
      },
    });
    render(Page);
    const select = await screen.findByRole('combobox', { name: 'Acting as' });
    await fireEvent.change(select, { target: { value: holderB.partyId } });
    await vi.waitFor(() => expect(goto).toHaveBeenCalledWith('/invite/ABC', expect.anything()));
    expect(goto).not.toHaveBeenCalledWith('/holder', expect.anything());
  });

  it('goes to the role home when there is no next', async () => {
    signedIn();
    render(Page);
    expect(await screen.findByRole('link', { name: /Continue as Holder A/ })).toHaveAttribute(
      'href',
      '/holder',
    );
  });

  it.each(['//evil.example', 'https://evil.example/invite/ABC', '/\\evil.example', 'invite/ABC'])(
    'ignores the off-site or malformed next %s',
    async (next) => {
      launchAt(`?next=${encodeURIComponent(next)}`);
      signedIn();
      render(Page);
      expect(await screen.findByRole('link', { name: /Continue as Holder A/ })).toHaveAttribute(
        'href',
        '/holder',
      );
    },
  );

  it('on MainNet a signed-in visitor goes straight to next', async () => {
    launchAt('?next=/invite/ABC');
    signedIn('mainnet');
    render(Page);
    await vi.waitFor(() =>
      expect(goto).toHaveBeenCalledWith('/invite/ABC', { replaceState: true }),
    );
  });

  it('on MainNet an off-site next is ignored and the visitor goes home', async () => {
    launchAt('?next=//evil.example');
    signedIn('mainnet');
    render(Page);
    await vi.waitFor(() => expect(goto).toHaveBeenCalledWith('/holder', { replaceState: true }));
    expect(goto).not.toHaveBeenCalledWith('//evil.example', expect.anything());
  });

  it('signed out: shows the sign-in form regardless of next', async () => {
    launchAt('?next=/invite/ABC');
    stubApi({
      'GET /api/session': signedOutSession(),
      'GET /api/config/public': configFor(),
    });
    render(Page);
    expect(await screen.findByRole('heading', { name: 'Sign in to LocalNet' })).toBeInTheDocument();
  });
});
