<script lang="ts">
  /**
   * Setup layout: the three-step progress indicator (numbered, a real sequence) around each step.
   * Requires a signed-in party.
   */
  import { page } from '$app/state';
  import { resolve } from '$app/paths';
  import type { Snippet } from 'svelte';
  import PartyBar from '$lib/components/PartyBar.svelte';
  import SessionGate from '$lib/components/SessionGate.svelte';

  let { children }: { children: Snippet } = $props();

  const steps = [
    { href: '/setup/organization', label: 'Organization' },
    { href: '/setup/policy', label: 'Policy' },
    { href: '/setup/mandate', label: 'Seal the mandate' },
  ] as const;

  const current = $derived(steps.findIndex((s) => page.url.pathname.startsWith(s.href)));
</script>

<SessionGate allow="any">
  <header class="top">
    <a class="brand" href={resolve('/')}>Mithra</a>
    <PartyBar />
  </header>
  <main id="main" tabindex="-1">
    <nav aria-label="Setup progress">
      <ol class="steps">
        {#each steps as step, i (step.href)}
          <li
            class:done={i < current}
            class:current={i === current}
            aria-current={i === current ? 'step' : undefined}
          >
            <span class="number" aria-hidden="true">{i + 1}</span>
            <span class="label">
              {step.label}
              {#if i < current}<span class="sr-only">(completed)</span>{/if}
            </span>
          </li>
        {/each}
      </ol>
    </nav>
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
    max-width: 48rem;
    margin: 0 auto;
    padding: var(--space-6) var(--space-4) var(--space-7);
  }
  .steps {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-5);
    list-style: none;
    margin: 0 0 var(--space-6);
    padding: 0;
    max-width: none;
  }
  li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--color-text-muted);
  }
  .number {
    display: grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    border: 2px solid var(--color-border-strong);
    border-radius: 50%;
    font-size: var(--text-13);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .current {
    color: var(--color-text);
    font-weight: 600;
  }
  .current .number {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: var(--color-on-primary);
  }
  .done .number {
    background: var(--color-success-bg);
    border-color: var(--color-success);
    color: var(--color-success-text);
  }
</style>
