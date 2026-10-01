<script lang="ts">
  /**
   * Overview (userflow 7): balance, next cycle with a countdown, the active mandate with its seal,
   * pending approvals, recent cycles and activity, "Run cycle now", and the low-balance warning
   * with "Add funds". Every figure comes from the server; live events and a 15 s poll keep it
   * current.
   */
  import { onMount } from 'svelte';
  import { resolve } from '$app/paths';
  import { getOverview } from '$lib/api/treasury';
  import Amount from '$lib/components/Amount.svelte';
  import Button from '$lib/components/Button.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import ErrorState from '$lib/components/ErrorState.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Seal from '$lib/components/Seal.svelte';
  import Skeleton from '$lib/components/Skeleton.svelte';
  import ActivityList from '$lib/components/treasury/ActivityList.svelte';
  import CycleTable from '$lib/components/treasury/CycleTable.svelte';
  import FundsWarning from '$lib/components/treasury/FundsWarning.svelte';
  import RunCycleDialog from '$lib/components/treasury/RunCycleDialog.svelte';
  import { describeError } from '$lib/errors';
  import { formatDateTime, formatDuration } from '$lib/format';
  import { createResource } from '$lib/resource.svelte';
  import { live } from '$lib/stores/live.svelte';
  import { sessionStore } from '$lib/stores/session.svelte';
  import { debounce, poll } from '$lib/timing';

  const overview = createResource(getOverview);
  let runOpen = $state(false);
  let now = $state(Date.now());

  const isTreasurer = $derived(sessionStore.party?.roles.includes('treasurer') ?? false);
  const data = $derived(overview.data);

  onMount(() => {
    void overview.load();
    const refresh = debounce(() => void overview.load(), 300);
    const offs = [
      live.subscribe('cycle', refresh),
      live.subscribe('activity', refresh),
      live.subscribe('seal', refresh),
      live.onReconnect(refresh),
      poll(() => void overview.load(), 15_000),
    ];
    const tick = window.setInterval(() => (now = Date.now()), 30_000);
    return () => {
      refresh.cancel();
      for (const off of offs) off();
      window.clearInterval(tick);
    };
  });

  const nextIn = $derived(data?.nextCycle ? new Date(data.nextCycle.at).getTime() - now : null);
</script>

<svelte:head>
  <title>Overview · Mithra</title>
</svelte:head>

