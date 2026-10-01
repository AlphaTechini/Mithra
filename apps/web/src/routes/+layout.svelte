<script lang="ts">
  /**
   * Root layout: global styles, self-hosted fonts, the skip link, the persistent network badge
   * and the toast region. Loads the session and public config once.
   */
  import '@fontsource/newsreader/400.css';
  import '@fontsource/newsreader/500.css';
  import '@fontsource/newsreader/600.css';
  import '@fontsource/public-sans/400.css';
  import '@fontsource/public-sans/500.css';
  import '@fontsource/public-sans/600.css';
  import '$lib/styles/tokens.css';
  import '$lib/styles/base.css';
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import NetworkBadge from '$lib/components/NetworkBadge.svelte';
  import Toast from '$lib/components/Toast.svelte';
  import { sessionStore } from '$lib/stores/session.svelte';

  let { children }: { children: Snippet } = $props();

  onMount(() => {
    void sessionStore.load();
  });

  const showStrip = $derived(sessionStore.network !== null);
</script>

<a class="skip-link" href="#main">Skip to main content</a>

<div class="shell" style:--strip-height={showStrip ? '2rem' : '0px'}>
  {#if showStrip}
    <div class="strip"><NetworkBadge /></div>
  {/if}
  {@render children()}
</div>

<Toast />

<style>
  .skip-link {
    position: absolute;
    left: var(--space-3);
    top: -4rem;
    z-index: 100;
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-md);
    background: var(--color-primary);
    color: var(--color-on-primary);
    font-weight: 500;
  }
  .skip-link:focus {
    top: var(--space-2);
  }
  .strip {
    position: sticky;
    top: 0;
    z-index: 35;
    display: flex;
    align-items: center;
    height: var(--strip-height);
    padding: 0 var(--space-4);
    background: var(--color-bg);
    border-bottom: 1px solid var(--color-border);
  }
</style>
