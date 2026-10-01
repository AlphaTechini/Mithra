import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configFor,
  holderSession,
  json,
  signedOutSession,
  stubApi,
} from '$lib/components/holder/fixtures';
import { sessionStore } from '$lib/stores/session.svelte';
import Page from './+page.svelte';

vi.mock('$app/state', () => ({ page: { params: { code: 'AB12CD' } } }));
vi.mock('$app/navigation', () => ({ goto: vi.fn(() => Promise.resolve()) }));

const holderInvite = {
  code: 'AB12CD',
  kind: 'holder',
  displayName: 'Holder A',
  path: '/invite/AB12CD',
  orgName: 'Northwind Fund',
  used: false,
};

beforeEach(() => {
  sessionStore.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('invite page', () => {
  it('says the link is not valid for an unknown code', async () => {
    stubApi({
      'GET /api/invites/AB12CD': () =>
        json({ error: { code: 'not_found', message: 'Unknown invite' } }, 404),
      'GET /api/session': signedOutSession(),
      'GET /api/config/public': configFor(),
    });
    render(Page);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "This invite link isn't valid. Ask the fund for a new one.",
    );
  });

  it('signed out on LocalNet: names the fund and links to the demo sign-in', async () => {
    stubApi({
      'GET /api/invites/AB12CD': holderInvite,
      'GET /api/session': signedOutSession(),
      'GET /api/config/public': configFor(),
    });
    render(Page);
    expect(
      await screen.findByRole('heading', { name: 'Northwind Fund invited you' }),
    ).toBeVisible();
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === 'P' &&
          /Sign in to the demo, then pick Holder A in the role switcher\./.test(
            el.textContent ?? '',
          ),
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in to the demo' })).toHaveAttribute(
      'href',
      '/launch?next=/invite/AB12CD',
    );
  });

  it('signed out on MainNet: Connect Grofty Wallet is disabled with the M10 message', async () => {
    stubApi({
      'GET /api/invites/AB12CD': holderInvite,
      'GET /api/session': signedOutSession('mainnet'),
      'GET /api/config/public': configFor('mainnet'),
    });
    render(Page);
    const button = await screen.findByRole('button', { name: 'Connect Grofty Wallet' });
    expect(button).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Grofty connection is set up in the MainNet build',
    );
  });

  it('signed in as a holder: continues to the welcome screen', async () => {
    stubApi({
      'GET /api/invites/AB12CD': holderInvite,
      'GET /api/session': holderSession(),
      'GET /api/config/public': configFor(),
    });
    render(Page);
    const link = await screen.findByRole('link', { name: 'Continue' });
    expect(link).toHaveAttribute('href', '/holder/welcome');
  });

  it('auditor invite: invites the person to audit and links to the audit workspace', async () => {
    stubApi({
      'GET /api/invites/AB12CD': { ...holderInvite, kind: 'auditor', displayName: 'Auditor' },
      'GET /api/session': signedOutSession(),
      'GET /api/config/public': configFor(),
    });
    render(Page);
    expect(
      await screen.findByRole('heading', { name: "You're invited to audit Northwind Fund." }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Go to the audit workspace' })).toHaveAttribute(
      'href',
      '/auditor',
    );
  });
});
