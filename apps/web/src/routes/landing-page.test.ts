import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configFor, json, signedOutSession, stubApi } from '$lib/components/holder/fixtures';
import { sessionStore } from '$lib/stores/session.svelte';
import Page from './+page.svelte';

const SHOWCASE = {
  cycleLabel: 'September 2026',
  total: '1200.0000000000',
  assetSymbol: 'CC',
  payees: 4,
  approvals: { have: 2, need: 2, approvers: 3 },
};

function routes(showcase: unknown, demoVideoUrl: string | null = null) {
  return {
    'GET /api/session': signedOutSession(),
    'GET /api/config/public': { ...configFor(), demoVideoUrl },
    'GET /api/public/showcase': showcase,
  };
}

function reducedMotion(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
}

/** A `matchMedia` whose answer can change after mount, like the operating system setting. */
function controllableMotion(initial: boolean) {
  let matches = initial;
  const handlers = new Set<(event: { matches: boolean }) => void>();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      get matches() {
        return matches;
      },
      addEventListener: (_: string, handler: (event: { matches: boolean }) => void) =>
        handlers.add(handler),
      removeEventListener: (_: string, handler: (event: { matches: boolean }) => void) =>
        handlers.delete(handler),
    })),
  );
  return {
    set(value: boolean): void {
      matches = value;
      for (const handler of [...handlers]) handler({ matches: value });
    },
    listeners: () => handlers.size,
  };
}

