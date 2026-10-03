import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import TxLink from './TxLink.svelte';

describe('TxLink', () => {
  it('an https explorer link opens in a new tab', () => {
    render(TxLink, {
      props: {
        link: { updateId: 'u1', href: 'https://explorer.example/tx/u1', external: true },
        context: 'September 2026',
      },
    });
    const anchor = screen.getByRole('link', { name: 'View on explorer, September 2026' });
    expect(anchor).toHaveAttribute('href', 'https://explorer.example/tx/u1');
    expect(anchor).toHaveAttribute('target', '_blank');
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it.each([
    'javascript:alert(document.cookie)',
    'JaVaScRiPt:alert(1)',
    '  javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'ftp://explorer.example/tx/u1',
    '//evil.example/x',
    'not a url',
  ])('never renders %j as an anchor', (href) => {
    const { container } = render(TxLink, {
      props: { link: { updateId: 'u1', href, external: true }, context: 'September 2026' },
    });
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('[href]')).toBeNull();
    expect(screen.getByText('Explorer link unavailable')).toBeInTheDocument();
  });

  it('an in-app link stays an in-app link', () => {
    render(TxLink, {
      props: {
        link: { updateId: 'u1', href: '/holder/tx/u1', external: false },
        context: 'September 2026',
      },
    });
    const anchor = screen.getByRole('link', { name: 'View transaction, September 2026' });
    expect(anchor.getAttribute('href')).toBe('/holder/tx/u1');
    expect(anchor).not.toHaveAttribute('target');
  });
});
