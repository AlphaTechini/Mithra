<script lang="ts">
  /**
   * Landing placeholder, built from the design system. The real landing page comes later; this
   * keeps the product statement, the Launch app button and a quiet backend health line.
   */
  import { HealthResponseSchema, type HealthResponse } from '@mithra/shared';
  import { onMount } from 'svelte';
  import { apiGet } from '$lib/api/client';
  import Button from '$lib/components/Button.svelte';
  import ErrorState from '$lib/components/ErrorState.svelte';
  import Skeleton from '$lib/components/Skeleton.svelte';
  import { describeError, type ErrorCopy } from '$lib/errors';

  let health = $state<HealthResponse | null>(null);
  let error = $state<ErrorCopy | null>(null);
  let retrying = $state(false);

  async function check(): Promise<void> {
    retrying = true;
    try {
      health = await apiGet('/health', HealthResponseSchema);
      error = null;
    } catch (e) {
      error = describeError(e, "Mithra couldn't check its server.");
    } finally {
      retrying = false;
    }
  }

  onMount(() => {
    void check();
  });
</script>

<svelte:head>
  <title>Mithra</title>
</svelte:head>

<main id="main" tabindex="-1">
  <h1>Your fund's payouts, run by an agent you can audit.</h1>
  <p class="lede">
    Mithra prepares every distribution, pays inside limits your team sets on Canton, and shows
    auditors exactly what they ask for. Nothing more.
  </p>
  <p><Button href="/launch">Launch app</Button></p>

  <section aria-labelledby="server-heading">
    <h2 id="server-heading">Server</h2>
    {#if error}
      <ErrorState title={error.title} message={error.message} onretry={check} {retrying} />
    {:else if health}
      <dl>
        <dt>Network</dt>
        <dd>{health.network === 'localnet' ? 'LocalNet' : 'MainNet'}</dd>
        <dt>Backend version</dt>
        <dd>{health.version}</dd>
      </dl>
    {:else}
      <Skeleton shape="line" lines={2} label="Checking the server" />
    {/if}
  </section>
</main>

<style>
  main {
    max-width: 44rem;
    margin: 0 auto;
    padding: var(--space-7) var(--space-4);
  }
  h1 {
    font-size: var(--text-44);
  }
  .lede {
    font-size: var(--text-18);
    color: var(--color-text-muted);
  }
  section {
    margin-top: var(--space-7);
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--space-1) var(--space-4);
    margin: 0;
  }
  dt {
    color: var(--color-text-muted);
  }
  dd {
    margin: 0;
  }
  @media (max-width: 600px) {
    h1 {
      font-size: var(--text-32);
    }
  }
</style>