beforeEach(() => {
  sessionStore.reset();
  reducedMotion(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('landing page: the pitch', () => {
  it('has the headline, the sub-line and Launch app', () => {
    stubApi(routes(null));
    render(Page);
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: "Your fund's payouts, run by an agent you can audit.",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Mithra prepares every distribution, pays inside limits your team sets/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Launch app' })).toHaveAttribute('href', '/launch');
  });

  it('hides the demo button until DEMO_VIDEO_URL is set', async () => {
    stubApi(routes(null));
    render(Page);
    await screen.findByText(/Example/);
    expect(screen.queryByRole('link', { name: 'Watch the 3-minute demo' })).toBeNull();
  });

  it('links the demo video in a new tab when the deployment has one', async () => {
    stubApi(routes(null, 'https://video.example/mithra'));
    render(Page);
    const link = await screen.findByRole('link', { name: 'Watch the 3-minute demo' });
    expect(link).toHaveAttribute('href', 'https://video.example/mithra');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('has the three sections, and no more: the problem, how it works, why Canton', () => {
    stubApi(routes(null));
    render(Page);
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual([
      'A distribution being sealed',
      'Payments go wrong even when people check them',
      'How it works',
      'Why Canton',
    ]);
  });

  it('gives the problem as three numbers with their sources', () => {
    stubApi(routes(null));
    render(Page);
    const problem = screen
      .getByRole('heading', { name: /Payments go wrong/ })
      .closest('section') as HTMLElement;
    const items = within(problem).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('88%');
    expect(items[0]).toHaveTextContent('Source: Modern Treasury, 2025');
    expect(items[1]).toHaveTextContent('$894M');
    expect(items[1]).toHaveTextContent('Revlon');
    expect(items[1]).toHaveTextContent('three people');
    expect(items[2]).toHaveTextContent('10 to 25 business days');
    expect(items[2]).toHaveTextContent('Source: Chase and NatWest');
  });

  it('shows how it works as an ordered sequence of four steps', () => {
    stubApi(routes(null));
    render(Page);
    const how = screen.getByRole('heading', { name: 'How it works' }).closest('section');
    const steps = within(how as HTMLElement).getAllByRole('listitem');
    expect(steps.map((s) => within(s).getByRole('heading').textContent)).toEqual([
      'Set the rules',
      'The agent runs the cycle',
      'Your team approves what is flagged',
      'Auditors see only what you grant',
    ]);
    expect(how?.querySelector('ol')).not.toBeNull();
  });

  it('says why Canton in two points', () => {
    stubApi(routes(null));
    render(Page);
    expect(
      screen.getByRole('heading', { name: 'Each holder sees only their own payment' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: "The agent's limits are enforced by the ledger" }),
    ).toBeInTheDocument();
  });

  it('ends with the network badge and the GitHub link', async () => {
    stubApi(routes(null));
    render(Page);
    const footer = screen.getByRole('contentinfo');
    expect(await within(footer).findByText('LocalNet test mode')).toBeInTheDocument();
    const link = within(footer).getByRole('link', { name: /Mithra on GitHub/ });
    expect(link).toHaveAttribute('href', 'https://github.com/AlphaTechini/Mithra');
  });
});

describe('landing page: the live seal', () => {
  it('describes the latest approved distribution of this ledger', async () => {
    stubApi(routes(SHOWCASE));
    render(Page);
    expect(
      await screen.findByText('September 2026, 1,200 CC to 4 holders, approved 2 of 3'),
    ).toBeInTheDocument();
    expect(screen.getByText('Latest approved distribution on this ledger')).toBeInTheDocument();
    expect(screen.queryByText(/Example/)).toBeNull();
    // Reduced motion: the seal is closed at once and there is nothing to replay.
    expect(screen.getByRole('img', { name: /2 of 2 signatures, sealed/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Replay the seal' })).toBeNull();
  });

  it('shows a clearly labelled example when no distribution has been approved yet', async () => {
    stubApi(routes(null));
    render(Page);
    expect(
      await screen.findByText('September 2026, 1,200 CC to 4 holders, approved 2 of 3'),
    ).toBeInTheDocument();
    expect(screen.getByText('Example.')).toBeInTheDocument();
    expect(screen.getByText(/nothing has been approved on this ledger yet/)).toBeInTheDocument();
  });

  it('falls back to the labelled example when the showcase cannot be read', async () => {
    stubApi({
      ...routes(null),
      'GET /api/public/showcase': () => json({ error: { code: 'x', message: 'down' } }, 503),
    });
    render(Page);
    expect(await screen.findByText('Example.')).toBeInTheDocument();
    // A failed request is not "nothing approved yet": the copy says the answer could not be read.
    expect(screen.getByText(/could not load the latest distribution/)).toBeInTheDocument();
    expect(screen.queryByText(/nothing has been approved on this ledger yet/)).toBeNull();
  });

  it('keeps the "nothing has been approved" sentence for a successful empty answer only', async () => {
    stubApi(routes(null));
    render(Page);
    expect(await screen.findByText(/nothing has been approved on this ledger yet/)).toBeVisible();
    expect(screen.queryByText(/could not load the latest distribution/)).toBeNull();
  });

  it('stops the animation and shows the final state when reduced motion is switched on later', async () => {
    const media = controllableMotion(false);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubApi(routes(SHOWCASE));
    const view = render(Page);
    expect(await screen.findByRole('img', { name: /0 of 2 signatures/ })).toBeInTheDocument();
    expect(media.listeners()).toBe(1);
    media.set(true);
    expect(
      await screen.findByRole('img', { name: /2 of 2 signatures, sealed/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Replay the seal' })).toBeNull();
    // No timer from the stopped animation moves it afterwards.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(screen.getByRole('img', { name: /2 of 2 signatures, sealed/ })).toBeInTheDocument();
    view.unmount();
    expect(media.listeners()).toBe(0);
  });

  it('closes the seal step by step, and can replay it', async () => {
    reducedMotion(false);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubApi(routes(SHOWCASE));
    render(Page);
    expect(await screen.findByRole('img', { name: /0 of 2 signatures/ })).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(1_300);
    expect(screen.getByRole('img', { name: /1 of 2 signatures/ })).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(800);
    expect(screen.getByRole('img', { name: /2 of 2 signatures, sealed/ })).toBeInTheDocument();

    screen.getByRole('button', { name: 'Replay the seal' }).click();
    expect(await screen.findByRole('img', { name: /0 of 2 signatures/ })).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(screen.getByRole('img', { name: /2 of 2 signatures, sealed/ })).toBeInTheDocument();
  });
});
