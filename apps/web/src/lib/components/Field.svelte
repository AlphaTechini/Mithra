<script lang="ts">
  /**
   * A labelled form control with an optional hint and an inline error. The control itself comes
   * from the `control` snippet, which receives the attributes that tie it to the label, hint and
   * error (`id`, `aria-describedby`, `aria-invalid`); spread them onto the input, select or
   * textarea. Errors are announced and also visible as text, never colour alone.
   */
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';

  interface ControlAttrs {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': 'true' | undefined;
  }

  interface Props {
    label: string;
    hint?: string;
    error?: string | null;
    control: Snippet<[ControlAttrs]>;
    /** Narrow field for short values (numbers, dates). */
    short?: boolean;
  }

  let { label, hint, error = null, control, short = false }: Props = $props();

  const uid = $props.id();
  const describedBy = $derived(
    [hint ? `${uid}-hint` : '', error ? `${uid}-error` : ''].filter(Boolean).join(' ') || undefined,
  );
</script>

<div class="field" class:short>
  <label for="{uid}-control">{label}</label>
  {@render control({
    id: `${uid}-control`,
    'aria-describedby': describedBy,
    'aria-invalid': error ? 'true' : undefined,
  })}
  {#if hint}<p class="hint" id="{uid}-hint">{hint}</p>{/if}
  {#if error}
    <p class="error" id="{uid}-error" role="alert">
      <Icon name="alert" size={14} />
      <span>{error}</span>
    </p>
  {/if}
</div>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    max-width: 32rem;
    margin-bottom: var(--space-4);
  }
  .field.short {
    max-width: 14rem;
  }
  label {
    font-weight: 500;
  }
  .field :global(input),
  .field :global(select),
  .field :global(textarea) {
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    min-height: 2.5rem;
  }
  .field :global(textarea) {
    resize: vertical;
  }
  .field :global([aria-invalid='true']) {
    border-color: var(--color-danger);
    border-width: 2px;
  }
  .field :global(input:disabled),
  .field :global(select:disabled),
  .field :global(textarea:disabled),
  .field :global(input[readonly]) {
    background: var(--color-surface-sunken);
    color: var(--color-text-muted);
  }
  .hint {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--text-13);
  }
  .error {
    display: flex;
    align-items: flex-start;
    gap: var(--space-1);
    margin: 0;
    color: var(--color-danger-text);
    font-size: var(--text-13);
    font-weight: 500;
  }
  .error :global(svg) {
    flex: none;
    margin-top: 0.15rem;
  }
</style>
