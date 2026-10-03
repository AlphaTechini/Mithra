<script lang="ts">
  /** Cycles: every distribution cycle with its status, total and approvals progress. */
  import { onMount } from 'svelte';
  import { getCycles, getOverview } from '$lib/api/treasury';
  import Button from '$lib/components/Button.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import ErrorState from '$lib/components/ErrorState.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Skeleton from '$lib/components/Skeleton.svelte';
  import CycleTable from '$lib/components/treasury/CycleTable.svelte';
  import RunCycleDialog from '$lib/components/treasury/RunCycleDialog.svelte';
  import { describeError } from '$lib/errors';
  import { createResource } from '$lib/resource.svelte';
  import { live } from '$lib/stores/live.svelte';
  import { sessionStore } from '$lib/stores/session.svelte';
  import { debounce, poll } from '$lib/timing';

  const cycles = createResource(getCycles);
  // The mandate gives the run dialog its defaults (fixed amount, record date rule).
  const overview = createResource(getOverview);
  let runOpen = $state(false);

  const isTreasurer = $derived(sessionStore.party?.roles.includes('treasurer') ?? false);
  const data = $derived(cycles.data);

  onMount(() => {
    void cycles.load();
    void overview.load();
    const refresh = debounce(() => void cycles.load(), 300);
    const offs = [
      live.subscribe('cycle', refresh),
      live.onReconnect(refresh),
      poll(() => void cycles.load(), 15_000),
    ];
    return () => {
      refresh.cancel();
      for (const off of offs) off();
    };
  });
</script>

<svelte:head>
  <title>Cycles · Mithra</title>
</svelte:head>

<PageHeader
  title="Cycles"
  description="Each distribution period, what the agent prepared and how it ended."
>
  {#snippet actions()}
    {#if isTreasurer}
      <Button onclick={() => (runOpen = true)} aria-haspopup="dialog">Run cycle now</Button>
    {/if}
  {/snippet}
</PageHeader>

{#if cycles.loading}
  <Skeleton shape="table" rows={4} label="Loading cycles" />
{:else if cycles.error && !data}
  {@const copy = describeError(cycles.error, "Couldn't load cycles.")}
  <ErrorState title={copy.title} message={copy.message} onretry={() => void cycles.load()} />
{:else if data && data.cycles.length === 0}
  <EmptyState
    message="No cycles yet. Run your first cycle and the agent prepares a distribution for you to see."
    actionLabel={isTreasurer ? 'Run cycle now' : undefined}
    onaction={isTreasurer ? () => (runOpen = true) : undefined}
  />
{:else if data}
  <CycleTable cycles={data.cycles} caption="Cycles" />
{/if}

{#if runOpen}
  <RunCycleDialog mandate={overview.data?.mandate ?? null} onclose={() => (runOpen = false)} />
{/if}
