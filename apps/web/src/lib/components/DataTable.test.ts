import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import DataTable from './DataTable.svelte';

describe('DataTable', () => {
  const columns = [
    { key: 'holder', label: 'Holder' },
    { key: 'amount', label: 'Amount', numeric: true },
  ];
  const rows = [
    { id: 'a', holder: 'Holder A', amount: '300.00' },
    { id: 'b', holder: 'Holder B', amount: '900.00' },
  ];

  it('has a caption, column headers and a data-label on every cell', () => {
    const { container } = render(DataTable, {
      caption: 'Per-holder amounts',
      columns,
      rows,
      rowKey: (r: unknown) => (r as { id: string }).id,
    });
    expect(screen.getByRole('table', { name: 'Per-holder amounts' })).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader')).toHaveLength(2);
    const cells = container.querySelectorAll('td');
    expect(cells).toHaveLength(4);
    expect(Array.from(cells, (c) => c.getAttribute('data-label'))).toEqual([
      'Holder',
      'Amount',
      'Holder',
      'Amount',
    ]);
  });

  it('marks numeric columns for right alignment', () => {
    const { container } = render(DataTable, {
      caption: 'x',
      columns,
      rows,
      rowKey: (r: unknown) => (r as { id: string }).id,
    });
    expect(container.querySelectorAll('td.numeric')).toHaveLength(2);
    expect(container.querySelectorAll('th.numeric')).toHaveLength(1);
  });
});
