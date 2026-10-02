<script lang="ts">
  /**
   * Holders (userflow 5): who holds how many units, their share, whether payments arrive by
   * themselves (auto-receive), and the last payment. Treasurers can issue units and create invite
   * links. Shares and statuses come from the server.
   */
  import { onMount } from 'svelte';
  import type { HolderRow } from '@mithra/shared';
  import { getHolders } from '$lib/api/treasury';
  import Amount from '$lib/components/Amount.svelte';
  import Button from '$lib/components/Button.svelte';
  import DataTable from '$lib/components/DataTable.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import ErrorState from '$lib/components/ErrorState.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import PartyId from '$lib/components/PartyId.svelte';
  import Skeleton from '$lib/components/Skeleton.svelte';
  import StatusChip from '$lib/components/StatusChip.svelte';
  import InviteDialog from '$lib/components/treasury/InviteDialog.svelte';
  import IssueUnitsDialog from '$lib/components/treasury/IssueUnitsDialog.svelte';
  import { describeError } from '$lib/errors';
  import { formatDateTime } from '$lib/format';
  import { createResource } from '$lib/resource.svelte';
  import { live } from '$lib/stores/live.svelte';
  import { sessionStore } from '$lib/stores/session.svelte';
  import { debounce } from '$lib/timing';
  import type { TableColumn } from '$lib/types/ui';

  const holders = createResource(getHolders);
  let dialog = $state<'issue' | 'invite' | null>(null);

  const isTreasurer = $derived(sessionStore.party?.roles.includes('treasurer') ?? false);
  const data = $derived(holders.data);

  /** MainNet payouts: each holder also connects Grofty Wallet to say where their payment goes. */
  const groftyRail = $derived(sessionStore.config?.payoutRail === 'grofty-mainnet');
  const columns = $derived<TableColumn[]>([
    { key: 'holder', label: 'Holder' },
    { key: 'partyId', label: 'Party ID' },
    { key: 'units', label: 'Units', numeric: true },
    { key: 'share', label: 'Share', numeric: true },
    ...(groftyRail ? [{ key: 'wallet', label: 'MainNet wallet' }] : []),
    { key: 'autoReceive', label: 'Auto-receive' },
    { key: 'lastPayment', label: 'Last payment' },
  ]);

  onMount(() => {
    void holders.load();
    const refresh = debounce(() => void holders.load(), 300);
    const offs = [live.subscribe('holder', refresh), live.subscribe('cycle', refresh)];
    return () => {
      refresh.cancel();
      for (const off of offs) off();
    };
  });
</script>

<svelte:head>
  <title>Holders · Mithra</title>
</svelte:head>

<PageHeader title="Holders" description="Who holds fund units, and how their yield reaches them.">
  {#snippet actions()}
    {#if isTreasurer}
      <Button variant="secondary" onclick={() => (dialog = 'invite')} aria-haspopup="dialog"
        >Invite link</Button
      >
      <Button onclick={() => (dialog = 'issue')} aria-haspopup="dialog">Issue units</Button>
    {/if}
  {/snippet}
</PageHeader>

{#if holders.loading}
  <Skeleton shape="table" rows={4} label="Loading holders" />
{:else if holders.error && !data}
  {@const copy = describeError(holders.error, "Couldn't load holders.")}
  <ErrorState title={copy.title} message={copy.message} onretry={() => void holders.load()} />
{:else if data && data.holders.length === 0}
  <EmptyState
    message="No holders yet. Issue units to your first holder to start paying yield."
    actionLabel={isTreasurer ? 'Issue units' : undefined}
    onaction={isTreasurer ? () => (dialog = 'issue') : undefined}
  />
{:else if data}
  <DataTable
    caption={`Holders, ${data.totalUnits.toLocaleString('en-US')} units in total`}
    {columns}
    rows={data.holders}
    rowKey={(r: HolderRow) => r.holder.partyId}
  >
    {#snippet cell(row: HolderRow, column: TableColumn)}
      {#if column.key === 'holder'}
        <span class="name">{row.holder.displayName}</span>
        {#if row.seeded}<StatusChip kind="seeded" />{/if}
      {:else if column.key === 'partyId'}
        <PartyId partyId={row.holder.partyId} />
      {:else if column.key === 'units'}
        {row.units.toLocaleString('en-US')}
        {#if !row.unitsAccepted}<span class="note">Waiting to accept</span>{/if}
      {:else if column.key === 'share'}
        {row.sharePct}%
      {:else if column.key === 'wallet'}
        {#if row.mainnetWallet}
          <StatusChip kind="confirmed" />
          <PartyId partyId={row.mainnetWallet.partyId} />
        {:else}
          <StatusChip kind="waiting" />
          <span class="note">Not connected to Grofty yet</span>
        {/if}
      {:else if column.key === 'autoReceive'}
        {#if row.autoReceive === true}
          <StatusChip kind="auto-on" />
        {:else if row.autoReceive === false}
          <StatusChip kind="auto-off" />
          <p class="warn">Payments to this holder will wait for them to accept.</p>
        {:else}
          <span class="note">Not known right now</span>
        {/if}
      {:else if column.key === 'lastPayment'}
        {#if row.lastPayment}
          <Amount value={row.lastPayment.amount} />
          <span class="note"
            >{row.lastPayment.cycleLabel}, {formatDateTime(row.lastPayment.at)}</span
          >
        {:else}
          <span class="note">No payments yet</span>
        {/if}
      {/if}
    {/snippet}
  </DataTable>
{/if}

{#if dialog === 'issue'}
  <IssueUnitsDialog
    holders={data?.holders ?? []}
    onclose={() => (dialog = null)}
    ondone={() => void holders.load()}
    oninvite={() => (dialog = 'invite')}
  />
{:else if dialog === 'invite'}
  <InviteDialog onclose={() => (dialog = null)} />
{/if}

<style>
  .name {
    margin-right: var(--space-2);
    font-weight: 500;
  }
  .note {
    display: block;
    color: var(--color-text-muted);
    font-size: var(--text-13);
  }
  .warn {
    margin: var(--space-1) 0 0;
    color: var(--color-danger-text);
    font-size: var(--text-13);
    max-width: 22ch;
  }
</style>