<PageHeader title="Overview" description="Balance, next cycle, active mandate and recent activity.">
  {#snippet actions()}
    {#if isTreasurer && data?.mandate}
      <Button onclick={() => (runOpen = true)} aria-haspopup="dialog">Run cycle now</Button>
    {/if}
  {/snippet}
</PageHeader>

{#if overview.loading}
  <div class="skeletons">
    <Skeleton shape="block" height="7rem" label="Loading the overview" />
    <Skeleton shape="table" rows={3} label="Loading recent cycles" />
  </div>
{:else if overview.error && !data}
  {@const copy = describeError(overview.error, "Couldn't load the overview.")}
  <ErrorState title={copy.title} message={copy.message} onretry={() => void overview.load()} />
{:else if data}
  {#if data.fundsWarning}
    <FundsWarning
      balance={data.fundsWarning.balance}
      required={data.fundsWarning.required}
      onfunded={() => void overview.load()}
    />
  {/if}

  {#if !data.mandate}
    <EmptyState
      message="No mandate is sealed yet. Set up your treasury and seal a mandate, then your balance, next cycle and pending approvals appear here."
      actionLabel="Set up a treasury"
      actionHref="/setup/organization"
    />
  {/if}

  <section class="top" aria-label="Treasury at a glance">
    <div class="tile balance">
      <h2>Treasury balance</h2>
      {#if data.balance !== null}
        <p class="big"><Amount value={data.balance} symbol={data.assetSymbol} size="large" /></p>
      {:else}
        <p class="muted">
          The balance isn't available right now. It shows again once the ledger answers.
        </p>
      {/if}
    </div>

    <div class="tile">
      <h2>Next cycle</h2>
      {#if data.nextCycle}
        <p class="strong">{data.nextCycle.label}</p>
        <p class="muted">
          {formatDateTime(data.nextCycle.at)}{#if nextIn !== null && nextIn > 0}
            , in {formatDuration(nextIn)}{/if}
        </p>
        {#if data.expectedNextTotal}
          <p class="muted">
            Expected total <Amount value={data.expectedNextTotal} symbol={data.assetSymbol} />
          </p>
        {/if}
      {:else}
        <p class="muted">Nothing is scheduled yet.</p>
      {/if}
    </div>

    <div class="tile mandate">
      <h2>Active mandate</h2>
      {#if data.mandate}
        <div class="mandate-row">
          <Seal required={1} signed={1} state="sealed" label="Mandate sealed" size="sm" />
          <div>
            <p class="strong">
              Cap <Amount value={data.mandate.terms.cap} symbol={data.assetSymbol} />
            </p>
            <p class="muted">
              {data.mandate.terms.approvalThreshold} of {data.mandate.terms.approvers.length} approvals
              above the cap
            </p>
          </div>
        </div>
      {:else}
        <p class="muted">No mandate sealed.</p>
      {/if}
    </div>

    <div class="tile">
      <h2>Pending approvals</h2>
      <p class="count">{data.pendingApprovals}</p>
      <p class="muted">
        <a
          href={resolve(
            sessionStore.party?.roles.includes('approver') ? '/app/approvals' : '/app/cycles',
          )}>{data.pendingApprovals === 1 ? 'Open the proposal' : 'See proposals'}</a
        >
      </p>
    </div>
  </section>

  <section aria-labelledby="recent-cycles">
    <div class="section-head">
      <h2 id="recent-cycles">Recent cycles</h2>
      <a href={resolve('/app/cycles')}>All cycles</a>
    </div>
    {#if data.recentCycles.length === 0}
      <EmptyState
        message="No cycles yet. Run your first cycle and the agent prepares a distribution."
        actionLabel={isTreasurer && data.mandate ? 'Run cycle now' : 'View cycles'}
        actionHref={isTreasurer && data.mandate ? undefined : '/app/cycles'}
        onaction={isTreasurer && data.mandate ? () => (runOpen = true) : undefined}
      />
    {:else}
      <CycleTable cycles={data.recentCycles} caption="Recent cycles" compact />
    {/if}
  </section>

  <section aria-labelledby="recent-activity">
    <div class="section-head">
      <h2 id="recent-activity">Recent activity</h2>
      <a href={resolve('/app/activity')}>Full log</a>
    </div>
    {#if data.recentActivity.length === 0}
      <EmptyState
        message="No activity yet. Everything the agent and your team do is logged here."
      />
    {:else}
      <ActivityList entries={data.recentActivity.slice(0, 10)} label="Recent activity" />
    {/if}
  </section>
{/if}

{#if runOpen}
  <RunCycleDialog mandate={data?.mandate ?? null} onclose={() => (runOpen = false)} />
{/if}

<style>
  .skeletons {
    display: grid;
    gap: var(--space-4);
  }
  .top {
    display: grid;
    grid-template-columns: 2fr 1.3fr 1.4fr 1fr;
    gap: var(--space-4);
    margin-bottom: var(--space-6);
  }
  .tile {
    padding: var(--space-4);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    min-width: 0;
  }
  .tile h2 {
    margin: 0 0 var(--space-2);
    font-family: var(--font-sans);
    font-size: var(--text-15);
    font-weight: 600;
    color: var(--color-text-muted);
  }
  .tile p {
    margin: 0 0 var(--space-1);
  }
  .big {
    font-size: var(--text-44);
  }
  .count {
    font-family: var(--font-serif);
    font-size: var(--text-32);
    font-variant-numeric: tabular-nums lining-nums;
  }
  .strong {
    font-weight: 600;
  }
  .muted {
    color: var(--color-text-muted);
  }
  .mandate-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  section {
    margin-bottom: var(--space-6);
  }
  .section-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .section-head h2 {
    font-size: var(--text-24);
  }
  @media (max-width: 900px) {
    .top {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .balance {
      grid-column: span 2;
    }
  }
  @media (max-width: 600px) {
    .top {
      grid-template-columns: minmax(0, 1fr);
    }
    .balance {
      grid-column: auto;
    }
    .big {
      font-size: var(--text-32);
    }
  }
</style>
