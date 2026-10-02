<script lang="ts">
  /**
   * A link to something the server pointed us at: an in-app path ("/app/cycles/2026-09") or an
   * absolute http(s) URL (a MainNet explorer). In-app paths are resolved against the configured
   * base; external ones open in a new tab with `rel="noopener noreferrer"`.
   */
  import { resolve } from '$app/paths';
  import type { Pathname } from '$app/types';
  import type { Snippet } from 'svelte';

  let { link, children }: { link: string; children: Snippet } = $props();

  const external = $derived(/^https?:\/\//.test(link));
  const path = $derived((link.startsWith('/') ? link : `/${link}`) as Pathname);
</script>

{#if external}
  <a href={link} target="_blank" rel="external noopener noreferrer">{@render children()}</a>
{:else}
  <a href={resolve(path)}>{@render children()}</a>
{/if}
