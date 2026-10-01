<script lang="ts">
  /** Audit workspace: requests on the left, the evidence room on the right; stacked on phones. */
  import EmptyState from '$lib/components/EmptyState.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
</script>

<svelte:head>
  <title>Audit workspace · Mithra</title>
</svelte:head>

<PageHeader
  title="Audit workspace"
  description="Ask for records, then review them while access lasts."
/>
<div class="panes">
  <section aria-labelledby="requests-heading">
    <h2 id="requests-heading">Requests</h2>
    <EmptyState
      message="No requests yet. Describe the records you need and the agent proposes the smallest scope that answers it."
    />
  </section>
  <section aria-labelledby="evidence-heading">
    <h2 id="evidence-heading">Evidence room</h2>
    <EmptyState
      message="No access granted yet. Records appear here, read-only, once the treasurer grants a request, and disappear when access ends."
    />
  </section>
</div>

<style>
  .panes {
    display: grid;
    grid-template-columns: minmax(16rem, 22rem) minmax(0, 1fr);
    gap: var(--space-5);
    align-items: start;
  }
  @media (max-width: 800px) {
    .panes {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
