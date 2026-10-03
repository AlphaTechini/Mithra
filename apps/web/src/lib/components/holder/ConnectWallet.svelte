<script lang="ts">
  /**
   * MainNet: the holder connects Grofty Wallet so payouts know where to go (N4). Connect, ask the
   * server for a challenge, have the wallet sign it (`signMessage`), and send the account and the
   * signature back; the server checks that the party belongs to the key that signed. Mithra's own
   * records are not signed by this wallet (they live on the LocalNet ledger).
   */
  import type { HolderPosition } from '@mithra/shared';
  import { ApiError } from '$lib/api/client';
  import { registerWallet, requestWalletChallenge } from '$lib/api/mainnet';
  import Button from '$lib/components/Button.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import PendingNotice from '$lib/components/PendingNotice.svelte';
  import { describeError } from '$lib/errors';
  import { toasts } from '$lib/stores/toasts.svelte';
  import * as grofty from '$lib/wallet/grofty';

  interface Props {
    /** Called with the position the server returns once the wallet is registered. */
    onchange: (position: HolderPosition) => void;
  }

  let { onchange }: Props = $props();

  let busy = $state(false);
  let step = $state<'idle' | 'connecting' | 'signing' | 'saving'>('idle');
  let failure = $state<{ message: string; helpUrl: string | null } | null>(null);

  const NOTICE: Record<typeof step, string> = {
    idle: '',
    connecting: 'Approve the connection in Grofty Wallet…',
    signing: 'Approve the signature in Grofty Wallet…',
    saving: 'Mithra is checking your wallet…',
  };

  async function connect(): Promise<void> {
    if (busy) return;
    busy = true;
    failure = null;
    try {
      step = 'connecting';
      const account = await grofty.connect();
      const challenge = await requestWalletChallenge();
      step = 'signing';
      const signature = await grofty.signMessage(challenge.message);
      step = 'saving';
      const position = await registerWallet({
        partyId: account.partyId,
        publicKey: account.publicKey,
        signature,
        nonce: challenge.nonce,
      });
      toasts.push('Grofty Wallet connected');
      onchange(position);
    } catch (e) {
      if (e instanceof grofty.GroftyWalletError) {
        failure = { message: e.message, helpUrl: e.helpUrl };
      } else if (e instanceof ApiError && e.code === 'invalid_signature') {
        // A 401 that is not a signed-out session: the server's wording says what to do.
        failure = { message: e.message, helpUrl: null };
      } else {
        // The server's own wording, for example "Grofty's signature did not match this wallet."
        const copy = describeError(e, "Couldn't connect Grofty Wallet.");
        failure = { message: `${copy.title} ${copy.message}`, helpUrl: null };
      }
    } finally {
      busy = false;
      step = 'idle';
    }
  }
</script>

<div class="connect">
  <Button {busy} onclick={connect}>Connect Grofty Wallet</Button>
  {#if busy && step !== 'idle'}<PendingNotice message={NOTICE[step]} />{/if}
  {#if failure}
    <p class="error" role="alert">
      <Icon name="alert" size={16} />
      <span>
        {failure.message}
        {#if failure.helpUrl}
          <a href={failure.helpUrl} target="_blank" rel="external noopener noreferrer"
            >Get Grofty Wallet</a
          >
        {/if}
      </span>
    </p>
  {/if}
</div>

<style>
  .connect {
    display: grid;
    justify-items: start;
    gap: var(--space-3);
  }
  .error {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    margin: 0;
    color: var(--color-danger-text);
  }
</style>
