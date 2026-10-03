<script lang="ts">
  /** The activity log as a list: when, one plain-English line, the Seeded tag and a link. */
  import type { ActivityEntry } from '@mithra/shared';
  import { formatDateTime } from '$lib/format';
  import AppLink from '../AppLink.svelte';
  import StatusChip from '../StatusChip.svelte';

  let { entries, label }: { entries: readonly ActivityEntry[]; label: string } = $props();
</script>

<ul class="log" aria-label={label}>
  {#each entries as entry (entry.id)}
    <li>
      <time datetime={entry.at}>{formatDateTime(entry.at)}</time>
      <span class="text">
        {entry.text}
        {#if entry.seeded}<StatusChip kind="seeded" />{/if}
        {#if entry.link}<AppLink link={entry.link}>View</AppLink>{/if}
      </span>
    </li>
  {/each}
</ul>

<style>
  .log {
    list-style: none;
    margin: 0;
    padding: 0;
    max-width: none;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }
  li {
    display: grid;
    grid-template-columns: 11rem minmax(0, 1fr);
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--color-border);
  }
  li:last-child {
    border-bottom: 0;
  }
  time {
    color: var(--color-text-muted);
    font-size: var(--text-13);
    font-variant-numeric: tabular-nums;
  }
  .text {
    overflow-wrap: anywhere;
  }
  @media (max-width: 600px) {
    li {
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-1);
    }
  }
</style>
