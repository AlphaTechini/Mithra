import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Seal from './Seal.svelte';

const segments = (container: HTMLElement) => container.querySelectorAll('[data-segment]');
const filled = (container: HTMLElement) =>
  container.querySelectorAll('[data-segment][data-filled="true"]');

describe('Seal', () => {
  it('renders one segment per required signer and fills exactly the signed ones', () => {
    const { container } = render(Seal, { required: 3, signed: 2, label: 'Approved 2 of 3' });
    expect(segments(container)).toHaveLength(3);
    expect(filled(container)).toHaveLength(2);
  });

  it('announces the count in words', () => {
    render(Seal, { required: 3, signed: 2, label: 'Approved 2 of 3' });
    expect(screen.getByRole('img', { name: /2 of 3 signatures/ })).toBeInTheDocument();
  });

  it('follows the signed prop when the ledger count changes', async () => {
    const { container, rerender } = render(Seal, {
      required: 3,
      signed: 1,
      label: 'Approved 1 of 3',
    });
    expect(filled(container)).toHaveLength(1);
    await rerender({ required: 3, signed: 2, label: 'Approved 2 of 3' });
    expect(filled(container)).toHaveLength(2);
    // A lower count from the ledger is shown as is.
    await rerender({ required: 3, signed: 0, label: 'Approved 0 of 3' });
    expect(filled(container)).toHaveLength(0);
  });

  it('becomes a solid seal stamped with the label when signed reaches required', () => {
    const { container } = render(Seal, { required: 2, signed: 2, label: 'Mandate sealed' });
    expect(segments(container)).toHaveLength(0);
    expect(container.querySelector('[data-state="sealed"]')).not.toBeNull();
    const stamp = Array.from(container.querySelectorAll('.stamp-text tspan'), (t) => t.textContent);
    expect(stamp.join(' ')).toBe('Mandate sealed');
    expect(screen.getByRole('img', { name: /2 of 2 signatures, sealed/ })).toBeInTheDocument();
  });

  it('is sealed when state is sealed even with a lower count', () => {
    const { container } = render(Seal, {
      required: 3,
      signed: 3,
      label: 'Access granted until Oct 14',
      state: 'sealed',
    });
    expect(container.querySelector('[data-state="sealed"]')).not.toBeNull();
  });

  it('empties the expiring ring in proportion to the time left', () => {
    const start = Date.now() - 60 * 60 * 1000;
    const end = Date.now() + 60 * 60 * 1000;
    const { container } = render(Seal, {
      required: 1,
      signed: 1,
      label: 'Access granted until Oct 14',
      state: 'expiring',
      grantedAt: start,
      expiresAt: end,
    });
    const ring = container.querySelector('circle.remaining');
    const [length] = (ring?.getAttribute('stroke-dasharray') ?? '').split(' ').map(Number);
    const circumference = 2 * Math.PI * 42;
    expect(length).toBeGreaterThan(circumference * 0.45);
    expect(length).toBeLessThan(circumference * 0.55);
  });

  it('has no way to increment signed by itself', async () => {
    const { container, component } = render(Seal, {
      required: 3,
      signed: 1,
      label: 'Approved 1 of 3',
    });
    // No exported members, no interactive elements, no event handlers on the ring.
    expect(Object.keys(component as object).filter((key) => !key.startsWith('$'))).toEqual([]);
    expect(container.querySelectorAll('button, a, input, [tabindex], [onclick]')).toHaveLength(0);
    container.querySelector('svg')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    container
      .querySelector('svg')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
    expect(filled(container)).toHaveLength(1);
  });

  it('never assigns or binds its signed prop in source', () => {
    const source = readFileSync(resolve(import.meta.dirname, 'Seal.svelte'), 'utf8');
    expect(source).not.toMatch(/\$bindable/);
    expect(source).not.toMatch(/\bsigned\s*(\+\+|--|[-+*]?=(?!=))/);
  });
});
