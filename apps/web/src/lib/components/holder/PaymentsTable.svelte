<script lang="ts">
  /**
   * The holder's payment history: cycle, amount, status (icon + word), date and a transaction
   * link. Rows awaiting acceptance carry the "Accept payment" action (P2). Seeded payments carry
   * a "Seeded" tag (U8). Only the holder's own payments are ever passed in.
   */
  import type { HolderPosition } from '@mithra/shared';
  import Amount from '$lib/components/Amount.svelte';
  import Button from '$lib/components/Button.svelte';
  import DataTable from '$lib/components/DataTable.svelte';
  import StatusChip from '$lib/components/StatusChip.svelte';
  import { formatShortDate } from '$lib/format';
  import { sessionStore } from '$lib/stores/session.svelte';
  import type { TableColumn } from '$lib/types/ui';
  import TxLink from './TxLink.svelte';

  type Payment = HolderPosition['payments'][number];

  interface Props {
    payments: readonly Payment[];
    assetSymbol: string;
    /** The payment being accepted right now, if any. */
    acceptingId?: string | null;
    onaccept: (paymentId: string) => void;
  }

  let { payments, assetSymbol, acceptingId = null, onaccept }: Props = $props();

  /** MainNet payouts: an offer is accepted inside Grofty Wallet, not in Mithra. */
  const groftyRail = $derived(sessionStore.config?.payoutRail === 'grofty-mainnet');

  const columns = $derived<TableColumn[]>([
    { key: 'cycle', label: 'Cycle' },
    { key: 'amount', label: `Amount (${assetSymbol})`, numeric: true },
    { key: 'status', label: 'Status' },
    { key: 'date', label: 'Date' },
    { key: 'tx', label: 'Transaction' },
  ]);
</script>

<div class="table-box">
  <DataTable
    caption="Payment history"
    hideCaption
    {columns}
    rows={payments}
    rowKey={(p: Payment) => p.paymentId}
  >
    {#snippet cell(payment: Payment, column: TableColumn)}
      {#if column.key === 'cycle'}
        {payment.cycleLabel}
      {:else if column.key === 'amount'}
        <Amount value={payment.amount} symbol={assetSymbol} hideSymbol />
      {:else if column.key === 'status'}
        <span class="status">
          <StatusChip
            kind={payment.status === 'paid'
              ? 'paid'
              : payment.status === 'pending'
                ? 'pending'
                : 'awaiting-acceptance'}
          />
          {#if payment.seeded}<StatusChip kind="seeded" />{/if}
          {#if payment.status === 'awaiting-acceptance' && groftyRail}
            <span class="hint">Accept it in Grofty Wallet.</span>
          {:else if payment.status === 'awaiting-acceptance'}
            <Button
              small
              busy={acceptingId === payment.paymentId}
              disabled={acceptingId !== null}
              aria-label="Accept payment, {payment.cycleLabel}"
              onclick={() => onaccept(payment.paymentId)}>Accept payment</Button
            >
          {/if}
        </span>
      {:else if column.key === 'date'}
        <span class="date">{formatShortDate(payment.at)}</span>
      {:else if column.key === 'tx'}
        {#if payment.link}
          <TxLink link={payment.link} context={payment.cycleLabel} />
        {:else}
          <span aria-hidden="true">–</span><span class="sr-only">No transaction yet</span>
        {/if}
      {/if}
    {/snippet}
  </DataTable>
</div>

<style>
  .hint {
    color: var(--color-text-muted);
    font-size: var(--text-13);
  }
  .date {
    white-space: nowrap;
  }
  /* Contains DataTable's visually hidden caption and header cells, which are absolutely
     positioned on phones and would otherwise widen the page (see report). */
  .table-box {
    position: relative;
    overflow-x: clip;
  }
  .status {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }
</style>
