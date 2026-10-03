<script lang="ts">
  /**
   * Error state: what failed and what to do next, with an optional Retry. Never a raw code alone.
   * Rendered as an alert so assistive technology announces it.
   */
  import Button from './Button.svelte';
  import Icon from './Icon.svelte';

  interface Props {
    /** What failed, e.g. "Mithra can't reach its server." */
    title: string;
    /** What to do next. */
    message: string;
    onretry?: () => void;
    retryLabel?: string;
    retrying?: boolean;
  }

  let { title, message, onretry, retryLabel = 'Retry', retrying = false }: Props = $props();
</script>

<div class="error" role="alert">
  <Icon name="alert" size={20} />
  <div class="body">
    <p class="text"><strong>{title}</strong> {message}</p>
    {#if onretry}
      <Button variant="secondary" small busy={retrying} onclick={onretry}>{retryLabel}</Button>
    {/if}
  </div>
</div>

<style>
  .error {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    padding: var(--space-4);
    background: var(--color-danger-bg);
    color: var(--color-danger-text);
    border: 1px solid var(--color-danger);
    border-radius: var(--radius-md);
  }
  .body {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-3);
  }
  .text {
    margin: 0;
  }
</style>
