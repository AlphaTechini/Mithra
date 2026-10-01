<script lang="ts">
  /**
   * The status of an audit request as icon + word. Granted, ended and denied reuse StatusChip
   * ("Active until Oct 14", "Access ended Oct 14", "Request denied"); a request still waiting for
   * the treasurer, or withdrawn by the auditor, gets a neutral chip with its own wording.
   */
  import type { AuditRequestView } from '@mithra/shared';
  import Icon from '../Icon.svelte';
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
  <span class="chip"><Icon name="ban" size={14} /><span>Request withdrawn</span></span>
{:else}
  <span class="chip"><Icon name="clock" size={14} /><span>Waiting for the treasurer</span></span>
{/if}

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: 0.125rem var(--space-2);
    border-radius: var(--radius-pill);
    background: var(--color-neutral-bg);
    color: var(--color-neutral-text);
    font-size: var(--text-13);
    font-weight: 500;
    line-height: 1.4;
    white-space: nowrap;
  }
</style>
