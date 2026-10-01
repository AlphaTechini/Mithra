<script lang="ts">
  /**
   * Holder home (userflow 6 step 5): units, share, total yield received, next payment date and the
   * payment history with transaction links. Renders only fields of the HolderPosition the server
   * returns for the signed-in holder (U7). Amounts come from the API; nothing is computed here.
   */
  import type { HolderPosition } from '@mithra/shared';
  import { onMount } from 'svelte';
  import { acceptPayment, fetchPosition } from '$lib/api/holder';
  import Button from '$lib/components/Button.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import ErrorState from '$lib/components/ErrorState.svelte';
  import AutoReceiveControl from '$lib/components/holder/AutoReceiveControl.svelte';
  import PaymentsTable from '$lib/components/holder/PaymentsTable.svelte';
  import PositionSummary from '$lib/components/holder/PositionSummary.svelte';
  import PrivacyNote from '$lib/components/holder/PrivacyNote.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import PendingNotice from '$lib/components/PendingNotice.svelte';
  import Skeleton from '$lib/components/Skeleton.svelte';
  import { describeError } from '$lib/errors';
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
    await load();
    retrying = false;
  }

  onMount(() => {
    void load();
  });

  async function accept(paymentId: string): Promise<void> {
    if (acceptingId !== null) return;
    acceptingId = paymentId;
    actionError = null;
    try {
      position = await acceptPayment(paymentId);
      toasts.push('Payment accepted');
    } catch (e) {
      const copy = describeError(e, "Couldn't accept the payment.");
      actionError = `${copy.title} ${copy.message}`;
    } finally {
      acceptingId = null;
    }
  }

  const failure = $derived(
    loadError ? describeError(loadError, "Couldn't load your position.") : null,
  );
</script>

<svelte:head>
  <title>Your position · Mithra</title>
</svelte:head>

{#if position === null && failure}
  <PageHeader title="Your position" />
  <ErrorState title={failure.title} message={failure.message} onretry={retry} {retrying} />
{:else if position === null}
  <PageHeader title="Your position" />
  <Skeleton shape="block" height="9rem" label="Loading your position" />
  <Skeleton shape="table" rows={3} label="Loading your payments" />
{:else}
  {@const current = position}
  <PageHeader
    title="Your position"
    description="Your {current.orgName} units and the yield paid to you."
  />

  {#if current.pendingUnits.length > 0}
    <div class="banner" role="region" aria-label="Units waiting for you">
      <p>
        <Icon name="mail" size={16} />
        You have units waiting to accept.
      </p>
      <Button href="/holder/welcome">Accept units</Button>
    </div>
  {/if}

  {#if current.autoReceive === false}
    <div class="banner" role="region" aria-label="Auto-receive is off">
      <p>
        <Icon name="alert" size={16} />
        Auto-receive is off. Payments to you wait until you accept each one.
      </p>
      <AutoReceiveControl onchange={setPosition} />
    </div>
  {:else if current.autoReceive === null}
    <p class="unknown" role="status">
      <Icon name="clock" size={16} />
      <span>We can't check your auto-receive setting right now. Reload to try again.</span>
    </p>
  {/if}

  <section id="units" aria-labelledby="units-heading">
    <h2 id="units-heading">Units</h2>
    {#if current.units === 0 && current.pendingUnits.length === 0}
      <EmptyState
        message="You don't hold any units yet. Open the invite link from the fund to accept units."
      />
    {:else}
      <PositionSummary position={current} />
    {/if}
  </section>

  <section id="payments" aria-labelledby="payments-heading">
    <h2 id="payments-heading">Payments</h2>
    {#if actionError}
      <p class="error" role="alert"><Icon name="alert" size={16} /><span>{actionError}</span></p>
    {/if}
    {#if acceptingId !== null}<PendingNotice message="Waiting for the ledger to confirm…" />{/if}
    {#if current.payments.length === 0}
      <EmptyState message="No payments yet. Your first yield payment will appear here." />
    {:else}
      <PaymentsTable
        payments={current.payments}
        assetSymbol={current.assetSymbol}
        {acceptingId}
        onaccept={accept}
      />
    {/if}
  </section>

  <PrivacyNote />
{/if}

<style>
  section {
    margin-bottom: var(--space-6);
    scroll-margin-top: var(--space-6);
  }
  .banner {
    display: grid;
    justify-items: start;
    gap: var(--space-3);
    margin-bottom: var(--space-5);
    padding: var(--space-4);
    background: var(--color-info-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
  }
  .banner p {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    margin: 0;
    color: var(--color-info-text);
    font-weight: 500;
  }
  .unknown,
  .error {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    margin: 0 0 var(--space-3);
  }
  .unknown {
    color: var(--color-neutral-text);
  }
  .error {
    color: var(--color-danger-text);
  }
</style>
