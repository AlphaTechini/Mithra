<script lang="ts">
  /**
   * Audit (userflow 11 step 5): every request from an auditor, pending first, each opening the
   * review page where the treasurer grants or denies. Refreshes on live `audit` events and every
   * 30 s so an ended grant shows "Access ended" without a reload.
   */
  import type { AuditRequestView } from '@mithra/shared';
  import { onMount } from 'svelte';
  import { resolve } from '$app/paths';
  import { listAuditRequests } from '$lib/api/audit';
  import AuditStatus from '$lib/components/audit/AuditStatus.svelte';
  import DataTable from '$lib/components/DataTable.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import ErrorState from '$lib/components/ErrorState.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Skeleton from '$lib/components/Skeleton.svelte';
  import { describeError } from '$lib/errors';
  import { formatShortDate } from '$lib/format';
  import { createResource } from '$lib/resource.svelte';
  import { live } from '$lib/stores/live.svelte';
  import { debounce, poll } from '$lib/timing';
  import type { TableColumn } from '$lib/types/ui';

  const requests = createResource(listAuditRequests);

  const COLUMNS: TableColumn[] = [
    { key: 'question', label: 'Question' },
    { key: 'auditor', label: 'Auditor' },
    { key: 'status', label: 'Status' },
    { key: 'requestedAt', label: 'Requested' },
  ];

  // Ordering only: requests waiting for a decision first, then the newest.
  const rows = $derived(
    [...(requests.data?.requests ?? [])].sort((a, b) => {
      const pending = Number(b.status === 'pending') - Number(a.status === 'pending');
      return pending !== 0 ? pending : b.requestedAt.localeCompare(a.requestedAt);
    }),
  );

  onMount(() => {
    void requests.load();
    const refresh = debounce(() => void requests.load(), 300);
    const offs = [
      live.subscribe('audit', refresh),
      live.onReconnect(refresh),
      poll(() => void requests.load(), 30_000),
    ];
    return () => {
      refresh.cancel();
      for (const off of offs) off();
    };
  });
</script>

<svelte:head>
  <title>Audit · Mithra</title>
</svelte:head>

<PageHeader title="Audit" description="Requests from auditors and the access you have granted." />

{#if requests.loading}
  <Skeleton shape="table" rows={3} label="Loading audit requests" />
{:else if requests.error && !requests.data}
  {@const copy = describeError(requests.error, "Couldn't load the audit requests.")}
  <ErrorState title={copy.title} message={copy.message} onretry={() => void requests.load()} />
{:else if rows.length === 0}
  <EmptyState
    message="No audit requests yet. When an auditor asks for records, the request and the exact records it would share appear here for you to grant or deny."
    actionLabel="Back to overview"
    actionHref="/app/overview"
  />
{:else}
  <DataTable
    caption="Audit requests"
    hideCaption
    columns={COLUMNS}
    {rows}
    rowKey={(row: AuditRequestView) => row.requestId}
  >
    {#snippet cell(row: AuditRequestView, column: TableColumn)}
      {#if column.key === 'question'}
        <a href={resolve('/app/audit/[requestId]', { requestId: row.requestId })}>{row.question}</a>
      {:else if column.key === 'auditor'}
        {row.auditor.displayName}
      {:else if column.key === 'status'}
        <AuditStatus request={row} />
      {:else}
        {formatShortDate(row.requestedAt)}
      {/if}
    {/snippet}
  </DataTable>
{/if}
