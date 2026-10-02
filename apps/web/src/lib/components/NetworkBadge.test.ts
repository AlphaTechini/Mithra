import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import NetworkBadge from './NetworkBadge.svelte';

describe('NetworkBadge', () => {
  it('says "LocalNet test mode" on LocalNet', () => {
    render(NetworkBadge, { props: { network: 'localnet' } });
    expect(screen.getByText('LocalNet test mode')).toBeInTheDocument();
  });

  it('says MainNet is for payouts and the records stay on LocalNet', () => {
    render(NetworkBadge, { props: { network: 'mainnet' } });
    expect(screen.getByText('MainNet payouts · records on LocalNet')).toBeInTheDocument();
  });
});
