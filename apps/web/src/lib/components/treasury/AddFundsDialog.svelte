<script lang="ts">
  /**
   * "Add funds". LocalNet (test mode): a small form that mints CC into the treasury through the
   * backend. MainNet: nothing to submit; it says how to send CC to the treasury party. The
   * suggested amount is the server's required figure, not a browser calculation.
   */
  import { onMount, untrack } from 'svelte';
  import { DecimalString } from '@mithra/shared';
  import { fundTreasury, getOrg } from '$lib/api/treasury';
  import { describeError } from '$lib/errors';
  import { sessionStore } from '$lib/stores/session.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import Button from '../Button.svelte';
  import Dialog from '../Dialog.svelte';
  import ErrorState from '../ErrorState.svelte';
  import Field from '../Field.svelte';
  import PartyId from '../PartyId.svelte';

  interface Props {
    /** The server's required amount for the next distribution, used as the suggestion. */
    required: string;
    onclose: () => void;
    /** Called after funds were added, so the page reloads its balance. */
    ondone: () => void;
  }

  let { required, onclose, ondone }: Props = $props();

  const symbol = $derived(sessionStore.config?.assetSymbol ?? 'CC');
  const testMode = $derived(sessionStore.testMode === true);

  // The suggestion is captured once; the dialog is short-lived and the field is editable.
  let amount = $state(untrack(() => required));
  let busy = $state(false);
  let failure = $state<{ title: string; message: string } | null>(null);
  let treasuryParty = $state<string | null>(null);

  const amountError = $derived(
    DecimalString.safeParse(amount.trim()).success && /[1-9]/.test(amount)
      ? null
      : 'Enter an amount above zero, like 500 or 1200.50.',
  );

  onMount(() => {
    if (testMode) return;
    void getOrg()
      .then((org) => {
        treasuryParty = org.organization?.treasury.partyId ?? null;
      })
      .catch(() => {
        treasuryParty = null;
      });
  });

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
    <p>
      To add funds on MainNet, send {symbol} from your own wallet to the treasury party. The balance updates
      once the ledger confirms the transfer.
    </p>
    {#if treasuryParty}
      <p class="party"><span>Treasury party</span> <PartyId partyId={treasuryParty} /></p>
    {/if}
  {/if}
  {#snippet footer()}
    <Button variant="secondary" onclick={onclose}>{testMode ? 'Cancel' : 'Close'}</Button>
    {#if testMode}
      <Button {busy} disabled={!!amountError} onclick={() => submit()}>Add funds</Button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .party {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }
</style>
