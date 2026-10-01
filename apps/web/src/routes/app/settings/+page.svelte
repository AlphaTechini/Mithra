<script lang="ts">
  import EmptyState from '$lib/components/EmptyState.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
</script>

<svelte:head>
  <title>Settings · Mithra</title>
</svelte:head>

<PageHeader title="Settings" description="Organization, mandate, network and infrastructure." />
<EmptyState
  message="Nothing to change yet. Your organization, approvers, mandate and network details appear here once your treasury is set up."
  actionLabel="Set up a treasury"
  actionHref="/setup/organization"
/>
