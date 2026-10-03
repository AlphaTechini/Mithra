<script lang="ts">
  /**
   * Link to a payment's transaction (P3). MainNet links are external explorer URLs and open in a
   * new tab; LocalNet links open the in-app transaction detail in the same tab. The target comes
   * from the server's TxLink, never built in the browser from another holder's data.
   */
  import type { TxLink } from '@mithra/shared';
  import { resolve } from '$app/paths';
  import type { Pathname } from '$app/types';

  /** `context` names the payment for assistive technology, e.g. the cycle label. */
  let { link, context }: { link: TxLink; context: string } = $props();

  /** An external link is an anchor only for http(s): `javascript:` and the like never become one. */
  const safeExternal = $derived.by((): boolean => {
    try {
      const { protocol } = new URL(link.href);
      return protocol === 'https:' || protocol === 'http:';
    } catch {
      return false;
    }
  });
</script>

{#if link.external && !safeExternal}
  <span class="muted">Explorer link unavailable</span>
{:else if link.external}
  <!-- External explorer URL: not an app route, so it is not resolved against the app base. -->
  <!-- eslint-disable svelte/no-navigation-without-resolve -->
  <a
    href={link.href}
    target="_blank"
    rel="noopener noreferrer"
    aria-label="View on explorer, {context}"
    >View on explorer<span class="sr-only"> (opens in a new tab)</span></a
  >
  <!-- eslint-enable svelte/no-navigation-without-resolve -->
{:else}
  <a href={resolve(link.href as Pathname)} aria-label="View transaction, {context}"
    >View transaction</a
  >
{/if}

<style>
  .muted {
    color: var(--color-text-muted);
  }
</style>
