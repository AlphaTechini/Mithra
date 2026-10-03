<script lang="ts">
  /**
   * "Add funds". LocalNet: a small form that mints CC into the treasury through the backend.
   * MainNet payouts: nothing to submit (no faucet); the treasurer's CC is in their Grofty Wallet,
   * which pays the holders. The suggested amount is the server's required figure, not a browser
   * calculation.
   */
  import { untrack } from 'svelte';
  import { fundTreasury } from '$lib/api/treasury';
  import { describeError } from '$lib/errors';
  import { POSITIVE_DECIMAL } from '$lib/policyForm';
  import { sessionStore } from '$lib/stores/session.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import Button from '../Button.svelte';
  import Dialog from '../Dialog.svelte';
  import ErrorState from '../ErrorState.svelte';
  import Field from '../Field.svelte';

  interface Props {
    /** The server's required amount for the next distribution, used as the suggestion. */
    required: string;
    onclose: () => void;
    /** Called after funds were added, so the page reloads its balance. */
    ondone: () => void;
  }

  let { required, onclose, ondone }: Props = $props();

  const symbol = $derived(sessionStore.config?.assetSymbol ?? 'CC');
  /** The faucet exists on the LocalNet payout rail only; MainNet payouts come from Grofty Wallet. */
  const testMode = $derived(
    sessionStore.testMode === true && sessionStore.config?.payoutRail !== 'grofty-mainnet',
  );

  // The suggestion is captured once; the dialog is short-lived and the field is editable.
  let amount = $state(untrack(() => required));
  let busy = $state(false);
  let failure = $state<{ title: string; message: string } | null>(null);

  const amountError = $derived(
    POSITIVE_DECIMAL(amount.trim()) ? null : 'Enter an amount above zero, like 500 or 1200.50.',
  );

  async function submit(event?: Event): Promise<void> {
    event?.preventDefault();
    if (amountError || busy) return;
    busy = true;
    failure = null;
    try {
      await fundTreasury(amount.trim());
      toasts.push(`Funds added: ${amount.trim()} ${symbol}`);
      ondone();
      onclose();
    } catch (e) {
      failure = describeError(e, "Couldn't add funds.");
    } finally {
      busy = false;
    }
  }
</script>

<Dialog title="Add funds" {onclose} initialFocus="input">
  {#if testMode}
    <form id="add-funds-form" onsubmit={submit}>
      <p>
        On LocalNet this mints {symbol} straight into the treasury party so you can keep testing.
      </p>
      <Field label={`Amount (${symbol})`} error={amountError} short>
        {#snippet control(attrs)}
          <input {...attrs} bind:value={amount} inputmode="decimal" autocomplete="off" />
        {/snippet}
      </Field>
      {#if failure}<ErrorState title={failure.title} message={failure.message} />{/if}
    </form>
  {:else}
    <p>Send {symbol} to your Grofty Wallet; payouts are signed from it.</p>
    <p class="muted">
      Mithra checks the balance in Grofty Wallet before you sign each payout, so there is nothing to
      add here.
    </p>
  {/if}
  {#snippet footer()}
    <Button variant="secondary" onclick={onclose}>{testMode ? 'Cancel' : 'Close'}</Button>
    {#if testMode}
      <Button {busy} disabled={!!amountError} onclick={() => submit()}>Add funds</Button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .muted {
    color: var(--color-text-muted);
  }
</style>
