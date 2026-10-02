<script lang="ts">
  /**
   * Holder layout: a single column with no navigation beyond payments and units. Holders only ever
   * see their own position; each holder page carries the privacy note (PrivacyNote).
   */
  import { resolve } from '$app/paths';
  import type { Snippet } from 'svelte';
  import PartyBar from '$lib/components/PartyBar.svelte';
  import SessionGate from '$lib/components/SessionGate.svelte';

  let { children }: { children: Snippet } = $props();
</script>

<SessionGate allow={['holder']}>
  <header class="top">
    <a class="brand" href={resolve('/holder')}>Mithra</a>
    <PartyBar switcher="link" />
  </header>
  <div class="column">
    <nav aria-label="Holder">
      <a href="{resolve('/holder')}#units">Units</a>
      <a href="{resolve('/holder')}#payments">Payments</a>
    </nav>
    <main id="main" tabindex="-1">
      {@render children()}
    </main>
  </div>
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
  .column {
    max-width: 48rem;
    margin: 0 auto;
    padding: var(--space-5) var(--space-4) var(--space-7);
  }
  nav {
    display: flex;
    gap: var(--space-4);
    margin-bottom: var(--space-5);
  }
</style>
