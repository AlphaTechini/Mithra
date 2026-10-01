<script lang="ts">
  import EmptyState from '$lib/components/EmptyState.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { shell } from '$lib/stores/ui.svelte';
</script>

<svelte:head>
  <title>Agent · Mithra</title>
</svelte:head>

<PageHeader
  title="Agent"
  description="Work with the agent: drafts, distributions, explanations and what it has done."
/>
<EmptyState
  message="No conversations yet. Ask the agent to prepare a distribution, explain a flag or find a payment, and its actions are listed here."
  actionLabel="Ask the agent"
  onaction={() => shell.openAgent()}
/>
