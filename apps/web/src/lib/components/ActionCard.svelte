<script lang="ts">
  /**
   * Compact, expandable card for one agent tool call, e.g. "Created proposal for September,
   * 4 payees, 1,200 CC". Keyboard: the header is a button (Enter or Space toggles); its
   * aria-expanded and aria-controls describe the details region.
   */
  import type { Snippet } from 'svelte';
  import type { ActionDetail, ActionStatus } from '$lib/types/ui';
  import Icon from './Icon.svelte';

  interface Props {
    title: string;
    status: ActionStatus;
    summary?: string;
    /** Key/value list shown when expanded. */
    items?: readonly ActionDetail[];
    /** Free-form details, shown after the items when expanded. */
    details?: Snippet;
    open?: boolean;
  }

  let { title, status, summary, items = [], details, open = $bindable(false) }: Props = $props();

  const uid = $props.id();
  const expandable = $derived(items.length > 0 || details !== undefined);
  const STATUS_WORD = { running: 'Running', done: 'Done', failed: 'Failed' } as const;
</script>

{#snippet headContent()}
  <span class="state">
    {#if status === 'running'}
      <Icon name="spinner" size={16} spin />
    {:else if status === 'done'}
      <Icon name="check-circle" size={16} />
    {:else}
      <Icon name="x-circle" size={16} />
    {/if}
    <span class="sr-only">{STATUS_WORD[status]}: </span>
  </span>
  <span class="text">
    <span class="title">{title}</span>
    {#if summary}<span class="summary">{summary}</span>{/if}
  </span>
{/snippet}

<article class="card {status}" data-status={status}>
  {#if expandable}
    <button
      type="button"
      class="head"
      aria-expanded={open}
      aria-controls="{uid}-details"
      onclick={() => (open = !open)}
    >
      {@render headContent()}
      <span class="chevron" class:open><Icon name="chevron-down" size={16} /></span>
    </button>
  {:else}
    <div class="head">{@render headContent()}</div>
  {/if}
  {#if expandable && open}
    <div class="details" id="{uid}-details">
      {#if items.length > 0}
        <dl>
          {#each items as item (item.label)}
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          {/each}
        </dl>
      {/if}
      {@render details?.()}
    </div>
  {/if}
</article>

<style>
  .card {
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    font-size: var(--text-13);
  }
  .head {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border: 0;
    background: none;
    text-align: left;
    color: var(--color-text);
  }
  button.head {
    border-radius: var(--radius-md);
  }
  button.head:hover {
    background: var(--color-surface-sunken);
  }
  .state {
    padding-top: 0.125rem;
    color: var(--color-text-muted);
  }
  .done .state {
    color: var(--color-success);
  }
  .failed .state {
    color: var(--color-danger);
  }
  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .title {
    font-weight: 500;
  }
  .summary {
    color: var(--color-text-muted);
  }
  .chevron {
    padding-top: 0.125rem;
    color: var(--color-text-muted);
  }
  .chevron.open {
    transform: rotate(180deg);
  }
  .details {
    padding: var(--space-2) var(--space-3) var(--space-3);
    border-top: 1px solid var(--color-border);
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--space-1) var(--space-3);
    margin: 0;
  }
  dt {
    color: var(--color-text-muted);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
