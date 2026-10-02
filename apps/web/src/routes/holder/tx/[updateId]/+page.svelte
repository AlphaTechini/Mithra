<script lang="ts">
  /** In-app transaction detail for a holder (LocalNet, P3): only their own payment. */
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import PrivacyNote from '$lib/components/holder/PrivacyNote.svelte';
  import TxDetailView from '$lib/components/holder/TxDetailView.svelte';

  const updateId = $derived(page.params['updateId'] ?? '');
</script>

<svelte:head>
  <title>Transaction · Mithra</title>
</svelte:head>

<p class="back"><a href={resolve('/holder')}>Back to my home</a></p>
{#key updateId}
  <TxDetailView {updateId} viewer="holder" />
{/key}
<PrivacyNote />

<style>
  .back {
    margin-bottom: var(--space-4);
  }
</style>
