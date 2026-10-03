import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { sessionStore } from '$lib/stores/session.svelte';
import Amount from './Amount.svelte';

describe('Amount', () => {
  it('formats a decimal string with separators and the symbol', () => {
    render(Amount, { value: '1200.0000000000', symbol: 'CC' });
    expect(screen.getByText('1,200.00')).toBeInTheDocument();
    expect(screen.getByText('CC')).toBeInTheDocument();
  });

  it('keeps long fractions exact', () => {
    render(Amount, { value: '123456789.1234567891' });
    expect(screen.getByText('123,456,789.1234567891')).toBeInTheDocument();
  });

  it('shows ten decimals when exact', () => {
    render(Amount, { value: '0.1', exact: true });
    expect(screen.getByText('0.1000000000')).toBeInTheDocument();
  });

  it('renders a negative amount', () => {
    render(Amount, { value: '-42.5000000000' });
    expect(screen.getByText('-42.50')).toBeInTheDocument();
  });

  it('can hide the symbol and falls back to CC', async () => {
    sessionStore.reset();
    const { container, rerender } = render(Amount, { value: '1', hideSymbol: true });
    expect(container.textContent).toBe('1.00');
    expect(screen.queryByText('CC')).toBeNull();
    await rerender({ value: '1', hideSymbol: false });
    // No symbol was given and no config is loaded: the symbol is CC.
    expect(screen.getByText('CC')).toBeInTheDocument();
    expect(container.textContent).toBe('1.00\u00a0CC');
  });
});
