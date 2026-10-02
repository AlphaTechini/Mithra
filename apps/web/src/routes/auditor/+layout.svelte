<script lang="ts">
  /** Auditor layout: header with the party, then the two-pane workspace supplied by the page. */
  import { resolve } from '$app/paths';
  import type { Snippet } from 'svelte';
  import PartyBar from '$lib/components/PartyBar.svelte';
  import SessionGate from '$lib/components/SessionGate.svelte';

  let { children }: { children: Snippet } = $props();
</script>

<!-- A party with no role yet may come in: this is where a prospective auditor asks for access. -->
<SessionGate allow={['auditor', null]}>
  <header class="top">
    <a class="brand" href={resolve('/auditor')}>Mithra</a>
    <PartyBar />
  </header>
  <main id="main" tabindex="-1">
    {@render children()}
  </main>
</SessionGate>

<style>
  .top {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-5);
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
  }
  .brand {
    font-family: var(--font-serif);
    font-size: var(--text-24);
    color: var(--color-text);
    text-decoration: none;
  }
  main {
    padding: var(--space-5);
  }
  @media (max-width: 600px) {
    main {
      padding: var(--space-4);
    }
  }
</style>
