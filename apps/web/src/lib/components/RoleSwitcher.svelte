<script lang="ts">
  /**
   * LocalNet only: choose which demo party to act as. Parties come from
   * `/api/session/demo-parties`, grouped by role. Choosing one calls `POST /api/session/switch`
   * and then routes to that party's home. Keyboard: a native select (arrows, type-ahead).
   */
  import { DemoPartiesResponseSchema, type DemoParty, type Role } from '@mithra/shared';
  import { onMount } from 'svelte';
  import { apiGet } from '$lib/api/client';
  import { describeError } from '$lib/errors';
  import { navigate } from '$lib/nav';
  import { homeFor } from '$lib/routing';
  import { sessionStore } from '$lib/stores/session.svelte';
  import Skeleton from './Skeleton.svelte';

  let { compact = false }: { compact?: boolean } = $props();

  const uid = $props.id();
  const ORDER: Role[] = ['treasurer', 'approver', 'holder', 'auditor'];
  const GROUP_LABEL: Record<Role, string> = {
    treasurer: 'Treasurer',
    approver: 'Approver 1, 2, 3',
    holder: 'Holders A to D',
    auditor: 'Auditor',
  };

  let parties = $state<DemoParty[] | null>(null);
  let loadError = $state<string | null>(null);
  let switchError = $state<string | null>(null);
  let switching = $state(false);

  function primaryRoleOf(party: DemoParty): Role | null {
    return ORDER.find((role) => party.roles.includes(role)) ?? null;
  }

  const groups = $derived.by(() => {
    const list = parties ?? [];
    const byRole = ORDER.map((role) => ({
      key: role,
      label: GROUP_LABEL[role],
      parties: list.filter((p) => primaryRoleOf(p) === role),
    }));
    const unassigned = list.filter((p) => primaryRoleOf(p) === null);
    return [...byRole, { key: 'none', label: 'No role yet', parties: unassigned }].filter(
      (g) => g.parties.length > 0,
    );
  });

  const currentId = $derived(sessionStore.party?.partyId ?? '');

  async function load(): Promise<void> {
    loadError = null;
    try {
      parties = (await apiGet('/session/demo-parties', DemoPartiesResponseSchema)).parties;
    } catch (e) {
      const copy = describeError(e, "Demo parties didn't load.");
      loadError = `${copy.title} ${copy.message}`;
    }
  }

  onMount(() => {
    void load();
  });

  async function onChange(event: Event): Promise<void> {
    const partyId = (event.currentTarget as HTMLSelectElement).value;
    if (!partyId || partyId === currentId) return;
    switching = true;
    switchError = null;
    try {
      const session = await sessionStore.switchParty(partyId);
      await navigate(homeFor(session.party?.primaryRole ?? null));
    } catch (e) {
      const copy = describeError(e, "Couldn't switch party.");
      switchError = `${copy.title} ${copy.message}`;
    } finally {
      switching = false;
    }
  }
</script>

<div class="switcher" class:compact>
  <label for="{uid}-select">Acting as</label>
  {#if parties === null && !loadError}
    <Skeleton shape="line" lines={1} label="Loading demo parties" />
  {:else if loadError}
    <p class="error" role="alert">
      {loadError}
      <button type="button" class="retry" onclick={load}>Retry</button>
    </p>
  {:else}
    <select id="{uid}-select" value={currentId} disabled={switching} onchange={onChange}>
      {#if !currentId}
        <option value="" disabled selected>Choose a demo party</option>
      {/if}
      {#each groups as group (group.key)}
        <optgroup label={group.label}>
          {#each group.parties as party (party.partyId)}
            <option value={party.partyId}>{party.displayName}</option>
          {/each}
        </optgroup>
      {/each}
    </select>
  {/if}
  {#if switchError}<p class="error" role="alert">{switchError}</p>{/if}
</div>

<style>
  .switcher {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 12rem;
  }
  .compact {
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
  }
  label {
    font-size: var(--text-13);
    color: var(--color-text-muted);
    white-space: nowrap;
  }
  select {
    min-height: 2.25rem;
    padding: 0 var(--space-3);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    color: var(--color-text);
    max-width: 100%;
  }
  .error {
    margin: 0;
    color: var(--color-danger-text);
    font-size: var(--text-13);
  }
  .retry {
    border: 0;
    background: none;
    color: var(--color-link);
    text-decoration: underline;
    padding: 0;
  }
</style>
