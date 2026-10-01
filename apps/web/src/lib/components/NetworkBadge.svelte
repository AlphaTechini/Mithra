<script lang="ts">
  /**
   * The persistent network badge: "LocalNet test mode" or "MainNet". Reads the session store, so
   * it is the same on every screen. Renders nothing until the backend has said which network.
   */
  import { sessionStore } from '$lib/stores/session.svelte';
  import Icon from './Icon.svelte';

  let { network }: { network?: 'localnet' | 'mainnet' } = $props();
  const current = $derived(network ?? sessionStore.network);
</script>

{#if current}
  <span class="badge" data-network={current}>
    <Icon name={current === 'localnet' ? 'flask' : 'globe'} size={14} />
    <span>{current === 'localnet' ? 'LocalNet test mode' : 'MainNet'}</span>
  </span>
{/if}

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: 0.125rem var(--space-3);
    border-radius: var(--radius-pill);
    background: var(--color-inverse-bg);
    color: var(--color-inverse-text);
    font-size: var(--text-13);
    font-weight: 500;
    line-height: 1.4;
  }
</style>
