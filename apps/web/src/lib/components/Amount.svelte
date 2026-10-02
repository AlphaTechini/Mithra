<script lang="ts">
  /**
   * A decimal string with thousands separators and the asset symbol. Formatting is done on the
   * string (see formatAmount), so a value is never converted to a JS number. `size="large"` uses
   * Newsreader. `exact` shows all ten decimals.
   */
  import { formatAmount } from '$lib/format';
  import { sessionStore } from '$lib/stores/session.svelte';

  interface Props {
    value: string;
    symbol?: string;
    exact?: boolean;
    size?: 'normal' | 'large';
    /** Omit the symbol, for columns whose header already names it. */
    hideSymbol?: boolean;
  }

  let { value, symbol, exact = false, size = 'normal', hideSymbol = false }: Props = $props();

  const formatted = $derived(formatAmount(value, { exact }));
  const unit = $derived(symbol ?? sessionStore.config?.assetSymbol ?? 'CC');
</script>

<span class="amount" class:large={size === 'large'}
  ><span class="figure">{formatted}</span>{#if !hideSymbol}&nbsp;<span class="symbol">{unit}</span
    >{/if}</span
>

<style>
  .amount {
    font-variant-numeric: tabular-nums lining-nums;
    white-space: nowrap;
  }
  .large {
    font-family: var(--font-serif);
    font-size: var(--text-32);
    font-weight: 500;
    line-height: var(--leading-tight);
  }
  .symbol {
    color: var(--color-text-muted);
    font-size: 0.7em;
  }
  .large .symbol {
    font-size: var(--text-18);
  }
</style>
