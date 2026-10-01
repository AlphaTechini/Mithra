<script lang="ts">
  import EmptyState from '$lib/components/EmptyState.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
</script>

<svelte:head>
  <title>Holders · Mithra</title>
</svelte:head>

<PageHeader title="Holders" description="Who holds fund units and how they receive yield." />
<EmptyState
  message="No holders yet. Issue units to your first holder to start paying yield."
  actionLabel="Set up a treasury"
  actionHref="/setup/organization"
/>
