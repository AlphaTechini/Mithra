<script lang="ts">
  import EmptyState from '$lib/components/EmptyState.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
</script>

<svelte:head>
  <title>Activity · Mithra</title>
</svelte:head>

<PageHeader title="Activity" description="Every request, approval, payment, grant and expiry." />
<EmptyState
  message="No activity yet. Every action by you, your approvers and the agent is logged here."
  actionLabel="Back to overview"
  actionHref="/app/overview"
/>
