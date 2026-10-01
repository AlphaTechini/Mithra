<script lang="ts">
  /**
   * Right-side agent panel (a full-screen sheet on phones): chat transcript, prompt box, suggested
   * prompts and inline tool-use cards. Props and events only; the data layer comes later.
   *
   * Keyboard: Ctrl/Cmd+K toggles it from anywhere, Escape closes it, Tab is trapped inside while
   * it is open, and focus returns to whatever opened it. Enter sends, Shift+Enter adds a line.
   * Following an in-app link from an action card or the transcript closes the panel, so the page it
   * leads to is not left under the scrim.
   */
  import { tick } from 'svelte';
  import type { AgentMessage } from '$lib/types/ui';
  import AgentComposer from './AgentComposer.svelte';
  import AgentTranscript from './AgentTranscript.svelte';
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
    /** A failed load or send: what failed and what to do. */
    error?: { title: string; message: string } | null;
    onretry?: () => void;
    onsend?: (text: string) => void;
    onclose?: () => void;
  }

  let {
    open = $bindable(false),
    messages = [],
    suggestions = DEFAULT_SUGGESTIONS,
    busy = false,
    unavailableReason,
    error = null,
    onretry,
    onsend,
    onclose,
  }: Props = $props();

  let panel = $state<HTMLElement>();
  let composer = $state<{ focus: () => void }>();
  let transcript = $state<HTMLElement>();
  let opener: HTMLElement | null = null;

  const FOCUSABLE =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function close(): void {
    open = false;
    onclose?.();
  }

  /** A plain click on an in-app link in the transcript: the visitor is going somewhere else. */
  function onTranscriptClick(event: MouseEvent): void {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor || anchor.getAttribute('target') === '_blank') return;
    // After the click has reached the router: closing at once would remove the link first.
    setTimeout(close, 0);
  }

  function focusables(): HTMLElement[] {
    return panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
  }

  // On open remember who had focus, move focus in; on close give focus back.
  $effect(() => {
    if (open) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      void tick().then(() => {
        composer?.focus();
        if (!panel?.contains(document.activeElement)) focusables()[0]?.focus();
      });
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

    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="scroll" bind:this={transcript} onclick={onTranscriptClick}>
      <AgentTranscript {messages} {busy} {error} {onretry} />
    </div>

    <div class="composer-wrap">
      <AgentComposer bind:this={composer} {suggestions} {busy} {unavailableReason} {onsend} />
    </div>
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
  .scroll {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-4);
  }
  .composer-wrap {
    padding: var(--space-3) var(--space-4) var(--space-4);
    border-top: 1px solid var(--color-border);
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
