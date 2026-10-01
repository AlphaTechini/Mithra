<script lang="ts">
  /**
   * Approvals inbox (userflow 10 step 1): proposals waiting for the signed-in approver, each
   * opening the shared cycle page where Approve and Reject live. Refreshes every 15 seconds and
   * when the window regains focus, without replacing the list by a skeleton.
   */
  import type { ApprovalsInbox } from '@mithra/shared';
  import { resolve } from '$app/paths';
  import { onMount } from 'svelte';
  import { fetchApprovals } from '$lib/api/approvals';
  import Amount from '$lib/components/Amount.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import ErrorState from '$lib/components/ErrorState.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Seal from '$lib/components/Seal.svelte';
  import Skeleton from '$lib/components/Skeleton.svelte';
  import { describeError } from '$lib/errors';
  import { formatAge } from './age';

  const REFRESH_MS = 15_000;

  let inbox = $state<ApprovalsInbox | null>(null);
  let error = $state<unknown>(null);
  let retrying = $state(false);
  let now = $state(new Date());

  async function load(): Promise<void> {
    try {
      inbox = await fetchApprovals();
      error = null;
    } catch (e) {
      error = e;
    } finally {
      now = new Date();
    }
  }

  async function retry(): Promise<void> {
    retrying = true;
    await load();
    retrying = false;
  }

  onMount(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    const onFocus = (): void => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  });

  const failure = $derived(error ? describeError(error, "Couldn't load your approvals.") : null);
</script>

<svelte:head>
  <title>Approvals · Mithra</title>
</svelte:head>

<PageHeader title="Approvals" description="Proposals waiting for your decision." />

{#if inbox === null && failure}
  <ErrorState title={failure.title} message={failure.message} onretry={retry} {retrying} />
{:else if inbox === null}
  <Skeleton shape="table" rows={3} label="Loading your approvals" />
{:else}
  {#if failure}
    <p class="stale" role="status">
      <Icon name="alert" size={16} />
      <span>{failure.title} {failure.message} Showing the last list.</span>
    </p>
  {/if}

  {#if inbox.pending.length === 0}
    <EmptyState message="Nothing waiting for your approval." />
  {:else}
    <ul class="list" aria-label="Proposals waiting for approval">
      {#each inbox.pending as item (item.proposalId)}
        <li>
          <a class="card" href={resolve('/app/cycles/[cycleId]', { cycleId: item.cycleId })}>
            <span class="seal">
              <Seal
                size="sm"
                required={Math.max(1, item.approvals.need)}
                signed={item.approvals.have}
                label="{item.approvals.have} of {item.approvals.need}"
              />
            </span>
            <span class="main">
              <span class="label">{item.label}</span>
              <span class="meta">
                <span class="total"><Amount value={item.total} /></span>
                <span class="flags" class:none={item.flagCount === 0}>
                  <Icon name={item.flagCount === 0 ? 'shield' : 'flag'} size={14} />
                  {item.flagCount === 0
                    ? 'No flags'
                    : `${item.flagCount} ${item.flagCount === 1 ? 'flag' : 'flags'}`}
                </span>
                <span class="age">{formatAge(item.createdAt, now)}</span>
              </span>
            </span>
            <span class="progress">
              <span class="count">{item.approvals.have} of {item.approvals.need} approved</span>
              {#if item.youApproved}
                <span class="you">
                  <Icon name="check-circle" size={14} /> You approved
                </span>
              {:else}
                <span class="open">Needs your decision</span>
              {/if}
            </span>
          </a>
        </li>
      {/each}
    </ul>
  {/if}
{/if}

<style>
  .list {
    display: grid;
    gap: var(--space-3);
    margin: 0;
    padding: 0;
    max-width: 48rem;
    list-style: none;
  }
  .card {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-4);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    color: var(--color-text);
    text-decoration: none;
  }
  .card:hover {
    border-color: var(--color-border-strong);
  }
  .main {
    display: grid;
    gap: var(--space-1);
    min-width: 0;
  }
  .label {
    font-family: var(--font-serif);
    font-size: var(--text-18);
    font-weight: 500;
    color: var(--color-link);
    text-decoration: underline;
    text-underline-offset: 0.15em;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-4);
    color: var(--color-text-muted);
    font-size: var(--text-13);
  }
  .total {
    color: var(--color-text);
    font-weight: 600;
  }
  .flags {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    color: var(--color-danger-text);
    font-weight: 500;
  }
  .flags.none {
    color: var(--color-success-text);
  }
  .progress {
    display: grid;
    justify-items: end;
    gap: var(--space-1);
    font-size: var(--text-13);
    text-align: right;
  }
  .count {
    color: var(--color-text-muted);
  }
  .you {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    color: var(--color-success-text);
    font-weight: 600;
  }
  .open {
    color: var(--color-info-text);
    font-weight: 600;
  }
  .stale {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--color-neutral-bg);
    color: var(--color-neutral-text);
    border-radius: var(--radius-md);
    font-size: var(--text-13);
  }
  @media (max-width: 600px) {
    .card {
      grid-template-columns: auto minmax(0, 1fr);
    }
    .progress {
      grid-column: 1 / -1;
      justify-items: start;
      text-align: left;
    }
  }
</style>
