<script lang="ts">
  import EmptyState from '$lib/components/EmptyState.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
</script>

<svelte:head>
  <title>Cycles · Mithra</title>
</svelte:head>

<PageHeader
  title="Cycles"
  description="Each distribution period, from the agent's timeline to the payments."
/>
<EmptyState
  message="No cycles yet. Seal a mandate, then run your first cycle or let the schedule start it."
  actionLabel="Set up a treasury"
  actionHref="/setup/organization"
/>
