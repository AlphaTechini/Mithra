<script lang="ts">
  /**
   * "Sign payouts in Grofty" (MainNet, N4, P3, P4, P5). Mithra's records are on the LocalNet
   * ledger; on MainNet the money moves as plain CC transfers the treasurer signs here, one per
   * holder, from their Grofty Wallet. The Mandate's rules (cap, pro rata, approvals, one payout per
   * cycle) already decided on the ledger before this section exists.
   *
   * The browser submits nothing to Canton except those transfers, to the receivers and amounts the
   * server lists. A row turns "Paid" (or "Awaiting acceptance") only from the server's answer to
   * the record call, never from Grofty's reply alone (P4). Before any signature the wallet's
   * balance is checked against the amount still to send plus the fee buffer (P5).
   */
  import { onMount, untrack } from 'svelte';
  import {
    formatDecimal,
    sumDecimals,
    toDecimal,
    type MainnetPayout,
    type MainnetPayoutsResponse,
    type MainnetTransferOutcome,
  } from '@mithra/shared';
  import { fetchMainnetPayouts, recordMainnetPayout } from '$lib/api/mainnet';
  import Amount from '$lib/components/Amount.svelte';
  import AppLink from '$lib/components/AppLink.svelte';
  import Button from '$lib/components/Button.svelte';
  import ErrorState from '$lib/components/ErrorState.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import PartyId from '$lib/components/PartyId.svelte';
  import PendingNotice from '$lib/components/PendingNotice.svelte';
  import Skeleton from '$lib/components/Skeleton.svelte';
  import StatusChip from '$lib/components/StatusChip.svelte';
  import { describeError } from '$lib/errors';
  import { sessionStore } from '$lib/stores/session.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import * as grofty from '$lib/wallet/grofty';

  interface Props {
    cycleId: string;
    /** Called after the server recorded a payout, so the page reloads the cycle. */
    onchange?: () => void;
  }

  let { cycleId, onchange }: Props = $props();

  type Wallet = 'looking' | 'missing' | 'ready' | 'connected';
  type Row =
    | { kind: 'idle' }
    | { kind: 'signing' }
    | { kind: 'recording' }
    | { kind: 'error'; message: string; helpUrl: string | null }
    /** Grofty sent it, the server has not recorded it yet: do not send again, record it. */
    | { kind: 'unrecorded'; updateId: string; outcome: MainnetTransferOutcome; message: string };

  let payouts = $state<MainnetPayoutsResponse | null>(null);
  let loadError = $state<unknown>(null);
  let retrying = $state(false);
  let wallet = $state<Wallet>('looking');
  let connecting = $state(false);
  let walletError = $state<grofty.GroftyWalletError | null>(null);
  let walletBalance = $state<string | null | undefined>(undefined);
  let checkingBalance = $state(false);
  let rows = $state<Record<string, Row>>({});

  const symbol = $derived(sessionStore.config?.assetSymbol ?? 'CC');
  const busyId = $derived(
    Object.entries(rows).find(([, r]) => r.kind === 'signing' || r.kind === 'recording')?.[0] ??
      null,
  );

  /** The amount still to send, plus the fee buffer (P5). The server's own figures, added here. */
  const required = $derived.by((): { toSend: string; needed: string } | null => {
    if (!payouts) return null;
    const toSend = sumDecimals(
      payouts.payouts.filter((p) => p.status === 'to-sign').map((p) => p.amount),
    );
    return { toSend, needed: formatDecimal(toDecimal(toSend).plus(toDecimal(payouts.feeBuffer))) };
  });
  const tooLow = $derived(
    required !== null &&
      typeof walletBalance === 'string' &&
      toDecimal(walletBalance).lt(toDecimal(required.needed)),
  );
  const canSign = $derived(wallet === 'connected' && !tooLow);

  // A transfer that Grofty executed but the server has not recorded yet is remembered, so a
  // reload offers to record it again instead of paying twice. Browser storage is a convenience only.
  const storageKey = (): string => `mithra.unrecorded.${untrack(() => cycleId)}`;
  function remembered(): Record<string, { updateId: string; outcome: MainnetTransferOutcome }> {
    try {
      return JSON.parse(window.localStorage.getItem(storageKey()) ?? '{}') as Record<
        string,
        { updateId: string; outcome: MainnetTransferOutcome }
      >;
    } catch {
      return {};
    }
  }
  function remember(
    paymentId: string,
    value: { updateId: string; outcome: MainnetTransferOutcome } | null,
  ): void {
    try {
      const all = remembered();
      if (value) all[paymentId] = value;
      else delete all[paymentId];
      window.localStorage.setItem(storageKey(), JSON.stringify(all));
    } catch {
      // Without storage the page still works; it just cannot remember across a reload.
    }
  }

  async function load(): Promise<void> {
    try {
      payouts = await fetchMainnetPayouts(cycleId);
      loadError = null;
      const saved = remembered();
      for (const p of payouts.payouts) {
        const note = saved[p.paymentId];
        if (p.status === 'to-sign' && note && rows[p.paymentId] === undefined) {
          rows[p.paymentId] = {
            kind: 'unrecorded',
            ...note,
            message:
              'Grofty sent this transfer, but Mithra has not recorded it yet. Record it; do not send it again.',
          };
        }
      }
    } catch (e) {
      loadError = e;
    }
  }

  async function retry(): Promise<void> {
    retrying = true;
    await load();
    retrying = false;
  }

  async function connect(): Promise<void> {
    connecting = true;
    walletError = null;
    try {
      await grofty.connect();
      wallet = 'connected';
      await checkBalance();
    } catch (e) {
      walletError = grofty.describeGroftyError(e);
      if (walletError.kind === 'not-installed') wallet = 'missing';
    } finally {
      connecting = false;
    }
  }

  async function checkBalance(): Promise<void> {
    checkingBalance = true;
    try {
      walletBalance = await grofty.balance(symbol);
    } catch (e) {
      walletBalance = null;
      walletError = grofty.describeGroftyError(e);
    } finally {
      checkingBalance = false;
    }
  }

  onMount(() => {
    void load();
    void grofty.detect().then(async (found) => {
      if (!found) {
        wallet = 'missing';
        return;
      }
      wallet = 'ready';
      // Already connected to this site? Then there is nothing to ask the person.
      try {
        if (await grofty.account()) {
          wallet = 'connected';
          await checkBalance();
        }
      } catch {
        // Not connected yet: the person connects with the button.
      }
    });
  });

  async function record(
    payout: MainnetPayout,
    value: { updateId: string; outcome: MainnetTransferOutcome },
  ): Promise<void> {
    rows[payout.paymentId] = { kind: 'recording' };
    try {
      payouts = await recordMainnetPayout(cycleId, payout.paymentId, value);
      remember(payout.paymentId, null);
      rows[payout.paymentId] = { kind: 'idle' };
      toasts.push(`Recorded the payment to ${payout.holder.displayName}`);
      onchange?.();
      void checkBalance();
    } catch (e) {
      remember(payout.paymentId, value);
      const copy = describeError(e, "Couldn't record the payment.");
      rows[payout.paymentId] = {
        kind: 'unrecorded',
        ...value,
        message: `Grofty sent this transfer, but Mithra could not record it. ${copy.message} Record it again; do not send it again.`,
      };
    }
  }

  async function pay(payout: MainnetPayout): Promise<void> {
    if (!canSign || busyId !== null) return;
    rows[payout.paymentId] = { kind: 'signing' };
    let sent: grofty.GroftyTransfer;
    try {
      sent = await grofty.transfer({
        receiver: payout.receiver,
        amount: payout.amount,
        memo: payout.memo,
      });
    } catch (e) {
      const error = grofty.describeGroftyError(e);
      rows[payout.paymentId] = { kind: 'error', message: error.message, helpUrl: error.helpUrl };
      return;
    }
    const outcome = await grofty.transferOutcome(sent.updateId, payout.receiver);
    await record(payout, { updateId: sent.updateId, outcome });
  }

  /** The holder accepted the offer in Grofty: record the same transfer as completed. */
  async function markAccepted(payout: MainnetPayout): Promise<void> {
    if (busyId !== null || !payout.link) return;
    await record(payout, { updateId: payout.link.updateId, outcome: 'completed' });
  }

  const open = $derived(payouts?.payouts.filter((p) => p.status !== 'paid').length ?? 0);
