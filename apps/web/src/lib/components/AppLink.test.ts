import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import AppLink from './AppLink.svelte';

const children = createRawSnippet(() => ({ render: () => '<span>Open</span>' }));

function link(value: string): HTMLAnchorElement {
  render(AppLink, { props: { link: value, children } });
  return screen.getByRole<HTMLAnchorElement>('link', { name: 'Open' });
}

/** The anchor stays on this origin, whatever the server sent. */
function sameOrigin(anchor: HTMLAnchorElement): boolean {
  return (
    new URL(anchor.getAttribute('href') ?? '', window.location.href).origin ===
    window.location.origin
  );
}

describe('AppLink', () => {
  it('an in-app path keeps its single leading slash', () => {
    expect(link('/app/cycles/2026-09').getAttribute('href')).toBe('/app/cycles/2026-09');
  });

  it('a path without a leading slash gets one', () => {
    expect(link('app/overview').getAttribute('href')).toBe('/app/overview');
  });

  it.each([
    '//evil.example/x',
    '///evil.example/x',
    '/\\evil.example/x',
    '\\\\evil.example/x',
    ' //evil.example/x',
  ])('normalises %j to one leading slash, so it cannot leave this origin', (value) => {
    const anchor = link(value);
    expect(anchor.getAttribute('href')).toBe('/evil.example/x');
    expect(anchor.getAttribute('href')?.startsWith('//')).toBe(false);
    expect(sameOrigin(anchor)).toBe(true);
    expect(anchor).not.toHaveAttribute('target');
  });

  it('an absolute http(s) URL is external and opens in a new tab', () => {
    const anchor = link('https://explorer.example/tx/u1');
    expect(anchor).toHaveAttribute('href', 'https://explorer.example/tx/u1');
    expect(anchor).toHaveAttribute('target', '_blank');
    expect(anchor.getAttribute('rel')).toContain('noopener');
  });

  it('a javascript: value is treated as a path, never as a script URL', () => {
    const anchor = link('javascript:alert(1)');
    expect(anchor.getAttribute('href')?.startsWith('javascript:')).toBe(false);
    expect(sameOrigin(anchor)).toBe(true);
  });
});
