<script lang="ts">
  /**
   * Right-side agent panel (a full-screen sheet on phones): chat transcript, prompt box, suggested
   * prompts and inline tool-use cards. Props and events only; the data layer comes later.
   *
   * Keyboard: Ctrl/Cmd+K toggles it from anywhere, Escape closes it, Tab is trapped inside while
   * it is open, and focus returns to whatever opened it. Enter sends, Shift+Enter adds a line.
   */
  import { tick } from 'svelte';
  import type { AgentMessage } from '$lib/types/ui';
  import ActionCard from './ActionCard.svelte';
  import Button from './Button.svelte';
  import Icon from './Icon.svelte';

  const DEFAULT_SUGGESTIONS = [
    'Distribute 1,200 CC for September.',
    'Why was last cycle flagged?',
    'What did we pay Holder B in Q3?',
    'Raise the cap to 3,000 CC.',
  ];

  interface Props {
    open?: boolean;
    messages?: readonly AgentMessage[];
    suggestions?: readonly string[];
    /** True while the agent is working on a reply. */
    busy?: boolean;
    /** When set, the prompt box is disabled and this explains why. */
    unavailableReason?: string;
    onsend?: (text: string) => void;
    onclose?: () => void;
  }

  let {
    open = $bindable(false),
    messages = [],
    suggestions = DEFAULT_SUGGESTIONS,
    busy = false,
    unavailableReason,
    onsend,
    onclose,
  }: Props = $props();

  let panel = $state<HTMLElement>();
  let textarea = $state<HTMLTextAreaElement>();
  let transcript = $state<HTMLElement>();
  let draft = $state('');
  let opener: HTMLElement | null = null;

  const FOCUSABLE =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function close(): void {
    open = false;
    onclose?.();
  }

  function focusables(): HTMLElement[] {
    return panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
  }

  // On open remember who had focus, move focus in; on close give focus back.
  $effect(() => {
    if (open) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      void tick().then(() =>
        (textarea && !textarea.disabled ? textarea : focusables()[0])?.focus(),
      );
      return () => {
        const target = opener;
        opener = null;
        if (target?.isConnected) target.focus();
      };
    }
  });

  // Keep the newest message in view.
  $effect(() => {
    void messages.length;
    if (open && transcript) transcript.scrollTop = transcript.scrollHeight;
  });

  function onWindowKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (open) close();
      else open = true;
      return;
    }
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Tab') {
      const items = focusables();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel?.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  function send(text: string): void {
    const value = text.trim();
    if (!value || busy || unavailableReason) return;
    onsend?.(value);
    draft = '';
  }

  function onPromptKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send(draft);
    }
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if open}
  <div class="scrim" aria-hidden="true" onclick={close}></div>
  <div
    class="panel"
    bind:this={panel}
    role="dialog"
    aria-modal="true"
    aria-labelledby="agent-panel-title"
  >
    <header>
      <h2 id="agent-panel-title">Agent</h2>
      <Button variant="quiet" small aria-label="Close agent panel" onclick={close}>
        <Icon name="x" size={18} />
        <span class="close-text">Close</span>
      </Button>
    </header>

    <div
      class="transcript"
      bind:this={transcript}
      role="log"
      aria-live="polite"
      aria-label="Conversation"
    >
      {#if messages.length === 0}
        <p class="hint">
          Ask for a distribution, the reason behind a flag, or a payment history. The agent works
          inside your mandate and never signs for you.
        </p>
      {/if}
      {#each messages as message (message.id)}
        {#if message.role === 'tool'}
          <div class="row tool">
            <ActionCard
              title={message.action.title}
              status={message.action.status}
              summary={message.action.summary}
              items={message.action.details}
            />
          </div>
        {:else}
          <div class="row {message.role}">
            <p class="bubble">
              <span class="sr-only"
                >{message.role === 'user' ? 'You' : 'Agent'}:
              </span>{message.text}
            </p>
          </div>
        {/if}
      {/each}
      {#if busy}
        <p class="working"><Icon name="spinner" spin size={14} /> The agent is working…</p>
      {/if}
    </div>

    <form
      class="composer"
      onsubmit={(event) => {
        event.preventDefault();
        send(draft);
      }}
    >
      {#if suggestions.length > 0}
        <ul class="suggestions" aria-label="Suggested prompts">
          {#each suggestions as suggestion (suggestion)}
            <li>
              <button
                type="button"
                class="suggestion"
                disabled={busy || !!unavailableReason}
                onclick={() => send(suggestion)}>{suggestion}</button
              >
            </li>
          {/each}
        </ul>
      {/if}
      {#if unavailableReason}<p class="hint" role="status">{unavailableReason}</p>{/if}
      <label class="sr-only" for="agent-prompt">Message to the agent</label>
      <div class="prompt">
        <textarea
          id="agent-prompt"
          bind:this={textarea}
          bind:value={draft}
          rows="2"
          placeholder="Ask the agent"
          disabled={!!unavailableReason}
          onkeydown={onPromptKeydown}></textarea>
        <Button type="submit" disabled={!draft.trim() || busy || !!unavailableReason}>
          <Icon name="send" size={16} /> Send
        </Button>
      </div>
    </form>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: var(--strip-height) 0 0 0;
    z-index: 40;
    background: var(--color-scrim);
  }
  .panel {
    position: fixed;
    /* Leave the network badge strip visible above the panel. */
    top: var(--strip-height);
    right: 0;
    bottom: 0;
    z-index: 50;
    display: flex;
    flex-direction: column;
    width: min(26rem, 100vw);
    background: var(--color-surface);
    box-shadow: var(--shadow-panel);
    animation: slide-in var(--motion-quick) ease-out;
  }
  @media (max-width: 600px) {
    .panel {
      width: 100vw;
    }
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--color-border);
  }
  h2 {
    margin: 0;
    font-size: var(--text-18);
  }
  .transcript {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
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
  .working {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--text-13);
  }
  .composer {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4) var(--space-4);
    border-top: 1px solid var(--color-border);
  }
  .suggestions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    list-style: none;
    margin: 0;
    padding: 0;
    max-width: none;
  }
  .suggestion {
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-pill);
    background: var(--color-surface);
    font-size: var(--text-13);
    text-align: left;
  }
  .suggestion:hover:not(:disabled) {
    background: var(--color-surface-sunken);
  }
  .suggestion:disabled {
    color: var(--color-text-muted);
  }
  .prompt {
    display: flex;
    gap: var(--space-2);
    align-items: flex-end;
  }
  textarea {
    flex: 1;
    min-width: 0;
    resize: vertical;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }
  textarea:disabled {
    background: var(--color-surface-sunken);
    color: var(--color-text-muted);
  }
  @keyframes slide-in {
    from {
      transform: translateX(2rem);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }
  @media (max-width: 380px) {
    .close-text {
      display: none;
    }
  }
</style>
