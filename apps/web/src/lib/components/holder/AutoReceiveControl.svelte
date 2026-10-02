<script lang="ts">
  /**
   * Turns on auto-receive (a standing preapproval, so payments arrive in one step, P2).
   * LocalNet: one button calls the endpoint. MainNet (N5): the holder turns it on inside Grofty
   * Wallet, following the numbered steps, and "Check again" calls the same endpoint to verify it.
   * Errors show the server's message in place.
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
  let unknown = $state(false);

  const mainnet = $derived(sessionStore.network === 'mainnet');

  async function submit(): Promise<void> {
    if (busy) return;
    busy = true;
    failure = null;
    notYet = false;
    unknown = false;
    try {
      const position = await enableAutoReceive();
      if (position.autoReceive === true) {
        toasts.push('Auto-receive is on');
      } else if (mainnet && position.autoReceive === false) {
        notYet = true;
      } else if (mainnet) {
        // The server has no public Scan to ask (or it did not answer): it cannot tell either way.
        unknown = true;
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
      APPROXIMATE: the Grofty menu wording below could not be checked against the wallet (its docs
      were not reachable). Confirm the exact labels in Grofty Wallet before the MainNet demo
      (docs/verification.md).
    -->
    <ol class="steps" aria-label="Turn on auto-receive in Grofty Wallet">
      <li>Open Grofty Wallet.</li>
      <li>Open its settings.</li>
      <li>Turn on receiving CC automatically (auto-receive).</li>
      <li>Come back here and press Check again.</li>
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
  {#if unknown}
    <p class="info" role="status">
      <Icon name="clock" size={16} />
      <span
        >Mithra can't check this from here. If you turned auto-receive on in Grofty Wallet, you are
        set.</span
      >
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
