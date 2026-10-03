<script lang="ts">
  /**
   * SvelteKit reuses this page when only `cycleId` changes, so the cycle is keyed on the id: a new
   * cycle starts with fresh state (dialogs, note, reason, failures) and loads from scratch, and no
   * action can reach the previous cycle.
   */
  import { page } from '$app/state';
  import CycleDetailView from '$lib/components/treasury/CycleDetailView.svelte';

  const cycleId = $derived(page.params['cycleId'] ?? '');
  const openRecordOnLoad = $derived(page.url.searchParams.get('record') === '1');
</script>

{#key cycleId}
  <CycleDetailView {cycleId} {openRecordOnLoad} />
{/key}
