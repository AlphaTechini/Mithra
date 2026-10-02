<script lang="ts">
  /**
   * The checks the agent ran: each with Passed or Flagged (icon and word), what it measured and
   * the limit. Advisory checks written by the AI are marked "Advisory" and drawn with a dashed
   * edge, so they read as context, not as a deterministic result. Flagged checks come first.
   */
  import type { CheckView } from '@mithra/shared';
  import Icon from '../Icon.svelte';
  import StatusChip from '../StatusChip.svelte';

  let { checks, label = 'Checks' }: { checks: readonly CheckView[]; label?: string } = $props();

  const ordered = $derived([...checks].sort((a, b) => Number(a.passed) - Number(b.passed)));
</script>

<ul class="checks" aria-label={label}>
  {#each ordered as check (check.code)}
    <li class:advisory={check.source === 'ai'} class:flagged={!check.passed}>
      <div class="head">
        <StatusChip kind={check.passed ? 'passed' : 'flagged'} />
        {#if check.source === 'ai'}<StatusChip kind="advisory" />{/if}
        <span class="label">{check.label}</span>
      </div>
      <p class="actual">{check.actual}</p>
      {#if check.limit}<p class="limit">Limit: {check.limit}</p>{/if}
      {#if !check.passed && check.blocking}
        <p class="blocking"><Icon name="ban" size={14} /> This stops automatic payment.</p>
      {/if}
    </li>
  {/each}
</ul>

<style>
  .checks {
    list-style: none;
    margin: 0;
    padding: 0;
    max-width: none;
    display: grid;
    gap: var(--space-2);
  }
  li {
    padding: var(--space-3);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }
  li.flagged {
    border-color: var(--color-danger);
  }
  li.advisory {
    border-style: dashed;
    border-color: var(--color-border-strong);
    background: var(--color-surface-sunken);
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }
  .label {
    font-weight: 600;
  }
  p {
    margin: var(--space-1) 0 0;
    max-width: none;
  }
  .limit {
    color: var(--color-text-muted);
    font-size: var(--text-13);
  }
  .blocking {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    color: var(--color-danger-text);
    font-size: var(--text-13);
  }
</style>
