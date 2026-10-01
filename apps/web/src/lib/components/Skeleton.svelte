<script lang="ts">
  /**
   * Loading placeholder shaped like the content it stands in for: `line` (text), `block` (card or
   * figure) or `table` (header plus rows). Announced once as "Loading" to assistive technology.
   */
  interface Props {
    shape?: 'line' | 'block' | 'table';
    /** `line`: number of text lines. */
    lines?: number;
    /** `table`: number of rows. */
    rows?: number;
    /** `block`: CSS height. */
    height?: string;
    label?: string;
  }

  let { shape = 'line', lines = 3, rows = 4, height = '6rem', label = 'Loading' }: Props = $props();
</script>

<div class="skeleton" role="status" aria-live="polite">
  <span class="sr-only">{label}</span>
  <div aria-hidden="true">
    {#if shape === 'line'}
      {#each Array.from({ length: lines }, (_, i) => i) as i (i)}
        <div class="bar line" style:width={i === lines - 1 && lines > 1 ? '60%' : '100%'}></div>
      {/each}
    {:else if shape === 'block'}
      <div class="bar" style:height></div>
    {:else}
      <div class="bar head"></div>
      {#each Array.from({ length: rows }, (_, i) => i) as i (i)}
        <div class="bar row"></div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .skeleton {
    display: block;
  }
  .bar {
    background: var(--color-surface-sunken);
    border-radius: var(--radius-sm);
    animation: pulse 1.6s ease-in-out infinite;
  }
  .line {
    height: 0.875rem;
    margin-bottom: var(--space-2);
  }
  .head {
    height: 2rem;
    margin-bottom: var(--space-2);
  }
  .row {
    height: 2.75rem;
    margin-bottom: var(--space-2);
  }
  @keyframes pulse {
    50% {
      opacity: 0.55;
    }
  }
</style>
