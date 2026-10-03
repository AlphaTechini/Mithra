<script lang="ts">
  /**
   * In-app transaction detail (P3 on LocalNet): the update id with a copy button, the record time
   * and the payments in the transaction that the viewer may see. The server already limits the
   * payments to what the viewer may see; as a second guard the holder variant keeps only rows for
   * the session's own party and never prints a name (it says "You").
   */
  import type { TxDetail } from '@mithra/shared';
  import { untrack } from 'svelte';
  import { fetchTx } from '$lib/api/holder';
  import Amount from '$lib/components/Amount.svelte';
  import Button from '$lib/components/Button.svelte';
  import DataTable from '$lib/components/DataTable.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import ErrorState from '$lib/components/ErrorState.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Skeleton from '$lib/components/Skeleton.svelte';
  import StatusChip from '$lib/components/StatusChip.svelte';
  import { describeError } from '$lib/errors';
  import { sessionStore } from '$lib/stores/session.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import type { TableColumn } from '$lib/types/ui';

  type TxPayment = TxDetail['payments'][number];

  interface Props {
    updateId: string;
    /** `holder`: own payments only, no names. `staff`: treasurer and approver, with holder names. */
    viewer: 'holder' | 'staff';
  }

  let { updateId, viewer }: Props = $props();

  let tx = $state<TxDetail | null>(null);
  let error = $state<unknown>(null);
  let loading = $state(true);

  /** Counts fetches, so only the latest one may write: an older response arriving late is dropped. */
  let latest = 0;

  async function load(): Promise<void> {
    const mine = ++latest;
    const id = updateId;
    loading = true;
    tx = null;
    error = null;
    try {
      const result = await fetchTx(id);
      if (mine === latest) tx = result;
    } catch (e) {
      if (mine === latest) error = e;
    } finally {
      if (mine === latest) loading = false;
    }
  }

  // Load on mount and again whenever the update id changes (the route may reuse this component).
  $effect(() => {
    void updateId;
    untrack(() => void load());
    return () => {
      latest++;
    };
  });

  const ownPartyId = $derived(sessionStore.party?.partyId ?? null);
  const payments = $derived.by<TxPayment[]>(() => {
    if (!tx) return [];
    return viewer === 'holder'
      ? tx.payments.filter((p) => p.holder.partyId === ownPartyId)
      : tx.payments;
  });

  const columns = $derived<TableColumn[]>([
    ...(viewer === 'staff' ? [{ key: 'holder', label: 'Holder' }] : []),
    { key: 'cycle', label: 'Cycle' },
    { key: 'amount', label: 'Amount', numeric: true },
    { key: 'status', label: 'Status' },
  ]);

  /** "2026-10-01 09:00:04 UTC" from an ISO time. */
  function formatRecordTime(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return (
      date
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d+Z$/, '')
        .replace(/Z$/, '') + ' UTC'
    );
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(updateId);
      toasts.push('Transaction ID copied', 'info');
    } catch {
      toasts.push('Could not copy the transaction ID. Select it and copy it by hand.', 'error', 0);
    }
  }

  const failure = $derived(error ? describeError(error, "Couldn't load this transaction.") : null);
</script>

<PageHeader
  title="Transaction"
  description={viewer === 'holder'
    ? 'The part of this transaction that is yours.'
    : 'The payments in this ledger transaction.'}
/>

{#if loading}
  <Skeleton shape="block" height="9rem" label="Loading the transaction" />
{:else if failure}
  <ErrorState title={failure.title} message={failure.message} onretry={load} />
{:else if tx}
  <dl class="facts">
    <div>
      <dt>Update ID</dt>
      <dd class="id">
        <code>{tx.updateId}</code>
        <Button variant="quiet" small aria-label="Copy transaction ID" onclick={copy}>
          <Icon name="copy" size={14} /> Copy
        </Button>
      </dd>
    </div>
    <div>
      <dt>Recorded</dt>
      <dd><time datetime={tx.recordTime}>{formatRecordTime(tx.recordTime)}</time></dd>
    </div>
  </dl>

  <h2 class="payments-heading">Payments you can see</h2>
  {#if payments.length === 0}
    <EmptyState message="This transaction has no payments that you can see." />
  {:else}
    <div class="table-box">
      <DataTable
        caption="Payments in this transaction"
        hideCaption
        {columns}
        rows={payments}
        rowKey={(p: TxPayment) => `${p.holder.partyId}:${p.cycleLabel}:${p.amount}`}
      >
        {#snippet cell(payment: TxPayment, column: TableColumn)}
          {#if column.key === 'holder'}
            {payment.holder.displayName}
          {:else if column.key === 'cycle'}
            {payment.cycleLabel}
          {:else if column.key === 'amount'}
            <Amount value={payment.amount} />
          {:else if payment.status === 'paid'}
            <StatusChip kind="paid" />
          {:else if payment.status === 'awaiting-acceptance'}
            <StatusChip kind="awaiting-acceptance" />
          {:else}
            {payment.status}
          {/if}
        {/snippet}
      </DataTable>
    </div>
  {/if}
{/if}

<style>
  .table-box {
    position: relative;
    overflow-x: clip;
  }
  .facts {
    display: grid;
    gap: var(--space-4);
    margin: 0 0 var(--space-6);
    padding: var(--space-4) var(--space-5);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
  }
  dt {
    color: var(--color-text-muted);
    font-size: var(--text-13);
  }
  dd {
    margin: 0;
  }
  .id {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }
  code {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .payments-heading {
    font-size: var(--text-18);
    font-family: var(--font-sans);
    font-weight: 600;
  }
</style>
