<script lang="ts">
  /**
   * "Issue units": pick a holder (an existing one, a LocalNet demo party, or any party id),
   * enter the number of units and the effective date, confirm. The ledger records it; the holder
   * then accepts the units on their own screen.
   */
  import { onMount } from 'svelte';
  import type { DemoParty, HolderRow } from '@mithra/shared';
  import { getDemoParties, issueUnits } from '$lib/api/treasury';
  import { describeError } from '$lib/errors';
  import { todayIso } from '$lib/format';
  import { sessionStore } from '$lib/stores/session.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import Button from '../Button.svelte';
  import Dialog from '../Dialog.svelte';
  import ErrorState from '../ErrorState.svelte';
  import Field from '../Field.svelte';

  interface Props {
    holders: readonly HolderRow[];
    onclose: () => void;
    ondone: () => void;
    oninvite: () => void;
  }

  let { holders, onclose, ondone, oninvite }: Props = $props();

  const OTHER = '__other__';
  const PARTY_ID = /^[^\s:]+::[0-9a-fA-F]+$/;

  let demo = $state<DemoParty[]>([]);
  let choice = $state('');
  let otherId = $state('');
  let units = $state('');
  let effectiveDate = $state(todayIso());
  let busy = $state(false);
  let submitted = $state(false);
  let failure = $state<{ title: string; message: string } | null>(null);

  // LocalNet: every demo party that is not the treasurer or an approver and not a holder already.
  // On a fresh setup no demo party has a role yet, and they are the ones to issue the first units to.
  const demoParties = $derived(
    demo.filter(
      (p) =>
        !p.roles.includes('treasurer') &&
        !p.roles.includes('approver') &&
        !holders.some((h) => h.holder.partyId === p.partyId),
    ),
  );
  const partyId = $derived(choice === OTHER ? otherId.trim() : choice);

  const holderError = $derived(
    partyId === ''
      ? 'Choose a holder, or enter a party id.'
      : choice === OTHER && !PARTY_ID.test(partyId)
        ? 'This is not a party id. It looks like name::1220abc…'
        : null,
  );
  const unitsError = $derived(
    /^[1-9]\d{0,9}$/.test(units.trim()) ? null : 'Enter a whole number of units, like 1000.',
  );
  const dateError = $derived(
    effectiveDate !== '' && effectiveDate > todayIso()
      ? 'The effective date cannot be in the future.'
      : null,
  );
  const valid = $derived(!holderError && !unitsError && !dateError);

  onMount(() => {
    if (sessionStore.testMode) {
      void getDemoParties()
        .then((parties) => (demo = parties))
        .catch(() => (demo = []));
    }
  });

  async function submit(event?: Event): Promise<void> {
    event?.preventDefault();
    submitted = true;
    if (!valid || busy) return;
    busy = true;
    failure = null;
    try {
      await issueUnits({
        holder: partyId,
        units: Number(units.trim()),
        ...(effectiveDate ? { effectiveDate } : {}),
      });
      toasts.push('Units issued');
      ondone();
      onclose();
    } catch (e) {
      failure = describeError(e, "Couldn't issue the units.");
    } finally {
      busy = false;
    }
  }
</script>

<Dialog title="Issue units" {onclose} initialFocus="select">
  <form onsubmit={submit}>
    <Field label="Holder" error={submitted ? holderError : null}>
      {#snippet control(attrs)}
        <select {...attrs} bind:value={choice}>
          <option value="" disabled>Choose a holder</option>
          {#if holders.length > 0}
            <optgroup label="Current holders">
              {#each holders as row (row.holder.partyId)}
                <option value={row.holder.partyId}>{row.holder.displayName}</option>
              {/each}
            </optgroup>
          {/if}
          {#if demoParties.length > 0}
            <optgroup label="Demo parties">
              {#each demoParties as party (party.partyId)}
                <option value={party.partyId}>{party.displayName}</option>
              {/each}
            </optgroup>
          {/if}
          <option value={OTHER}>Another party id…</option>
        </select>
      {/snippet}
    </Field>
    {#if choice === OTHER}
      <Field label="Holder party id" error={submitted ? holderError : null}>
        {#snippet control(attrs)}
          <input
            {...attrs}
            bind:value={otherId}
            autocomplete="off"
            spellcheck="false"
            placeholder="name::1220abc…"
          />
        {/snippet}
      </Field>
    {/if}
    <p class="invite">
      The holder is not here yet?
      <Button variant="quiet" small onclick={oninvite}>Invite a holder</Button>
    </p>
    <Field label="Units" error={submitted ? unitsError : null} short>
      {#snippet control(attrs)}
        <input {...attrs} bind:value={units} inputmode="numeric" autocomplete="off" />
      {/snippet}
    </Field>
    <Field label="Effective date" error={dateError} hint="Defaults to today." short>
      {#snippet control(attrs)}
        <input {...attrs} type="date" bind:value={effectiveDate} max={todayIso()} />
      {/snippet}
    </Field>
    {#if failure}<ErrorState title={failure.title} message={failure.message} />{/if}
    <button type="submit" class="sr-only" tabindex="-1" aria-hidden="true">Issue units</button>
  </form>
  {#snippet footer()}
    <Button variant="secondary" onclick={onclose}>Cancel</Button>
    <Button {busy} onclick={() => submit()}>Issue units</Button>
  {/snippet}
</Dialog>

<style>
  .invite {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1);
    margin: calc(-1 * var(--space-2)) 0 var(--space-3);
    color: var(--color-text-muted);
    font-size: var(--text-13);
  }
</style>
