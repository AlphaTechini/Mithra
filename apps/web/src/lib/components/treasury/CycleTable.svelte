<script lang="ts">
  /** A table of cycles: name (a link), status chip, total, approvals and the Seeded tag. */
  import { resolve } from '$app/paths';
  import type { CycleSummary } from '@mithra/shared';
  import { cycleChip } from '$lib/cycle';
  import { formatAge } from '$lib/format';
  import type { TableColumn } from '$lib/types/ui';
  import Amount from '../Amount.svelte';
  import DataTable from '../DataTable.svelte';
  import StatusChip from '../StatusChip.svelte';

  interface Props {
    cycles: readonly CycleSummary[];
    caption: string;
    /** Fewer columns, for the overview. */
    compact?: boolean;
  }

  let { cycles, caption, compact = false }: Props = $props();

  const columns = $derived<TableColumn[]>(
    compact
      ? [
          { key: 'label', label: 'Cycle' },
          { key: 'status', label: 'Status' },
          { key: 'total', label: 'Total', numeric: true },
        ]
      : [
          { key: 'label', label: 'Cycle' },
          { key: 'status', label: 'Status' },
          { key: 'total', label: 'Total', numeric: true },
          { key: 'approvals', label: 'Approvals', numeric: true },
          { key: 'flags', label: 'Flags', numeric: true },
          { key: 'createdAt', label: 'Started' },
        ],
  );
</script>

<DataTable {caption} {columns} rows={cycles} rowKey={(c: CycleSummary) => c.cycleId}>
  {#snippet cell(cycle: CycleSummary, column: TableColumn)}
    {#if column.key === 'label'}
      <a href={resolve(`/app/cycles/${cycle.cycleId}`)}>{cycle.label}</a>
    {:else if column.key === 'status'}
      {@const chip = cycleChip(cycle)}
      <span class="chips">
        <StatusChip kind={chip.kind} progress={chip.progress} />
        {#if cycle.seeded}<StatusChip kind="seeded" />{/if}
      </span>
    {:else if column.key === 'total'}
      {#if cycle.total !== null}<Amount value={cycle.total} />{:else}<span class="muted"
          >Not yet</span
        >{/if}
    {:else if column.key === 'approvals'}
      {#if cycle.approvals}{cycle.approvals.have} of {cycle.approvals.need}{:else}<span
          class="muted">None needed</span
        >{/if}
    {:else if column.key === 'flags'}
      {cycle.flagCount}
    {:else if column.key === 'createdAt'}
      {formatAge(cycle.createdAt)}
    {/if}
  {/snippet}
</DataTable>

<style>
  .chips {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }
  .muted {
    color: var(--color-text-muted);
  }
</style>
