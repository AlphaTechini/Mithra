<script lang="ts">
  /**
   * Who is signed in, with the LocalNet role switcher and Sign out. Used in the header of every
   * signed-in layout. `actions` adds layout-specific buttons (for example "Ask the agent").
   */
  import type { Snippet } from 'svelte';
  import { describeError } from '$lib/errors';
  import { navigate } from '$lib/nav';
  import { sessionStore } from '$lib/stores/session.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import Button from './Button.svelte';
  import PartyId from './PartyId.svelte';
  import RoleSwitcher from './RoleSwitcher.svelte';

  let { actions }: { actions?: Snippet } = $props();

  let signingOut = $state(false);

  async function signOut(): Promise<void> {
    signingOut = true;
    try {
      await sessionStore.signOut();
      await navigate('/launch');
    } catch (e) {
      const copy = describeError(e, "Couldn't sign you out.");
      toasts.push(`${copy.title} ${copy.message}`, 'error', 0);
    } finally {
      signingOut = false;
    }
  }
</script>

<div class="bar">
  <div class="who">
    {#if sessionStore.party}
      <span class="name">{sessionStore.party.displayName}</span>
      <PartyId partyId={sessionStore.party.partyId} />
    {/if}
  </div>
  <div class="controls">
    {#if sessionStore.testMode}<RoleSwitcher compact />{/if}
    {@render actions?.()}
    <Button variant="quiet" busy={signingOut} onclick={signOut}>Sign out</Button>
  </div>
</div>

<style>
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3) var(--space-5);
  }
  .who {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1) var(--space-3);
    min-width: 0;
  }
  .name {
    font-weight: 600;
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
  }
</style>
