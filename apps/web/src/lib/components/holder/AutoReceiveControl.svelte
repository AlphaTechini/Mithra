<script lang="ts">
  /**
   * Turns on auto-receive (a standing preapproval, so payments arrive in one step, P2).
   * LocalNet: one button calls the endpoint. MainNet: the holder turns it on inside Grofty Wallet,
   * and "Check again" calls the same endpoint to verify (the Grofty connection itself is M10).
   * Errors show the server's message in place, including `409 sign_in_wallet` on MainNet.
   */
  import type { HolderPosition } from '@mithra/shared';
  import { enableAutoReceive } from '$lib/api/holder';
  import Button from '$lib/components/Button.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import PendingNotice from '$lib/components/PendingNotice.svelte';
  import { describeError } from '$lib/errors';
  import { sessionStore } from '$lib/stores/session.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';

  interface Props {
    /** Called with the position the server returns once the request has finished. */
    onchange: (position: HolderPosition) => void;
  }

  let { onchange }: Props = $props();

  let busy = $state(false);
  let failure = $state<string | null>(null);
  let notYet = $state(false);

  const mainnet = $derived(sessionStore.network === 'mainnet');

  async function submit(): Promise<void> {
    if (busy) return;
    busy = true;
    failure = null;
    notYet = false;
    try {
      const position = await enableAutoReceive();
      if (position.autoReceive === true) {
        toasts.push('Auto-receive is on');
      } else if (mainnet) {
        notYet = true;
      }
      onchange(position);
    } catch (e) {
      const copy = describeError(e, "Couldn't turn on auto-receive.");
      failure = `${copy.title} ${copy.message}`;
    } finally {
      busy = false;
    }
  }
</script>

<div class="control">
  {#if mainnet}
    <!--
      The Grofty menu wording below is approximate: confirm the exact labels in the wallet
      (docs/research/grofty.md) before the MainNet demo.
    -->
    <ol class="steps">
      <li>Open Grofty Wallet.</li>
      <li>Open its settings.</li>
      <li>Turn on receiving CC automatically.</li>
    </ol>
    <Button variant="secondary" {busy} onclick={submit}>Check again</Button>
  {:else}
    <Button {busy} onclick={submit}>Turn on auto-receive</Button>
  {/if}
  {#if busy}<PendingNotice message="Waiting for the ledger to confirm…" />{/if}
  {#if notYet}
    <p class="info" role="status">
      <Icon name="clock" size={16} />
      <span>Auto-receive is not on yet. Turn it on in Grofty Wallet, then check again.</span>
    </p>
  {/if}
  {#if failure}
    <p class="error" role="alert"><Icon name="alert" size={16} /><span>{failure}</span></p>
  {/if}
</div>

<style>
  .control {
    display: grid;
    justify-items: start;
    gap: var(--space-3);
  }
  .steps {
    margin: 0;
  }
  .info,
  .error {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    margin: 0;
  }
  .info {
    color: var(--color-neutral-text);
  }
  .error {
    color: var(--color-danger-text);
  }
</style>
