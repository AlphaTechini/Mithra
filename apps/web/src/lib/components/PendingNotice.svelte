<script lang="ts">
  /** Shown from the moment an action is submitted until the ledger confirms it. */
  import Icon from './Icon.svelte';

  let { message = 'Waiting for the ledger to confirm…' }: { message?: string } = $props();
</script>

<p class="pending" role="status">
  <Icon name="spinner" spin size={16} />
  <span>{message}</span>
</p>

<style>
  .pending {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    padding: var(--space-2) var(--space-3);
    background: var(--color-neutral-bg);
    color: var(--color-neutral-text);
    border-radius: var(--radius-md);
    font-size: var(--text-13);
  }
</style>
