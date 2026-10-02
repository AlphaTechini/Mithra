import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import type { TimelineStep } from '$lib/types/ui';
import AgentTimeline from './AgentTimeline.svelte';

const steps = (a: TimelineStep['status'], b: TimelineStep['status']): TimelineStep[] => [
  { id: 'wake', label: 'Woke up', status: a },
  { id: 'snap', label: 'Snapshot taken', status: b, detail: '4 holders' },
];

describe('AgentTimeline', () => {
  it('renders every step with its status as text for assistive technology', () => {
    render(AgentTimeline, { steps: steps('done', 'running') });
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText(/Snapshot taken/).closest('li')).toHaveAttribute(
      'data-status',
      'running',
    );
    expect(screen.getByText('4 holders')).toBeInTheDocument();
  });

  it('announces a step once when it completes, not on first render', async () => {
    const { rerender } = render(AgentTimeline, { steps: steps('done', 'running') });
    const live = screen.getByRole('status');
    expect(live).toHaveTextContent('');
    await rerender({ steps: steps('done', 'done') });
    expect(live).toHaveTextContent('Snapshot taken: done');
  });
});
