<script lang="ts">
  import EmptyState from '$lib/components/EmptyState.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
</script>

<svelte:head>
  <title>Overview · Mithra</title>
</svelte:head>

<PageHeader
  title="Overview"
  description="Balance, next cycle, active mandate and recent activity."
/>
<EmptyState
  message="Nothing to show yet. Once you set up your treasury and seal a mandate, your balance, next cycle and pending approvals appear here."
  actionLabel="Set up a treasury"
  actionHref="/setup/organization"
/>
