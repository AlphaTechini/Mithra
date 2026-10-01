import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SealStatus } from '@mithra/shared';
import { live } from '$lib/stores/live.svelte';
import { sessionStore } from '$lib/stores/session.svelte';
import { toasts } from '$lib/stores/toasts.svelte';
import { draft, sessionRoutes } from '../../../test/treasury/fixtures';
import { FakeEventSource, installFakeEventSource, stubApi } from '../../../test/treasury/stub';
import Page from './+page.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn(() => Promise.resolve()) }));

const NODES = [
  { id: 'n1', name: 'Node 1', operator: 'Operator A', confirmed: true },
  { id: 'n2', name: 'Node 2', operator: 'Operator B', confirmed: false },
  { id: 'n3', name: 'Node 3', operator: 'Operator C', confirmed: false },
];

function seal(overrides: Partial<SealStatus>): SealStatus {
  return {
    sealId: 's1',
    state: 'awaiting-nodes',
    treasurerSigned: false,
    nodeConfirmations: {
      required: 2,
      confirmed: 0,
      nodes: NODES.map((n) => ({ ...n, confirmed: false })),
    },
    mandateVersion: null,
    error: null,
    ...overrides,
  };
}

beforeEach(() => {
  sessionStore.reset();
  live.reset();
  toasts.clear();
  installFakeEventSource();
});

afterEach(() => {
  live.reset();
  vi.unstubAllGlobals();
});

describe('setup mandate page', () => {
  it('states what the agent can and cannot do, from the draft', async () => {
    stubApi({ ...sessionRoutes('treasurer'), 'GET /api/policy/draft': draft() });
    await sessionStore.load();
    render(Page);
    expect(await screen.findByRole('heading', { name: 'The agent can' })).toBeInTheDocument();
    expect(screen.getByText('Pay holders pro rata on the 1st')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'The agent cannot' })).toBeInTheDocument();
    expect(screen.getByText('Pay more than 5,000 CC without 2 of 3 approvals')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /^0 of 1 signature/ })).toBeInTheDocument();
  });

  it('fills the ring only when the server says the treasurer signed, and closes it when sealed (U3)', async () => {
    const api = stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/policy/draft': draft(),
      'POST /api/mandate/seal': seal({}),
    });
    await sessionStore.load();
    render(Page);

    await fireEvent.click(await screen.findByRole('button', { name: 'Seal mandate' }));
    await waitFor(() =>
      expect(api.callsTo('POST /api/mandate/seal')[0]?.body).toEqual({ draftId: 'draft-1' }),
    );
    expect(
      await screen.findByText('Waiting for treasury nodes: 0 of 2 confirmations'),
    ).toBeInTheDocument();
    // Clicking did not fill the ring; the server has not said the treasurer signed.
    expect(screen.getByRole('img', { name: /^0 of 1 signature/ })).toBeInTheDocument();

    FakeEventSource.latest.emit({
      type: 'seal',
      seal: seal({
        treasurerSigned: true,
        nodeConfirmations: {
          required: 2,
          confirmed: 1,
          nodes: [
            NODES[0]!,
            { ...NODES[1]!, confirmed: false },
            { ...NODES[2]!, confirmed: false },
          ],
        },
      }),
    });
    expect(
      await screen.findByText('Waiting for treasury nodes: 1 of 2 confirmations'),
    ).toBeInTheDocument();
    const filled = screen.getByRole('img', { name: /^1 of 1 signature/ });
    // Signed, but not sealed until the nodes confirm: no "sealed" stamp yet.
    expect(filled.getAttribute('aria-label')).not.toMatch(/sealed/);
    expect(screen.getByText('Node 1')).toBeInTheDocument();
    expect(screen.getByText('Operator B')).toBeInTheDocument();
    expect(screen.getAllByText('Confirmed')).toHaveLength(1);
    expect(screen.getAllByText('Waiting')).toHaveLength(2);

    FakeEventSource.latest.emit({
      type: 'seal',
      seal: seal({
        state: 'sealed',
        treasurerSigned: true,
        mandateVersion: 1,
        nodeConfirmations: null,
      }),
    });
    expect(await screen.findByRole('img', { name: /sealed. Mandate sealed/ })).toBeInTheDocument();
    expect(toasts.items.map((t) => t.message)).toContain('Mandate sealed');
    expect(screen.getByRole('link', { name: 'Go to overview' })).toHaveAttribute(
      'href',
      '/app/overview',
    );
  });

  it('follows the seal by polling when no live event arrives', async () => {
    const api = stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/policy/draft': draft(),
      'POST /api/mandate/seal': seal({}),
      'GET /api/mandate/seal/s1': seal({
        state: 'sealed',
        treasurerSigned: true,
        mandateVersion: 1,
        nodeConfirmations: null,
      }),
    });
    await sessionStore.load();
    render(Page);
    await fireEvent.click(await screen.findByRole('button', { name: 'Seal mandate' }));
    await screen.findByText(/Waiting for treasury nodes/);
    expect(
      await screen.findByText('Mandate sealed', { selector: 'strong' }, { timeout: 4500 }),
    ).toBeInTheDocument();
    expect(api.callsTo('GET /api/mandate/seal/s1').length).toBeGreaterThan(0);
  }, 10_000);

  it('shows the failure and a retry that starts a new attempt', async () => {
    let attempts = 0;
    const api = stubApi({
      ...sessionRoutes('treasurer'),
      'GET /api/policy/draft': draft(),
      'POST /api/mandate/seal': () => {
        attempts++;
        return attempts === 1
          ? seal({
              state: 'failed',
              error: 'The treasury nodes did not confirm in time. Try again.',
              nodeConfirmations: null,
            })
          : seal({ sealId: 's2' });
      },
    });
    await sessionStore.load();
    render(Page);
    await fireEvent.click(await screen.findByRole('button', { name: 'Seal mandate' }));
    expect(await screen.findByText(/did not confirm in time/)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/Waiting for treasury nodes/)).toBeInTheDocument();
    expect(api.callsTo('POST /api/mandate/seal')).toHaveLength(2);
  });

  it('shows the wallet message in place when MainNet needs the wallet', async () => {
    stubApi({
      ...sessionRoutes('treasurer', 'mainnet'),
      'GET /api/policy/draft': draft(),
      'POST /api/mandate/seal': () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'sign_in_wallet',
              message:
                'On MainNet this is signed in Grofty Wallet. Open the wallet and sign there.',
            },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
    });
    await sessionStore.load();
    render(Page);
    await fireEvent.click(await screen.findByRole('button', { name: 'Seal mandate' }));
    expect(await screen.findByText(/signed in Grofty Wallet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Seal mandate' })).toBeEnabled();
  });
});
