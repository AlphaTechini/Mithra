<script lang="ts">
  /**
   * "Invite link": creates an invitation for a holder and shows a copyable absolute link
   * (`/invite/<code>`). On LocalNet the invite can be bound to a demo party; on MainNet the
   * invitee's wallet is bound when they open the link.
   */
  import { onMount } from 'svelte';
  import type { DemoParty, Invite } from '@mithra/shared';
  import { createInvite, getDemoParties } from '$lib/api/treasury';
  import { describeError } from '$lib/errors';
  import { absoluteUrl } from '$lib/format';
  import { sessionStore } from '$lib/stores/session.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import Button from '../Button.svelte';
  import Dialog from '../Dialog.svelte';
  import ErrorState from '../ErrorState.svelte';
  import Field from '../Field.svelte';
  import Icon from '../Icon.svelte';

  let { onclose }: { onclose: () => void } = $props();

  let demo = $state<DemoParty[]>([]);
  let displayName = $state('');
  let partyId = $state('');
  let invite = $state<Invite | null>(null);
  let busy = $state(false);
  let submitted = $state(false);
  let failure = $state<{ title: string; message: string } | null>(null);

  const testMode = $derived(sessionStore.testMode === true);
  const nameError = $derived(displayName.trim() === '' ? "Enter the holder's name." : null);
  const link = $derived(invite ? absoluteUrl(invite.path) : '');

  onMount(() => {
    if (sessionStore.testMode) {
      void getDemoParties()
        .then((parties) => (demo = parties.filter((p) => p.roles.includes('holder'))))
        .catch(() => (demo = []));
    }
  });

  function pick(id: string): void {
    partyId = id;
    const party = demo.find((p) => p.partyId === id);
    if (party && displayName.trim() === '') displayName = party.displayName;
  }

  async function create(event?: Event): Promise<void> {
    event?.preventDefault();
    submitted = true;
    if (nameError || busy) return;
    busy = true;
    failure = null;
    try {
      invite = await createInvite({
        kind: 'holder',
        displayName: displayName.trim(),
        ...(partyId ? { partyId } : {}),
      });
    } catch (e) {
      failure = describeError(e, "Couldn't create the invite link.");
    } finally {
      busy = false;
    }
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(link);
      toasts.push('Invite link copied', 'info');
    } catch {
      toasts.push('Could not copy the link. Select it and copy it by hand.', 'error', 0);
    }
  }
</script>

<Dialog title="Invite link" {onclose} initialFocus="input, select">
  {#if invite}
    <p>
      Send this link to {invite.displayName}. They open it, accept their units and turn on
      auto-receive.
    </p>
    <div class="link">
      <label class="sr-only" for="invite-link">Invite link</label>
      <input id="invite-link" readonly value={link} onfocus={(e) => e.currentTarget.select()} />
      <Button variant="secondary" onclick={copy}><Icon name="copy" size={16} /> Copy link</Button>
    </div>
  {:else}
    <form onsubmit={create}>
      {#if testMode && demo.length > 0}
        <Field
          label="Demo party"
          hint="Optional. Binds the link to one of the LocalNet demo holders."
        >
          {#snippet control(attrs)}
            <select {...attrs} value={partyId} onchange={(e) => pick(e.currentTarget.value)}>
              <option value="">Anyone with the link</option>
              {#each demo as party (party.partyId)}
                <option value={party.partyId}>{party.displayName}</option>
              {/each}
            </select>
          {/snippet}
        </Field>
      {/if}
      <Field label="Holder name" error={submitted ? nameError : null}>
        {#snippet control(attrs)}
          <input {...attrs} bind:value={displayName} maxlength="80" autocomplete="off" />
        {/snippet}
      </Field>
      {#if failure}<ErrorState title={failure.title} message={failure.message} />{/if}
      <button type="submit" class="sr-only" tabindex="-1" aria-hidden="true">Create link</button>
    </form>
  {/if}
  {#snippet footer()}
    {#if invite}
      <Button onclick={onclose}>Done</Button>
    {:else}
      <Button variant="secondary" onclick={onclose}>Cancel</Button>
      <Button {busy} onclick={() => create()}>Create link</Button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .link {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  input {
    flex: 1;
    min-width: 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-surface-sunken);
  }
</style>
