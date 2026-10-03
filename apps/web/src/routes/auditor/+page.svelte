<script lang="ts">
  /**
   * Audit workspace (userflow 11): the auditor's requests on the left, the selected request, the
   * evidence room or a new request on the right. On phones the panes stack: the list first, then
   * the detail with a back control. The list refreshes on live `audit` events and every 30 s.
   */
  import type { AuditRequestDetail } from '@mithra/shared';
  import { onMount } from 'svelte';
  import { listAuditRequests } from '$lib/api/audit';
  import AuditStatus from '$lib/components/audit/AuditStatus.svelte';
  import AuditorRequestPanel from '$lib/components/audit/AuditorRequestPanel.svelte';
  import NewRequest from '$lib/components/audit/NewRequest.svelte';
  import Button from '$lib/components/Button.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import ErrorState from '$lib/components/ErrorState.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Skeleton from '$lib/components/Skeleton.svelte';
  import { describeError } from '$lib/errors';
  import { formatShortDate } from '$lib/format';
  import { createResource } from '$lib/resource.svelte';
  import { live } from '$lib/stores/live.svelte';
  import { debounce, poll } from '$lib/timing';

  const requests = createResource(listAuditRequests);

  /** 'none': nothing open; 'new': the new request form; otherwise the open request's id. */
  let view = $state<string>('none');

  const list = $derived(requests.data?.requests ?? []);
  const selected = $derived(list.find((r) => r.requestId === view) ?? null);

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

  function created(requestId: string): void {
    view = requestId;
    void requests.load();
  }
</script>

<svelte:head>
  <title>Audit workspace · Mithra</title>
</svelte:head>

<PageHeader
  title="Audit workspace"
  description="Ask for records, then review them while access lasts."
/>

<div class="panes" data-open={view === 'none' ? 'list' : 'detail'}>
  <section class="list-pane" aria-labelledby="requests-heading">
    <div class="list-head">
      <h2 id="requests-heading">Requests</h2>
      <Button small variant="secondary" onclick={() => (view = 'new')}>New request</Button>
    </div>

    {#if requests.loading}
      <Skeleton shape="table" rows={3} label="Loading your requests" />
    {:else if requests.error && !requests.data}
      {@const copy = describeError(requests.error, "Couldn't load your requests.")}
      <ErrorState title={copy.title} message={copy.message} onretry={() => void requests.load()} />
    {:else if list.length === 0}
      <EmptyState
        message="No requests yet. Choose New request, describe the records you need, and the agent proposes the smallest scope that answers it."
      />
    {:else}
      <ul class="requests" aria-label="Your requests">
        {#each list as request (request.requestId)}
          <li>
            <button
              type="button"
              class="request"
              aria-current={view === request.requestId ? 'true' : undefined}
              onclick={() => (view = request.requestId)}
            >
              <span class="q">{request.question}</span>
              <span class="row">
                <AuditStatus {request} />
                <span class="date">{formatShortDate(request.requestedAt)}</span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <div class="detail-pane">
    {#if view !== 'none'}
      <div class="back">
        <Button variant="quiet" small onclick={() => (view = 'none')}>
          <Icon name="chevron-down" size={16} /> Back to requests
        </Button>
      </div>
    {/if}

    {#if view === 'new'}
      <NewRequest oncreated={(detail: AuditRequestDetail) => created(detail.request.requestId)} />
    {:else if selected}
      {#key selected.requestId}
        <AuditorRequestPanel request={selected} onchanged={() => void requests.load()} />
      {/key}
    {:else if view !== 'none' && requests.loading}
      <Skeleton shape="block" height="12rem" label="Loading the request" />
    {:else if view !== 'none'}
      <EmptyState message="That request is no longer in your list." />
    {:else}
      <EmptyState
        message="Choose a request to see its status and, once the treasurer grants access, its records. Records appear here read-only and disappear when access ends."
      />
    {/if}
  </div>
</div>

<style>
  .panes {
    display: grid;
    grid-template-columns: minmax(16rem, 22rem) minmax(0, 1fr);
    gap: var(--space-5);
    align-items: start;
  }
  .list-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
  }
  .list-head h2 {
    margin: 0;
  }
  .requests {
    display: grid;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .request {
    display: grid;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-3);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    text-align: left;
  }
  .request:hover {
    border-color: var(--color-border-strong);
  }
  .request[aria-current='true'] {
    background: var(--color-selected-bg);
    border-color: var(--color-primary);
  }
  .q {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1) var(--space-3);
  }
  .date {
    color: var(--color-text-muted);
    font-size: var(--text-13);
  }
  .detail-pane {
    display: grid;
    gap: var(--space-4);
    min-width: 0;
  }
  .back {
    display: none;
  }
  .back :global(svg) {
    transform: rotate(90deg);
  }
  @media (max-width: 800px) {
    .panes {
      grid-template-columns: minmax(0, 1fr);
    }
    .panes[data-open='detail'] .list-pane,
    .panes[data-open='list'] .detail-pane {
      display: none;
    }
    .back {
      display: block;
    }
  }
</style>
