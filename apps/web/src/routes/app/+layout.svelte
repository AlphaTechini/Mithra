<script lang="ts">
  /**
   * Treasurer and approver layout: left navigation (bottom bar on phones), a header with the
   * party, the LocalNet role switcher, sign out and "Ask the agent", and the agent panel.
   * Guarded: signed out goes to /launch, other roles go to their own home.
   */
  import type { Snippet } from 'svelte';
  import AgentPanel from '$lib/components/AgentPanel.svelte';
  import AppNav from '$lib/components/AppNav.svelte';
  import Button from '$lib/components/Button.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import PartyBar from '$lib/components/PartyBar.svelte';
  import SessionGate from '$lib/components/SessionGate.svelte';
  import { untrack } from 'svelte';
  import { agentStore } from '$lib/stores/agent.svelte';
  import { sessionStore } from '$lib/stores/session.svelte';
  import { shell } from '$lib/stores/ui.svelte';
  import type { NavItem } from '$lib/types/ui';

  let { children }: { children: Snippet } = $props();

  // The agent conversation belongs to the signed-in party: reload it when the party changes.
  $effect(() => {
    const partyId = sessionStore.party?.partyId;
    if (!partyId) return;
    untrack(() => {
      agentStore.reset();
      void agentStore.load();
    });
  });

  const isApprover = $derived(sessionStore.party?.roles.includes('approver') ?? false);

  const overview: NavItem = { href: '/app/overview', label: 'Overview', icon: 'home' };
  const approvals: NavItem = { href: '/app/approvals', label: 'Approvals', icon: 'inbox' };
  const rest: NavItem[] = [
    { href: '/app/agent', label: 'Agent', icon: 'sparkle' },
    { href: '/app/cycles', label: 'Cycles', icon: 'cycle' },
    { href: '/app/holders', label: 'Holders', icon: 'users' },
    { href: '/app/audit', label: 'Audit', icon: 'audit' },
    { href: '/app/activity', label: 'Activity', icon: 'activity' },
    { href: '/app/settings', label: 'Settings', icon: 'settings' },
  ];

  // Approvers also see Approvals; for an approver it comes first, since that is their inbox.
  const items = $derived<NavItem[]>(
    !isApprover
      ? [overview, ...rest]
      : sessionStore.party?.primaryRole === 'approver'
        ? [approvals, overview, ...rest]
        : [overview, approvals, ...rest],
  );
</script>

<SessionGate allow={['treasurer', 'approver']}>
  <div class="app">
    <AppNav {items} />
    <div class="content">
      <header>
        <PartyBar>
          {#snippet actions()}
            <Button variant="secondary" aria-haspopup="dialog" onclick={() => shell.openAgent()}>
              <Icon name="sparkle" size={16} /> Ask the agent
            </Button>
          {/snippet}
        </PartyBar>
      </header>
      <main id="main" tabindex="-1">
        {@render children()}
      </main>
    </div>
  </div>
  <AgentPanel
    bind:open={shell.agentOpen}
    messages={agentStore.rows}
    suggestions={agentStore.suggestions}
    busy={agentStore.busy}
    error={agentStore.error}
    onretry={() => void agentStore.retry()}
    onsend={(text: string) => void agentStore.send(text)}
  />
</SessionGate>

<style>
  .app {
    display: grid;
    grid-template-columns: 14rem minmax(0, 1fr);
    min-height: calc(100vh - var(--strip-height));
  }
  .content {
    min-width: 0;
  }
  header {
    padding: var(--space-3) var(--space-5);
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
  }
  main {
    max-width: 72rem;
    padding: var(--space-6) var(--space-5) var(--space-7);
  }
  @media (max-width: 600px) {
    .app {
      grid-template-columns: minmax(0, 1fr);
    }
    header {
      padding: var(--space-3) var(--space-4);
    }
    main {
      padding: var(--space-5) var(--space-4) calc(var(--bottom-bar-height) + var(--space-6));
    }
  }
</style>
