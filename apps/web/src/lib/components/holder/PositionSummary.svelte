<script lang="ts">
  /**
   * The holder's own numbers (userflow 6 step 5): units held, share of the fund, total yield
   * received and the next expected payment. Every value is rendered from the HolderPosition the
   * server returned for the signed-in holder; nothing is computed here.
   */
  import type { HolderPosition } from '@mithra/shared';
  import Amount from '$lib/components/Amount.svelte';
  import { formatAmount, formatShortDate } from '$lib/format';

  let { position }: { position: HolderPosition } = $props();

  // Whole numbers of units, grouped for reading. Not a computation on money.
  const units = $derived(position.units.toLocaleString('en-US'));
</script>

<section class="summary" aria-label="Your position">
  <div class="hero">
    <p class="label" id="total-received-label">Total yield received</p>
    <p class="figure" aria-labelledby="total-received-label">
      <Amount value={position.totalReceived} symbol={position.assetSymbol} size="large" />
    </p>
  </div>
  <dl>
    <div>
      <dt>Units held</dt>
      <dd>{units}</dd>
    </div>
    <div>
      <dt>Share of fund</dt>
      <dd>{formatAmount(position.sharePct)}%</dd>
    </div>
    <div>
      <dt>Next expected payment</dt>
      <dd>
        {#if position.nextPaymentDate}
          {formatShortDate(position.nextPaymentDate)}
        {:else}
          Not scheduled yet
        {/if}
      </dd>
    </div>
  </dl>
</section>

<style>
  .summary {
    display: grid;
    gap: var(--space-4);
    margin-bottom: var(--space-6);
    padding: var(--space-5);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
  }
  .label {
    margin: 0 0 var(--space-1);
    color: var(--color-text-muted);
    font-size: var(--text-13);
  }
  .figure {
    margin: 0;
  }
  dl {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    gap: var(--space-4);
    margin: 0;
  }
  dt {
    color: var(--color-text-muted);
    font-size: var(--text-13);
  }
  dd {
    margin: 0;
    font-size: var(--text-18);
    font-weight: 600;
    font-variant-numeric: tabular-nums lining-nums;
  }
</style>
