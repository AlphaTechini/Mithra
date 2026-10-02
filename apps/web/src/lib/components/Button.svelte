<script lang="ts">
  /**
   * The one button. Variants: primary (Lapis), secondary, quiet, danger (Garnet outline).
   * With `href` it renders a link that looks the same. `busy` shows a spinner and keeps the
   * button's width so nothing jumps. Keyboard: native button/link behaviour (Enter, Space).
   */
  import { resolve } from '$app/paths';
  import type { Pathname } from '$app/types';
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';

  interface Props {
    variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
    type?: 'button' | 'submit' | 'reset';
    href?: Pathname;
    /** An absolute http(s) URL on another site: a link that opens in a new tab. */
    externalHref?: string;
    busy?: boolean;
    disabled?: boolean;
    fullWidth?: boolean;
    small?: boolean;
    onclick?: (event: MouseEvent) => void;
    'aria-label'?: string;
    'aria-expanded'?: boolean;
    'aria-controls'?: string;
    'aria-haspopup'?: 'menu' | 'dialog' | boolean;
    title?: string;
    children: Snippet;
  }

  let {
    variant = 'primary',
    type = 'button',
    href,
    externalHref,
    busy = false,
    disabled = false,
    fullWidth = false,
    small = false,
    onclick,
    children,
    ...rest
  }: Props = $props();

  const inactive = $derived(disabled || busy);
</script>

{#if externalHref}
  <a
    class="btn {variant}"
    class:full={fullWidth}
    class:small
    href={externalHref}
    target="_blank"
    rel="external noopener noreferrer"
    {onclick}
    {...rest}
  >
    {@render children()}
  </a>
{:else if href && !inactive}
  <a
    class="btn {variant}"
    class:full={fullWidth}
    class:small
    href={resolve(href)}
    {onclick}
    {...rest}
  >
    {@render children()}
  </a>
{:else if href}
  <!-- A link cannot be disabled; render an inert, announced-as-disabled stand-in. -->
  <span class="btn {variant}" class:full={fullWidth} class:small role="link" aria-disabled="true">
    {@render children()}
  </span>
{:else}
  <button
    class="btn {variant}"
    class:full={fullWidth}
    class:small
    class:busy
    {type}
    disabled={inactive}
    aria-busy={busy ? 'true' : undefined}
    {onclick}
    {...rest}
  >
    <span class="label" class:hidden={busy}>{@render children()}</span>
    {#if busy}
      <span class="spinner"><Icon name="spinner" spin size={18} /></span>
    {/if}
  </button>
{/if}

<style>
  .btn {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    min-height: 2.5rem;
    padding: 0 var(--space-4);
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    font-size: var(--text-15);
    font-weight: 500;
    line-height: 1.2;
    text-decoration: none;
    white-space: nowrap;
    transition:
      background-color var(--motion-quick),
      border-color var(--motion-quick);
  }
  .small {
    min-height: 2rem;
    padding: 0 var(--space-3);
    font-size: var(--text-13);
  }
  .full {
    width: 100%;
  }
  .label {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }
  .hidden {
    visibility: hidden;
  }
  .spinner {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
  }

  .primary {
    background: var(--color-primary);
    color: var(--color-on-primary);
  }
  .primary:hover:not(:disabled):not([aria-disabled='true']) {
    background: var(--color-primary-hover);
  }
  .secondary {
    background: var(--color-surface);
    color: var(--color-text);
    border-color: var(--color-border-strong);
  }
  .secondary:hover:not(:disabled):not([aria-disabled='true']) {
    background: var(--color-surface-sunken);
  }
  .quiet {
    background: transparent;
    color: var(--color-link);
  }
  .quiet:hover:not(:disabled):not([aria-disabled='true']) {
    background: var(--color-selected-bg);
  }
  .danger {
    background: transparent;
    color: var(--color-danger-text);
    border-color: var(--color-danger);
  }
  .danger:hover:not(:disabled):not([aria-disabled='true']) {
    background: var(--color-danger-bg);
  }

  .btn:disabled:not(.busy),
  .btn[aria-disabled='true'] {
    opacity: 1;
    background: var(--color-surface-sunken);
    color: var(--color-text-muted);
    border-color: var(--color-border);
    cursor: not-allowed;
  }
  .btn.busy:disabled {
    cursor: progress;
  }
</style>
