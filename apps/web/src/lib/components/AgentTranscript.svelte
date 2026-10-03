<script lang="ts">
  /**
   * The conversation with the agent: your messages, the agent's replies and every tool call as an
   * action card (A10). A `degraded` reply (the language model was unavailable) is styled as an
   * error state with its text. Shared by the agent panel and the Agent page. Informative only.
   */
  import type { AgentMessage } from '$lib/types/ui';
  import ActionCard from './ActionCard.svelte';
  import ErrorState from './ErrorState.svelte';
  import Icon from './Icon.svelte';

  interface Props {
    messages: readonly AgentMessage[];
    busy?: boolean;
    /** A failed load or send: what failed and what to do. */
    error?: { title: string; message: string } | null;
    onretry?: () => void;
    hint?: string;
    /** Label for the live region, e.g. "Conversation". */
    label?: string;
  }

  let {
    messages,
    busy = false,
    error = null,
    onretry,
    hint = 'Ask for a distribution, the reason behind a flag, or a payment history. The agent works inside your mandate and never signs for you.',
    label = 'Conversation',
  }: Props = $props();
</script>

<div class="transcript" role="log" aria-live="polite" aria-label={label}>
  {#if messages.length === 0 && !busy && !error}
    <p class="hint">{hint}</p>
  {/if}
  {#each messages as message (message.id)}
    {#if message.role === 'tool'}
      <div class="row tool">
        <ActionCard
          title={message.action.title}
          status={message.action.status}
          summary={message.action.summary}
          items={message.action.details}
          href={message.action.href}
        />
      </div>
    {:else if message.role === 'agent' && message.degraded}
      <div class="row agent">
        <p class="bubble degraded" data-degraded="true">
          <Icon name="alert" size={16} />
          <span>
            <span class="sr-only">Agent, limited reply: </span>{message.text}
          </span>
        </p>
      </div>
    {:else}
      <div class="row {message.role}">
        <p class="bubble">
          <span class="sr-only">{message.role === 'user' ? 'You' : 'Agent'}: </span>{message.text}
        </p>
      </div>
    {/if}
  {/each}
  {#if busy}
    <p class="working"><Icon name="spinner" spin size={14} /> Working…</p>
  {/if}
  {#if error}
    <ErrorState title={error.title} message={error.message} {onretry} />
  {/if}
</div>

<style>
  .transcript {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }
  .hint {
    color: var(--color-text-muted);
    font-size: var(--text-13);
    margin: 0;
  }
  .row {
    display: flex;
  }
  .row.user {
    justify-content: flex-end;
  }
  .row.tool > :global(*) {
    flex: 1;
    min-width: 0;
  }
  .bubble {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-lg);
    max-width: 85%;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .user .bubble {
    background: var(--color-selected-bg);
    color: var(--color-text);
  }
  .agent .bubble {
    background: var(--color-surface-sunken);
  }
  .bubble.degraded {
    display: flex;
    gap: var(--space-2);
    align-items: flex-start;
    background: var(--color-danger-bg);
    color: var(--color-danger-text);
    border: 1px solid var(--color-danger);
  }
  .bubble.degraded :global(svg) {
    flex: none;
    margin-top: 0.2rem;
  }
  .working {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--text-13);
  }
</style>
