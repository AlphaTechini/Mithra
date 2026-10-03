<script lang="ts">
  /**
   * SvelteKit reuses this page when only `requestId` changes (back and forward between two
   * requests), so the review is keyed on the id: a new request starts with fresh state and loads
   * from scratch, and nothing from the previous one can reach Grant or Deny.
   */
  import { page } from '$app/state';
  import AuditRequestView from '$lib/components/audit/AuditRequestView.svelte';

  const requestId = $derived(page.params['requestId'] ?? '');
</script>

{#key requestId}
  <AuditRequestView {requestId} />
{/key}
