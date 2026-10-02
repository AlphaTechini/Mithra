<script lang="ts">
  /**
   * A modal dialog: a titled panel over a scrim. Keyboard: Tab is trapped inside, Escape closes,
   * and focus returns to whatever opened it. The first focusable control (or `initialFocus`)
   * receives focus on open. Content comes through the `children` snippet; put the actions in
   * `footer`. Closing is always the caller's decision through `onclose`.
   */
  import { tick, type Snippet } from 'svelte';
  import Button from './Button.svelte';
  import Icon from './Icon.svelte';

  interface Props {
    title: string;
    onclose: () => void;
    children: Snippet;
    footer?: Snippet;
    /** CSS selector of the element to focus first, inside the dialog. */
    initialFocus?: string;
    wide?: boolean;
  }

  let { title, onclose, children, footer, initialFocus, wide = false }: Props = $props();

  const uid = $props.id();
  let panel = $state<HTMLElement>();
  let opener: HTMLElement | null = null;

  const FOCUSABLE =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function focusables(): HTMLElement[] {
    return panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
  }

  $effect(() => {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void tick().then(() => {
      const preferred = initialFocus ? panel?.querySelector<HTMLElement>(initialFocus) : null;
      const items = focusables();
      (preferred ?? items.find((el) => !el.closest('header')) ?? items[0])?.focus();
    });
    return () => {
      const target = opener;
      opener = null;
      if (target?.isConnected) target.focus();
    };
  });

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onclose();
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

<svelte:window onkeydown={onKeydown} />

<div class="scrim" aria-hidden="true" onclick={onclose}></div>
<div
  class="dialog"
  class:wide
  bind:this={panel}
  role="dialog"
  aria-modal="true"
  aria-labelledby="{uid}-title"
>
  <header>
    <h2 id="{uid}-title">{title}</h2>
    <Button variant="quiet" small aria-label="Close" onclick={onclose}>
      <Icon name="x" size={18} />
    </Button>
  </header>
  <div class="body">{@render children()}</div>
  {#if footer}<footer>{@render footer()}</footer>{/if}
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: var(--color-scrim);
  }
  .dialog {
    position: fixed;
    z-index: 61;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    width: min(32rem, calc(100vw - 2rem));
    max-height: calc(100vh - 2rem);
    background: var(--color-surface);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
  }
  .dialog.wide {
    width: min(48rem, calc(100vw - 2rem));
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--color-border);
  }
  h2 {
    margin: 0;
    font-size: var(--text-18);
  }
  .body {
    padding: var(--space-4);
    overflow-y: auto;
  }
  footer {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--color-border);
  }
</style>
