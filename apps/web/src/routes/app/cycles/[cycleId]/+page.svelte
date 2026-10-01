<script lang="ts">
  import { page } from '$app/state';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
</script>

<svelte:head>
  <title>Cycle · Mithra</title>
</svelte:head>

<PageHeader title="Cycle" description={`Reference ${page.params['cycleId'] ?? ''}`} />
<EmptyState
  message="This cycle has nothing to show yet. Its timeline, per-holder amounts, checks and the agent's memo appear here once it runs."
  actionLabel="Back to cycles"
  actionHref="/app/cycles"
/>
