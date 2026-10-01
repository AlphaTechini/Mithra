<script lang="ts">
  import EmptyState from '$lib/components/EmptyState.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
</script>

<svelte:head>
  <title>Audit · Mithra</title>
</svelte:head>

<PageHeader title="Audit" description="Requests from auditors and the access you have granted." />
<EmptyState
  message="No audit requests yet. When an auditor asks for records, the request and the exact records it would share appear here for you to grant or deny."
  actionLabel="Back to overview"
  actionHref="/app/overview"
/>
