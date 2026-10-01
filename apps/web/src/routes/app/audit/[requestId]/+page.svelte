<script lang="ts">
  import { page } from '$app/state';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
</script>

<svelte:head>
  <title>Audit request · Mithra</title>
</svelte:head>

<PageHeader title="Audit request" description={`Reference ${page.params['requestId'] ?? ''}`} />
<EmptyState
  message="This request has nothing to show yet. The auditor's question and the exact records that would be shared appear here, side by side, for you to grant or deny."
  actionLabel="Back to audit"
  actionHref="/app/audit"
/>
