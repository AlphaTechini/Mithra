<script lang="ts">
  import EmptyState from '$lib/components/EmptyState.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
</script>

<svelte:head>
  <title>Approvals · Mithra</title>
</svelte:head>

<PageHeader title="Approvals" description="Proposals waiting for your decision." />
<EmptyState
  message="No proposals are waiting for you. Flagged cycles that need your approval appear here, with the reasons at the top."
  actionLabel="View cycles"
  actionHref="/app/cycles"
/>
