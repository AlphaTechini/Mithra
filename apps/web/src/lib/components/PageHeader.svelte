<script lang="ts">
  /** Page title (Newsreader), an optional one-line description and an optional actions slot. */
  import type { Snippet } from 'svelte';

  let { title, description, actions }: { title: string; description?: string; actions?: Snippet } =
    $props();
</script>

<header class="page-header">
  <div>
    <h1>{title}</h1>
    {#if description}<p class="description">{description}</p>{/if}
  </div>
  {#if actions}<div class="actions">{@render actions()}</div>{/if}
</header>

<style>
  .page-header {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }
  h1 {
    margin-bottom: var(--space-1);
  }
  .description {
    margin: 0;
    color: var(--color-text-muted);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
</style>
