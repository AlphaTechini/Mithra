<script lang="ts">
  /**
   * A shortened party id ("hint::1220ab…cd") with a copy button. The full id is in the tooltip
   * and available to screen readers. Keyboard: the copy button is a normal button.
   */
  import { shortenPartyId as shorten } from '$lib/format';
  import { toasts } from '$lib/stores/toasts.svelte';
  import Icon from './Icon.svelte';

  let { partyId }: { partyId: string } = $props();

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(partyId);
      toasts.push('Party ID copied', 'info');
    } catch {
      toasts.push('Could not copy the party ID. Select it and copy it by hand.', 'error', 0);
    }
  }
</script>

<span class="party" title={partyId}>
  <code aria-hidden="true">{shorten(partyId)}</code>
  <span class="sr-only">{partyId}</span>
  <button type="button" class="copy" aria-label="Copy party ID" onclick={copy}>
    <Icon name="copy" size={14} />
  </button>
</span>

<style>
  .party {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
  }
  code {
    color: var(--color-text-muted);
  }
  .copy {
    display: inline-grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--color-text-muted);
  }
  .copy:hover {
    background: var(--color-surface-sunken);
    color: var(--color-text);
  }
</style>
