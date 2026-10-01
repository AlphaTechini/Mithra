<script lang="ts">
  /** The activity log: every request, approval, execution and grant, newest first. */
  import { onMount } from 'svelte';
  import type { ActivityEntry } from '@mithra/shared';
  import { getActivity } from '$lib/api/treasury';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import ErrorState from '$lib/components/ErrorState.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Skeleton from '$lib/components/Skeleton.svelte';
  import ActivityList from '$lib/components/treasury/ActivityList.svelte';
  import { describeError } from '$lib/errors';
  import { createResource } from '$lib/resource.svelte';
  import { live } from '$lib/stores/live.svelte';

  const log = createResource(async () => (await getActivity(100)).entries);
  /** Entries that arrived live and are not in the loaded list yet. */
  let fresh = $state<ActivityEntry[]>([]);

  const entries = $derived.by(() => {
    const loaded = log.data ?? [];
    const known = new Set(loaded.map((e) => e.id));
    return [...fresh.filter((e) => !known.has(e.id)), ...loaded];
  });

  onMount(() => {
    void log.load();
    const offs = [
      live.subscribe('activity', (event) => {
        if (!fresh.some((e) => e.id === event.entry.id)) fresh = [event.entry, ...fresh];
      }),
      live.onReconnect(() => void log.load()),
    ];
    return () => {
      for (const off of offs) off();
    };
  });
</script>

<svelte:head>
  <title>Activity · Mithra</title>
</svelte:head>

<PageHeader
  title="Activity"
  description="Every request, approval, payment and change, in the order it happened."
/>

{#if log.loading}
  <Skeleton shape="table" rows={6} label="Loading activity" />
{:else if log.error && !log.data}
  {@const copy = describeError(log.error, "Couldn't load the activity log.")}
  <ErrorState title={copy.title} message={copy.message} onretry={() => void log.load()} />
{:else if entries.length === 0}
  <EmptyState
    message="No activity yet. Sealing the mandate, running a cycle or issuing units shows up here."
    actionLabel="Go to overview"
    actionHref="/app/overview"
  />
{:else}
  <ActivityList {entries} label="Activity log" />
{/if}
