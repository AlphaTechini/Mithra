<script lang="ts">
  /**
   * Vertical timeline of an agent run. Steps fill in as the `steps` prop changes; this is the only
   * motion that runs without a user action, and it is switched off by reduced motion. Each step
   * that completes is announced once through a polite live region. Informative only, no keyboard
   * interaction.
   */
  import { untrack } from 'svelte';
  import type { TimelineStep } from '$lib/types/ui';
  import Icon from './Icon.svelte';

  let { steps, label = 'Agent progress' }: { steps: readonly TimelineStep[]; label?: string } =
    $props();

  const WORDS = {
    pending: 'Waiting',
    running: 'In progress',
    done: 'Done',
    failed: 'Failed',
  } as const;

  let announcement = $state('');
  // Steps already done on first render are not announced.
  let seen = new Map<string, TimelineStep['status']>(
    untrack(() => steps.map((s) => [s.id, s.status])),
  );

  $effect(() => {
    let latest = '';
    for (const step of steps) {
      const before = seen.get(step.id);
      if (before !== step.status && (step.status === 'done' || step.status === 'failed')) {
        latest = `${step.label}: ${WORDS[step.status].toLowerCase()}`;
      }
    }
    seen = new Map(steps.map((s) => [s.id, s.status]));
    if (latest) announcement = latest;
  });

  function time(at: TimelineStep['at']): { iso: string; text: string } | null {
    if (at === undefined) return null;
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return null;
    return { iso: d.toISOString(), text: d.toISOString().slice(11, 19) + ' UTC' };
  }
</script>

<ol class="timeline" aria-label={label}>
  {#each steps as step (step.id)}
    {@const t = time(step.at)}
    <li class="step {step.status}" data-status={step.status}>
      <span class="marker">
        {#if step.status === 'done'}
          <Icon name="check" size={14} />
        {:else if step.status === 'failed'}
          <Icon name="x" size={14} />
        {:else if step.status === 'running'}
          <Icon name="spinner" size={14} spin />
        {/if}
      </span>
      <div class="body">
        <p class="title">
          {step.label}
          <span class="sr-only">, {WORDS[step.status].toLowerCase()}</span>
        </p>
        {#if step.detail}<p class="detail">{step.detail}</p>{/if}
        {#if t}<time class="at" datetime={t.iso}>{t.text}</time>{/if}
      </div>
    </li>
  {/each}
</ol>
<div class="sr-only" aria-live="polite" role="status">{announcement}</div>

<style>
  .timeline {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .step {
    position: relative;
    display: flex;
    gap: var(--space-3);
    padding-bottom: var(--space-4);
  }
  .step:not(:last-child)::before {
    content: '';
    position: absolute;
    left: 0.6875rem;
    top: 1.5rem;
    bottom: 0;
    width: 2px;
    background: var(--color-border);
  }
  .step.done:not(:last-child)::before {
    background: var(--color-success);
  }
  .marker {
    flex: none;
    display: grid;
    place-items: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 50%;
    border: 2px solid var(--color-border-strong);
    background: var(--color-surface);
    color: var(--color-text-muted);
    transition:
      background-color var(--motion-quick),
      border-color var(--motion-quick);
  }
  .done .marker {
    background: var(--color-success);
    border-color: var(--color-success);
    color: var(--color-surface);
  }
  .running .marker {
    border-color: var(--color-primary);
    color: var(--color-primary);
  }
  .failed .marker {
    background: var(--color-danger);
    border-color: var(--color-danger);
    color: var(--color-surface);
  }
  .body {
    min-width: 0;
  }
  .title {
    margin: 0;
    font-weight: 500;
  }
  .pending .title {
    color: var(--color-text-muted);
    font-weight: 400;
  }
  .detail {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--text-13);
  }
  .at {
    color: var(--color-text-muted);
    font-size: var(--text-13);
    font-variant-numeric: tabular-nums;
  }
</style>
