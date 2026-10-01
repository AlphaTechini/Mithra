<script lang="ts">
  /**
   * Wraps a layout that needs a signed-in party. Shows skeletons while the session loads, an
   * ErrorState when the backend cannot be reached, and redirects when the visitor is signed out
   * or has the wrong role (see redirectFor). Only renders its children when the visitor may stay.
   */
  import type { Role } from '@mithra/shared';
  import type { Snippet } from 'svelte';
  import { describeError } from '$lib/errors';
  import { navigate } from '$lib/nav';
  import { redirectFor } from '$lib/routing';
  import { sessionStore } from '$lib/stores/session.svelte';
  import ErrorState from './ErrorState.svelte';
  import Skeleton from './Skeleton.svelte';

  let { allow, children }: { allow: readonly Role[] | 'any'; children: Snippet } = $props();

  const target = $derived(
    sessionStore.status === 'ready' ? redirectFor(sessionStore.session, allow) : null,
  );

  $effect(() => {
    void sessionStore.load();
  });

  $effect(() => {
    if (target) void navigate(target, { replaceState: true });
  });

  let retrying = $state(false);
  async function retry(): Promise<void> {
    retrying = true;
    await sessionStore.refresh();
    retrying = false;
  }
</script>

{#if sessionStore.status === 'error'}
  {@const copy = describeError(sessionStore.error, "Mithra couldn't load your session.")}
  <main id="main" tabindex="-1" class="gate">
    <ErrorState title={copy.title} message={copy.message} onretry={retry} {retrying} />
  </main>
{:else if sessionStore.status !== 'ready' || target}
  <main id="main" tabindex="-1" class="gate">
    <Skeleton shape="block" height="8rem" label="Loading your session" />
  </main>
{:else}
  {@render children()}
{/if}

<style>
  .gate {
    max-width: 40rem;
    margin: var(--space-7) auto;
    padding: 0 var(--space-4);
  }
</style>
