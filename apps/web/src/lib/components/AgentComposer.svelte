<script lang="ts">
  /**
   * Prompt box with suggested prompts. Enter sends, Shift+Enter adds a line. Suggestions are
   * buttons. While the agent is working, or when `unavailableReason` is set, sending is disabled.
   */
  import Button from './Button.svelte';
  import Icon from './Icon.svelte';

  interface Props {
    suggestions: readonly string[];
    busy?: boolean;
    unavailableReason?: string;
    onsend?: (text: string) => void;
  }

  let { suggestions, busy = false, unavailableReason, onsend }: Props = $props();

  const uid = $props.id();
  let textarea = $state<HTMLTextAreaElement>();
  let draft = $state('');

  /** Moves focus to the prompt box when it can take it, otherwise to the first control. */
  export function focus(): void {
    if (textarea && !textarea.disabled) textarea.focus();
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
  <label class="sr-only" for="{uid}-prompt">Message to the agent</label>
  <div class="prompt">
    <textarea
      id="{uid}-prompt"
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

<style>
  .composer {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .hint {
    color: var(--color-text-muted);
    font-size: var(--text-13);
    margin: 0;
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
</style>
