<script lang="ts">
  /** In-app transaction detail for the treasurer and approvers (LocalNet, P3). */
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import TxDetailView from '$lib/components/holder/TxDetailView.svelte';

  const updateId = $derived(page.params['updateId'] ?? '');
</script>

<svelte:head>
  <title>Transaction · Mithra</title>
</svelte:head>

<p class="back"><a href={resolve('/app/cycles')}>Back to cycles</a></p>
{#key updateId}
  <TxDetailView {updateId} viewer="staff" />
{/key}

<style>
  .back {
    margin-bottom: var(--space-4);
  }
</style>
