<script lang="ts">
  /**
   * Empty state: one sentence that says what will appear here, and one action. The action is a
   * link when `actionHref` is set, otherwise a button calling `onaction`.
   */
  import type { Pathname } from '$app/types';
  import Button from './Button.svelte';

  interface Props {
    message: string;
    actionLabel?: string;
    actionHref?: Pathname;
    onaction?: () => void;
  }

  let { message, actionLabel, actionHref, onaction }: Props = $props();
</script>

<div class="empty">
  <p>{message}</p>
  {#if actionLabel}
    <Button variant="secondary" href={actionHref} onclick={onaction}>{actionLabel}</Button>
  {/if}
</div>

<style>
  .empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-5);
    background: var(--color-surface);
    border: 1px dashed var(--color-border-strong);
    border-radius: var(--radius-md);
  }
  p {
    margin: 0;
  }
</style>
