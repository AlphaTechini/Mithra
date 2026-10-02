<script lang="ts">
  /**
   * The status of an audit request as icon + word. Granted, ended and denied reuse StatusChip
   * ("Active until Oct 14", "Access ended Oct 14", "Request denied"), and so do a request still
   * waiting for the treasurer and one the auditor withdrew.
   */
  import type { AuditRequestView } from '@mithra/shared';
  import StatusChip from '../StatusChip.svelte';
  import { endedAt } from './status';

  let { request }: { request: AuditRequestView } = $props();
</script>

{#if request.status === 'granted' && request.grant}
  <StatusChip kind="active" date={request.grant.expiresAt} />
{:else if request.status === 'ended'}
  <StatusChip kind="expired" date={endedAt(request) ?? undefined} />
{:else if request.status === 'denied'}
  <StatusChip kind="denied" />
{:else if request.status === 'withdrawn'}
  <StatusChip kind="withdrawn" />
{:else}
  <StatusChip kind="waiting-treasurer" />
{/if}
