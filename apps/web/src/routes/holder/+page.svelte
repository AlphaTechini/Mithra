<script lang="ts">
  import EmptyState from '$lib/components/EmptyState.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
</script>

<svelte:head>
  <title>Your position · Mithra</title>
</svelte:head>

<PageHeader title="Your position" description="Your fund units and the yield paid to you." />

<section id="units" aria-labelledby="units-heading">
  <h2 id="units-heading">Units</h2>
  <EmptyState
    message="You don't hold any units yet. Open the invite link from the fund to accept units."
  />
</section>

<section id="payments" aria-labelledby="payments-heading">
  <h2 id="payments-heading">Payments</h2>
  <EmptyState
    message="No payments yet. Yield paid to you appears here with a link to the explorer for each transfer."
  />
</section>

<style>
  section {
    margin-bottom: var(--space-6);
    scroll-margin-top: var(--space-6);
  }
</style>
