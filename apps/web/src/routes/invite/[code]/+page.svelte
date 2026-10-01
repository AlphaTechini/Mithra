<script lang="ts">
  /** Shell for holder and auditor onboarding. The invitation details are added later. */
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
</script>

<svelte:head>
  <title>Invitation · Mithra</title>
</svelte:head>

<main id="main" tabindex="-1">
  <a class="brand" href={resolve('/')}>Mithra</a>
  <PageHeader title="You were invited" description={`Invite code ${page.params['code'] ?? ''}`} />
  <EmptyState
    message="The fund's name and what it offers you appear here once you sign in. Sign in to continue with this invitation."
    actionLabel="Launch app"
    actionHref="/launch"
  />
</main>

<style>
  main {
    max-width: 36rem;
    margin: 0 auto;
    padding: var(--space-6) var(--space-4) var(--space-7);
  }
  .brand {
    display: inline-block;
    margin-bottom: var(--space-5);
    font-family: var(--font-serif);
    font-size: var(--text-24);
    color: var(--color-text);
    text-decoration: none;
  }
</style>
