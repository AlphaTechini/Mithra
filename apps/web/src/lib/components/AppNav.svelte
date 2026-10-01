<script lang="ts">
  /**
   * Primary navigation for treasurers and approvers. A left rail on wide screens; at 600 px and
   * below a bottom bar with the first five items plus a "More" menu. Keyboard: links are normal
   * links, "More" is a disclosure button (Escape closes it and returns focus).
   */
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import type { NavItem } from '$lib/types/ui';
  import Icon from './Icon.svelte';

  let { items }: { items: readonly NavItem[] } = $props();

  const BAR_SLOTS = 5;
  const primary = $derived(items.slice(0, BAR_SLOTS));
  const overflow = $derived(items.slice(BAR_SLOTS));

  let moreOpen = $state(false);
  let moreButton = $state<HTMLButtonElement>();
  let moreMenu = $state<HTMLElement>();

  const isCurrent = (href: string): boolean =>
    page.url.pathname === href || page.url.pathname.startsWith(href + '/');
  const overflowCurrent = $derived(overflow.some((item) => isCurrent(item.href)));

  function onWindowClick(event: MouseEvent): void {
    if (!moreOpen) return;
    const target = event.target as Node;
    if (!moreMenu?.contains(target) && !moreButton?.contains(target)) moreOpen = false;
  }

  function onWindowKeydown(event: KeyboardEvent): void {
    if (moreOpen && event.key === 'Escape') {
      moreOpen = false;
      moreButton?.focus();
    }
  }
</script>

<svelte:window onclick={onWindowClick} onkeydown={onWindowKeydown} />

<nav class="rail" aria-label="Main">
  <a class="brand" href={resolve('/app/overview')}>Mithra</a>
  <ul>
    {#each items as item (item.href)}
      <li>
        <a href={resolve(item.href)} aria-current={isCurrent(item.href) ? 'page' : undefined}>
          <Icon name={item.icon} size={18} />
          <span>{item.label}</span>
        </a>
      </li>
    {/each}
  </ul>
</nav>

<nav class="bar" aria-label="Main">
  <ul>
    {#each primary as item (item.href)}
      <li>
        <a href={resolve(item.href)} aria-current={isCurrent(item.href) ? 'page' : undefined}>
          <Icon name={item.icon} size={20} />
          <span>{item.label}</span>
        </a>
      </li>
    {/each}
    {#if overflow.length > 0}
      <li>
        <button
          type="button"
          class="more"
          class:current={overflowCurrent}
          bind:this={moreButton}
          aria-expanded={moreOpen}
          aria-controls="more-menu"
          onclick={() => (moreOpen = !moreOpen)}
        >
          <Icon name="more" size={20} />
          <span>More</span>
        </button>
      </li>
    {/if}
  </ul>
  {#if moreOpen}
    <ul id="more-menu" class="menu" bind:this={moreMenu}>
      {#each overflow as item (item.href)}
        <li>
          <a
            href={resolve(item.href)}
            aria-current={isCurrent(item.href) ? 'page' : undefined}
            onclick={() => (moreOpen = false)}
          >
            <Icon name={item.icon} size={18} />
            <span>{item.label}</span>
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</nav>

<style>
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    max-width: none;
  }
  a,
  .more {
    display: flex;
    align-items: center;
    text-decoration: none;
    color: var(--color-text);
  }

  /* Left rail (wide screens). */
  .rail {
    position: sticky;
    top: var(--strip-height);
    align-self: start;
    height: calc(100vh - var(--strip-height));
    padding: var(--space-5) var(--space-3);
    border-right: 1px solid var(--color-border);
    background: var(--color-surface);
  }
  .brand {
    display: block;
    margin: 0 var(--space-3) var(--space-5);
    font-family: var(--font-serif);
    font-size: var(--text-24);
    font-weight: 500;
  }
  .rail a {
    gap: var(--space-3);
    min-height: 2.5rem;
    padding: 0 var(--space-3);
    border-radius: var(--radius-md);
  }
  .rail a:hover {
    background: var(--color-surface-sunken);
  }
  .rail a[aria-current='page'] {
    background: var(--color-selected-bg);
    color: var(--color-info-text);
    font-weight: 600;
  }

  /* Bottom bar (phones). */
  .bar {
    display: none;
  }
  @media (max-width: 600px) {
    .rail {
      display: none;
    }
    .bar {
      display: block;
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 30;
      height: var(--bottom-bar-height);
      background: var(--color-surface);
      border-top: 1px solid var(--color-border);
    }
    .bar > ul:not(.menu) {
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: 1fr;
      height: 100%;
    }
    .bar > ul:not(.menu) > li {
      min-width: 0;
    }
    .bar a,
    .bar .more {
      flex-direction: column;
      justify-content: center;
      gap: 2px;
      width: 100%;
      height: 100%;
      padding: 0 2px;
      border: 0;
      background: none;
      font-size: 0.6875rem;
      line-height: 1.2;
      text-align: center;
    }
    .bar a[aria-current='page'],
    .bar .more.current {
      color: var(--color-info-text);
      font-weight: 600;
      box-shadow: inset 0 3px 0 var(--color-primary);
    }
    .menu {
      position: absolute;
      right: var(--space-2);
      bottom: calc(var(--bottom-bar-height) + var(--space-2));
      min-width: 11rem;
      padding: var(--space-2);
      background: var(--color-surface);
      border: 1px solid var(--color-border-strong);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-md);
    }
    .menu a {
      flex-direction: row;
      justify-content: flex-start;
      gap: var(--space-3);
      min-height: 2.75rem;
      padding: 0 var(--space-3);
      font-size: var(--text-15);
      text-align: left;
    }
    .menu a[aria-current='page'] {
      box-shadow: none;
      background: var(--color-selected-bg);
    }
  }
</style>