</script>

<section class="sign" aria-labelledby="sign-title">
  <h2 id="sign-title">Sign payouts in Grofty</h2>

  {#if loadError && !payouts}
    {@const copy = describeError(loadError, "Couldn't load the payouts to sign.")}
    <ErrorState title={copy.title} message={copy.message} onretry={retry} {retrying} />
  {:else if !payouts}
    <Skeleton shape="block" height="8rem" label="Loading the payouts to sign" />
  {:else}
    <p class="intro">
      The ledger has checked the Mandate rules. Real {symbol} moves on Canton MainNet when you approve
      each transfer in Grofty Wallet. Each approval expires after 3 minutes.
    </p>

    <div class="wallet" role="group" aria-label="Grofty Wallet">
      {#if wallet === 'looking'}
        <PendingNotice message="Looking for Grofty Wallet…" />
      {:else if wallet === 'missing'}
        <p class="problem" role="alert">
          <Icon name="alert" size={18} />
          <span>
            Install Grofty Wallet to pay on MainNet.
            <a href={grofty.GROFTY_URL} target="_blank" rel="external noopener noreferrer"
              >Get Grofty Wallet</a
            >
          </span>
        </p>
      {:else if wallet === 'ready'}
        <Button busy={connecting} onclick={connect}>Connect Grofty Wallet</Button>
      {:else}
        <p class="connected">
          <Icon name="check-circle" size={18} /> <span>Grofty Wallet connected</span>
        </p>
      {/if}
      {#if walletError && wallet !== 'missing'}
        <p class="problem" role="alert">
          <Icon name="alert" size={18} />
          <span>
            {walletError.message}
            {#if walletError.helpUrl}
              <a href={walletError.helpUrl} target="_blank" rel="external noopener noreferrer"
                >Get Grofty Wallet</a
              >
            {/if}
          </span>
        </p>
      {/if}
    </div>

    {#if tooLow && required && typeof walletBalance === 'string'}
      <div class="funds" role="alert">
        <Icon name="wallet" size={20} />
        <div>
          <p class="funds-title"><strong>Add funds</strong></p>
          <p>
            Your Grofty balance is <Amount value={walletBalance} />, and these payouts need
            <Amount value={required.needed} />
            (<Amount value={required.toSend} /> plus a <Amount value={payouts.feeBuffer} /> fee buffer).
            Send {symbol} to your Grofty Wallet, then check again.
          </p>
          <Button variant="secondary" small busy={checkingBalance} onclick={checkBalance}
            >Check balance again</Button
          >
        </div>
      </div>
    {:else if wallet === 'connected' && walletBalance === null}
      <p class="muted" role="status">
        Grofty did not report a balance Mithra could read. Make sure your wallet holds
        {#if required}<Amount value={required.needed} />{/if} before you sign.
      </p>
    {/if}

    <ul class="rows" aria-label="Payouts to sign">
      {#each payouts.payouts as payout (payout.paymentId)}
        {@const row = rows[payout.paymentId] ?? { kind: 'idle' }}
        <li>
          <div class="who">
            <strong>{payout.holder.displayName}</strong>
            <span class="muted receiver">to <PartyId partyId={payout.receiver} /></span>
          </div>
          <div class="amount"><Amount value={payout.amount} /></div>
          <div class="state">
            {#if payout.status === 'paid'}
              <StatusChip kind="paid" />
              {#if payout.link}<AppLink link={payout.link.href}>View on explorer</AppLink>{/if}
            {:else if payout.status === 'awaiting-acceptance'}
              <StatusChip kind="awaiting-acceptance" />
              {#if payout.link}<AppLink link={payout.link.href}>View on explorer</AppLink>{/if}
              {#if row.kind === 'recording'}
                <PendingNotice message="Waiting for Mithra to record it…" />
              {:else}
                <Button
                  variant="secondary"
                  small
                  disabled={busyId !== null}
                  onclick={() => markAccepted(payout)}>Mark as accepted</Button
                >
              {/if}
            {:else if row.kind === 'signing'}
              <StatusChip kind="pending" />
              <PendingNotice message="Approve the transfer in Grofty Wallet…" />
            {:else if row.kind === 'recording'}
              <StatusChip kind="pending" />
              <PendingNotice message="Grofty sent it. Waiting for Mithra to record it…" />
            {:else if row.kind === 'unrecorded'}
              <p class="problem" role="alert">
                <Icon name="alert" size={16} /><span>{row.message}</span>
              </p>
              <Button
                small
                disabled={busyId !== null}
                onclick={() => record(payout, { updateId: row.updateId, outcome: row.outcome })}
                >Record payment</Button
              >
            {:else}
              <Button
                small
                disabled={!canSign || busyId !== null}
                aria-label="Pay {payout.holder.displayName} in Grofty"
                onclick={() => pay(payout)}>Pay in Grofty</Button
              >
              {#if row.kind === 'error'}
                <p class="problem" role="alert">
                  <Icon name="alert" size={16} />
                  <span>
                    {row.message}
                    {#if row.helpUrl}<a
                        href={row.helpUrl}
                        target="_blank"
                        rel="external noopener noreferrer">Get Grofty Wallet</a
                      >{/if}
                  </span>
                </p>
              {/if}
            {/if}
          </div>
        </li>
      {/each}
    </ul>

    {#if open === 0}
      <p class="done" role="status">
        <Icon name="check-circle" size={18} /> Every payout is recorded.
      </p>
    {:else if !canSign && wallet !== 'missing'}
      <p class="muted">Connect Grofty Wallet and make sure it holds enough {symbol} to sign.</p>
    {/if}
  {/if}
</section>

<style>
  .sign {
    margin-bottom: var(--space-6);
    padding: var(--space-5);
    background: var(--color-surface);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-lg);
  }
  h2 {
    margin-top: 0;
    font-size: var(--text-24);
  }
  .intro {
    margin-top: 0;
    color: var(--color-text-muted);
  }
  .wallet {
    display: grid;
    justify-items: start;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
  }
  .connected {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    color: var(--color-success-text);
    font-weight: 600;
  }
  .problem {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    margin: 0;
    color: var(--color-danger-text);
  }
  .funds {
    display: flex;
    gap: var(--space-3);
    padding: var(--space-4);
    margin-bottom: var(--space-4);
    background: var(--color-danger-bg);
    color: var(--color-danger-text);
    border: 1px solid var(--color-danger);
    border-radius: var(--radius-md);
  }
  .funds p {
    margin: 0 0 var(--space-2);
  }
  .rows {
    display: grid;
    gap: var(--space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .rows li {
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) auto minmax(0, 2fr);
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }
  .who {
    display: grid;
  }
  .receiver {
    font-size: var(--text-13);
  }
  .state {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }
  .muted {
    color: var(--color-text-muted);
  }
  .done {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--color-success-text);
    font-weight: 600;
  }
  @media (max-width: 40rem) {
    .rows li {
      grid-template-columns: 1fr;
    }
  }
</style>
