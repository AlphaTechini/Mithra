import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionStore } from '$lib/stores/session.svelte';
import RoleSwitcher from './RoleSwitcher.svelte';

const goto = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('$app/navigation', () => ({ goto }));

const PARTIES = [
  { partyId: 'treasurer::1220aa', displayName: 'Treasurer', roles: ['treasurer'] },
  { partyId: 'approver1::1220bb', displayName: 'Approver 1', roles: ['approver'] },
  { partyId: 'holderA::1220cc', displayName: 'Holder A', roles: ['holder'] },
  { partyId: 'auditor::1220dd', displayName: 'Auditor', roles: ['auditor'] },
];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  sessionStore.reset();
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/session/demo-parties') return Promise.resolve(json({ parties: PARTIES }));
      if (url === '/api/session/switch' && init?.method === 'POST') {
        return Promise.resolve(
          json({
            network: 'localnet',
            testMode: true,
            signedIn: true,
            party: { ...PARTIES[2], primaryRole: 'holder' },
          }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  goto.mockClear();
});

describe('RoleSwitcher', () => {
  it('lists demo parties grouped by role', async () => {
    const { container } = render(RoleSwitcher);
    await screen.findByRole('combobox', { name: 'Acting as' });
    const labels = Array.from(container.querySelectorAll('optgroup')).map((g) => g.label);
    expect(labels).toEqual(['Treasurer', 'Approver 1, 2, 3', 'Holders A to D', 'Auditor']);
  });

  it('posts the selected party, then routes by primary role', async () => {
    render(RoleSwitcher);
    const select = await screen.findByRole('combobox', { name: 'Acting as' });
    await fireEvent.change(select, { target: { value: 'holderA::1220cc' } });

    await waitFor(() => expect(goto).toHaveBeenCalledWith('/holder', expect.anything()));
    const calls = vi.mocked(fetch).mock.calls;
    const post = calls.find(([url]) => url === '/api/session/switch');
    expect(post?.[1]?.method).toBe('POST');
    expect(JSON.parse(typeof post?.[1]?.body === 'string' ? post[1].body : '')).toEqual({
      partyId: 'holderA::1220cc',
    });
    expect(sessionStore.party?.displayName).toBe('Holder A');
  });

  it('routes to next instead of the role home when the page gives one', async () => {
    render(RoleSwitcher, { props: { next: '/invite/ABC' } });
    const select = await screen.findByRole('combobox', { name: 'Acting as' });
    await fireEvent.change(select, { target: { value: 'holderA::1220cc' } });

    await waitFor(() => expect(goto).toHaveBeenCalledWith('/invite/ABC', expect.anything()));
    expect(goto).not.toHaveBeenCalledWith('/holder', expect.anything());
    expect(sessionStore.party?.displayName).toBe('Holder A');
  });

  it('LocalNet: the demo party "Auditor" with no role yet goes to /auditor, not /start', async () => {
    const auditorNoRole = { partyId: 'auditor::1220ee', displayName: 'Auditor', roles: [] };
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url === '/api/session/demo-parties') {
          return Promise.resolve(json({ parties: [...PARTIES.slice(0, 3), auditorNoRole] }));
        }
        if (url === '/api/session/switch' && init?.method === 'POST') {
          return Promise.resolve(
            json({
              network: 'localnet',
              testMode: true,
              signedIn: true,
              party: { ...auditorNoRole, primaryRole: null },
            }),
          );
        }
        return Promise.resolve(new Response('{}', { status: 404 }));
      }),
    );
    const { container } = render(RoleSwitcher);
    const select = await screen.findByRole('combobox', { name: 'Acting as' });
    expect(Array.from(container.querySelectorAll('optgroup')).map((g) => g.label)).toContain(
      'No role yet',
    );
    await fireEvent.change(select, { target: { value: 'auditor::1220ee' } });
    await waitFor(() => expect(goto).toHaveBeenCalledWith('/auditor', expect.anything()));
  });

  it('shows what failed when demo parties cannot be loaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    render(RoleSwitcher);
    expect(await screen.findByRole('alert')).toHaveTextContent("Mithra can't reach its server.");
  });
});
