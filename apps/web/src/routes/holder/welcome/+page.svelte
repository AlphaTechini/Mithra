<script lang="ts">
  /**
   * Holder onboarding (userflow 6 steps 3 and 4): accept each pending tranche of units, turn on
   * auto-receive, then go to the home screen. State comes from the HolderPosition the server
   * returns after every action, so a step only completes once the ledger has confirmed it.
   */
  import type { HolderPosition } from '@mithra/shared';
  import { onMount } from 'svelte';
  import { acceptUnits, fetchPosition } from '$lib/api/holder';
  import Button from '$lib/components/Button.svelte';
  import ErrorState from '$lib/components/ErrorState.svelte';
  import AutoReceiveControl from '$lib/components/holder/AutoReceiveControl.svelte';
  import ConnectWallet from '$lib/components/holder/ConnectWallet.svelte';
  import PrivacyNote from '$lib/components/holder/PrivacyNote.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import PartyId from '$lib/components/PartyId.svelte';
  import PendingNotice from '$lib/components/PendingNotice.svelte';
  import Skeleton from '$lib/components/Skeleton.svelte';
  import { describeError } from '$lib/errors';
  import { formatShortDate } from '$lib/format';
  import { sessionStore } from '$lib/stores/session.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';

  let position = $state<HolderPosition | null>(null);
  let loadError = $state<unknown>(null);
  let retrying = $state(false);
  let acceptingId = $state<string | null>(null);
  let actionError = $state<string | null>(null);

  async function load(): Promise<void> {
    try {
      position = await fetchPosition();
      loadError = null;
    } catch (e) {
      loadError = e;
    }
  }

  function setPosition(next: HolderPosition): void {
    position = next;
  }

  async function retry(): Promise<void> {
    retrying = true;
    try {
      await load();
    } finally {
      retrying = false;
    }
  }

  onMount(() => {
    void load();
  });

  async function accept(unitId: string): Promise<void> {
    if (acceptingId !== null) return;
    acceptingId = unitId;
    actionError = null;
    try {
      position = await acceptUnits(unitId);
      toasts.push('Units accepted');
    } catch (e) {
      const copy = describeError(e, "Couldn't accept the units.");
      actionError = `${copy.title} ${copy.message}`;
    } finally {
      acceptingId = null;
    }
  }

  /** MainNet payouts: the holder connects Grofty Wallet before turning on auto-receive in it. */
  const groftyRail = $derived(sessionStore.config?.payoutRail === 'grofty-mainnet');

  const failure = $derived(
    loadError ? describeError(loadError, "Couldn't load your invitation.") : null,
  );
</script>

<svelte:head>
  <title>Welcome · Mithra</title>
</svelte:head>

{#if position === null && failure}
  <PageHeader title="Welcome" />
  <ErrorState title={failure.title} message={failure.message} onretry={retry} {retrying} />
{:else if position === null}
  <PageHeader title="Welcome" />
  <Skeleton shape="block" height="8rem" label="Loading your invitation" />
{:else}
  {@const current = position}
  {@const unitsDone = current.pendingUnits.length === 0}
  <PageHeader
    title="Welcome to {current.orgName}"
    description="Accept your units, then turn on auto-receive so payments reach you in one step."
  />

  <section aria-labelledby="units-heading">
    <h2 id="units-heading">Your units</h2>
    {#if actionError}
      <p class="error" role="alert"><Icon name="alert" size={16} /><span>{actionError}</span></p>
    {/if}
    {#if !unitsDone}
      <ul class="tranches">
        {#each current.pendingUnits as tranche (tranche.unitId)}
          <li>
            <span class="what">
              <strong>{tranche.units.toLocaleString('en-US')} units</strong>
              <span class="when">effective {formatShortDate(tranche.effectiveDate)}</span>
            </span>
            <Button
              busy={acceptingId === tranche.unitId}
              disabled={acceptingId !== null}
              aria-label="Accept units, {tranche.units.toLocaleString(
                'en-US',
              )} units effective {formatShortDate(tranche.effectiveDate)}"
              onclick={() => accept(tranche.unitId)}>Accept units</Button
            >
          </li>
        {/each}
      </ul>
      {#if acceptingId !== null}<PendingNotice message="Waiting for the ledger to confirm…" />{/if}
    {:else if current.units > 0}
      <p class="done">
        <Icon name="check-circle" size={18} />
        <span>You hold {current.units.toLocaleString('en-US')} units.</span>
      </p>
    {:else}
      <p>You have no units to accept yet. The fund will send them to you.</p>
    {/if}
  </section>

  {#if unitsDone && current.units > 0 && groftyRail}
    <section aria-labelledby="wallet-heading">
      <h2 id="wallet-heading">Grofty Wallet</h2>
      {#if current.mainnetWallet}
        <p class="done" role="status">
          <Icon name="check-circle" size={18} />
          <span>Grofty Wallet connected</span>
        </p>
        <p class="party">Payouts are sent to <PartyId partyId={current.mainnetWallet.partyId} /></p>
      {:else}
        <p>
          Connect Grofty Wallet so Mithra knows where to send your yield. You sign one message to
          prove the wallet is yours.
        </p>
        <ConnectWallet onchange={setPosition} />
      {/if}
    </section>
  {/if}

  {#if unitsDone && current.units > 0 && (!groftyRail || current.mainnetWallet)}
    <section aria-labelledby="auto-heading">
      <h2 id="auto-heading">Auto-receive</h2>
      {#if current.autoReceive === true}
        <p class="done" role="status">
          <Icon name="check-circle" size={18} />
          <span>Auto-receive is on</span>
        </p>
      {:else}
        <p>Turn on auto-receive so yield arrives without you having to accept each payment.</p>
        <AutoReceiveControl onchange={setPosition} />
      {/if}
    </section>

    <p class="next">
      <Button href="/holder" variant={current.autoReceive === true ? 'primary' : 'secondary'}
        >Go to my home</Button
      >
    </p>
  {/if}

  <PrivacyNote />
{/if}

<style>
  section {
    margin-bottom: var(--space-6);
  }
  .tranches {
    display: grid;
    gap: var(--space-3);
    margin: 0 0 var(--space-3);
    padding: 0;
    list-style: none;
  }
  .tranches li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-4);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
  }
  .what {
    display: grid;
  }
  .when {
    color: var(--color-text-muted);
    font-size: var(--text-13);
  }
  .done {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--color-success-text);
    font-weight: 600;
  }
  .error {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    margin: 0 0 var(--space-3);
    color: var(--color-danger-text);
  }
  .party {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }
  .next {
    margin: 0;
  }
</style>
