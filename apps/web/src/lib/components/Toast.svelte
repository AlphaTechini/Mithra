<script lang="ts">
  /**
   * The toast region: confirmations from the store, announced politely. Each toast has a dismiss
   * button and fades out on its own unless it is an error. Mount once, in the root layout.
   */
  import { toasts } from '$lib/stores/toasts.svelte';
  import Icon from './Icon.svelte';
</script>

<div class="region" role="status" aria-live="polite" aria-label="Notifications">
  {#each toasts.items as toast (toast.id)}
    <div class="toast {toast.kind}">
      <Icon name={toast.kind === 'error' ? 'alert' : 'check-circle'} size={18} />
      <span class="message">{toast.message}</span>
      <button
        type="button"
        class="dismiss"
        aria-label="Dismiss notification"
        onclick={() => toasts.dismiss(toast.id)}
      >
        <Icon name="x" size={16} />
      </button>
    </div>
  {/each}
</div>

<style>
  .region {
    position: fixed;
    right: var(--space-4);
    bottom: calc(var(--space-4) + var(--bottom-bar-offset, 0px));
    z-index: 60;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    width: min(24rem, calc(100vw - 2rem));
    pointer-events: none;
  }
  .toast {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    background: var(--color-inverse-bg);
    color: var(--color-inverse-text);
    box-shadow: var(--shadow-md);
    pointer-events: auto;
  }
  .message {
    flex: 1;
  }
  .dismiss {
    display: grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: inherit;
  }
  .dismiss:focus-visible {
    outline-color: var(--color-inverse-text);
  }
  @media (max-width: 600px) {
    .region {
      --bottom-bar-offset: var(--bottom-bar-height);
    }
  }
</style>
