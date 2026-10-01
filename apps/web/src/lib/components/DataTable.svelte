<script lang="ts" generics="Row">
  /**
   * Accessible table with a caption. Numeric columns are right-aligned with tabular figures. At
   * 600 px and below each row becomes a stacked card of label/value pairs, using the same DOM
   * (every cell carries a data-label that CSS shows). Cells default to `String(row[key])`; pass a
   * `cell` snippet for anything richer (chips, amounts).
   */
  import type { Snippet } from 'svelte';
  import type { TableColumn } from '$lib/types/ui';

  interface Props {
    caption: string;
    columns: readonly TableColumn[];
    rows: readonly Row[];
    rowKey: (row: Row) => string;
    cell?: Snippet<[Row, TableColumn]>;
    /** Visually hide the caption (it stays available to screen readers). */
    hideCaption?: boolean;
  }

  let { caption, columns, rows, rowKey, cell, hideCaption = false }: Props = $props();

  function text(row: Row, column: TableColumn): string {
    const value = (row as Record<string, unknown>)[column.key];
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : '';
  }
</script>

<div class="wrap">
  <table>
    <caption class:sr-only={hideCaption}>{caption}</caption>
    <thead>
      <tr>
        {#each columns as column (column.key)}
          <th scope="col" class:numeric={column.numeric}>{column.label}</th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each rows as row (rowKey(row))}
        <tr>
          {#each columns as column (column.key)}
            <td class:numeric={column.numeric} data-label={column.label}>
              {#if cell}{@render cell(row, column)}{:else}{text(row, column)}{/if}
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .wrap {
    overflow-x: auto;
  }
  table {
    width: 100%;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    border-collapse: separate;
    border-spacing: 0;
  }
  caption {
    padding: 0 0 var(--space-2);
    text-align: left;
    font-weight: 600;
  }
  th,
  td {
    padding: var(--space-3) var(--space-4);
    text-align: left;
    vertical-align: top;
    border-bottom: 1px solid var(--color-border);
  }
  th {
    font-weight: 600;
    font-size: var(--text-13);
    color: var(--color-text-muted);
    background: var(--color-surface-sunken);
  }
  tbody tr:last-child td {
    border-bottom: 0;
  }
  .numeric {
    text-align: right;
    font-variant-numeric: tabular-nums lining-nums;
  }

  @media (max-width: 600px) {
    .wrap {
      overflow: visible;
    }
    table,
    caption,
    tbody,
    tr,
    td {
      display: block;
      width: 100%;
    }
    table {
      background: none;
      border: 0;
    }
    thead {
      /* Column headers stay in the DOM for assistive technology; each cell repeats its label. */
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
    tr {
      margin-bottom: var(--space-3);
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
    }
    td {
      display: flex;
      justify-content: space-between;
      gap: var(--space-4);
      padding: var(--space-2) var(--space-4);
      text-align: right;
    }
    td:last-child {
      border-bottom: 0;
    }
    td::before {
      content: attr(data-label);
      flex: none;
      color: var(--color-text-muted);
      font-size: var(--text-13);
      text-align: left;
    }
  }
</style>
