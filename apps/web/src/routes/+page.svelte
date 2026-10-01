<script lang="ts">
  import { HealthResponseSchema, type HealthResponse } from '@mithra/shared';
  import { onMount } from 'svelte';
  import { ApiError, apiGet } from '$lib/api/client';

  let health = $state<HealthResponse | null>(null);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      health = await apiGet('/health', HealthResponseSchema);
    } catch (e) {
      error = e instanceof ApiError ? `${e.message} (${e.code})` : 'Unexpected error';
    }
  });
</script>

<svelte:head>
  <title>Mithra</title>
</svelte:head>

<main>
  <h1>Mithra</h1>
  {#if error}
    <p role="alert">Backend unavailable: {error}</p>
  {:else if health}
    <p>Network: {health.network}</p>
    <p>Backend version: {health.version}</p>
  {:else}
    <p>Loading…</p>
  {/if}
</main>

<style>
  main {
    max-width: 40rem;
    margin: 4rem auto;
    padding: 0 1rem;
    font-family: system-ui, sans-serif;
    line-height: 1.5;
  }
</style>
