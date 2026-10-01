<script lang="ts">
  /**
   * Setup step 1: organization (userflow 4). Treasury name, base asset (CC, fixed), approvers and
   * the approval threshold with a live seal ring preview. On LocalNet approvers are picked from
   * the demo parties (none preselected; the "Approver ..." ones first, the rest under "Other demo
   * parties"); on MainNet they are typed as party ids. Problems are flagged on the field.
   */
  import { onMount } from 'svelte';
  import type { DemoParty, OrgResponse } from '@mithra/shared';
  import { createOrg, getDemoParties, getOrg } from '$lib/api/treasury';
  import Button from '$lib/components/Button.svelte';
  import ErrorState from '$lib/components/ErrorState.svelte';
  import Field from '$lib/components/Field.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import PartyId from '$lib/components/PartyId.svelte';
  import Seal from '$lib/components/Seal.svelte';
  import Skeleton from '$lib/components/Skeleton.svelte';
  import { describeError, type ErrorCopy } from '$lib/errors';
  import { navigate } from '$lib/nav';
  import { sessionStore } from '$lib/stores/session.svelte';

  const PARTY_ID = /^[^\s:]+::[0-9a-fA-F]+$/;

  let org = $state<OrgResponse | null>(null);
  let loadError = $state<unknown>(null);
  let loading = $state(true);
  let demoParties = $state<DemoParty[]>([]);

  let name = $state('');
  /** LocalNet: the selected demo party ids. */
  let picked = $state<string[]>([]);
  /** MainNet: one typed party id per row. */
  let typed = $state<string[]>(['', '']);
  let threshold = $state(2);
  let submitted = $state(false);
  let busy = $state(false);
  let failure = $state<ErrorCopy | null>(null);

  const testMode = $derived(sessionStore.testMode === true);
  const selfId = $derived(sessionStore.party?.partyId ?? '');
  const candidates = $derived(demoParties.filter((p) => p.partyId !== selfId));
  // LocalNet demo parties are named after their part in the story: "Approver 1" to "Approver 3"
  // are the obvious picks, so they come first; holders and the auditor follow under a sub-heading.
  const suggested = $derived(candidates.filter((p) => p.displayName.startsWith('Approver')));
  const others = $derived(candidates.filter((p) => !p.displayName.startsWith('Approver')));

  const approverIds = $derived(
    testMode ? picked : typed.map((t) => t.trim()).filter((t) => t !== ''),
  );
  const approverCount = $derived(approverIds.length);
  const effectiveThreshold = $derived(Math.min(Math.max(threshold, 1), Math.max(approverCount, 1)));

  const nameError = $derived(name.trim() === '' ? 'Enter a name for the treasury.' : null);

  /** Per typed row: what is wrong with it (MainNet). */
  const rowErrors = $derived(
    typed.map((raw, index) => {
      const value = raw.trim();
      if (value === '') return null;
      if (!PARTY_ID.test(value)) {
        return 'This is not a party id. It looks like name::1220abc…, copied from the wallet.';
      }
      if (value === selfId) return 'This is your own party. Add someone else as an approver.';
      const first = typed.findIndex((t) => t.trim() === value);
      return first !== index
        ? 'This party is already in the list. Each approver can be added once.'
        : null;
    }),
  );
  const approversError = $derived.by(() => {
    if (approverCount === 0) {
      return testMode ? 'Choose at least one approver.' : 'Add at least one approver by party id.';
    }
    return null;
  });
  const valid = $derived(
    !nameError && !approversError && (testMode || rowErrors.every((e) => e === null)),
  );

  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    try {
      org = await getOrg();
      if (testMode && demoParties.length === 0) {
        demoParties = await getDemoParties();
      }
    } catch (e) {
      loadError = e;
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void sessionStore.load().then(load);
  });

  function toggle(partyId: string, on: boolean): void {
    picked = on ? [...picked, partyId] : picked.filter((id) => id !== partyId);
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    submitted = true;
    failure = null;
    if (!valid || busy) return;
    busy = true;
    try {
      await createOrg({
        name: name.trim(),
        approvers: approverIds,
        approvalThreshold: effectiveThreshold,
      });
      await navigate('/setup/policy');
    } catch (e) {
      failure = describeError(e, "Couldn't create the organization.");
    } finally {
      busy = false;
    }
  }

  const nextStep = $derived(
    org?.setupStep === 'mandate'
      ? ('/setup/mandate' as const)
      : org?.setupStep === 'done'
        ? ('/app/overview' as const)
        : ('/setup/policy' as const),
  );
</script>

<svelte:head>
  <title>Organization · Set up · Mithra</title>
</svelte:head>

<PageHeader
  title="Organization"
  description="Name your treasury, choose its approvers and set how many must approve."
/>

{#if loading}
  <Skeleton shape="block" height="14rem" label="Loading your organization" />
{:else if loadError && !org}
  {@const copy = describeError(loadError, "Couldn't load your organization.")}
  <ErrorState title={copy.title} message={copy.message} onretry={load} />
{:else if org?.setupStep === 'charter'}
  <section class="notice" aria-labelledby="charter-title">
    <Icon name="alert" size={20} />
    <div>
      <h2 id="charter-title">The treasury charter isn't on the ledger yet</h2>
      <p>
        The treasury charter isn't on the ledger yet. On LocalNet run scripts/localnet-up.sh; it
        creates the charter through BitSafe governance. On MainNet, create it in Grofty Wallet.
      </p>
      <Button variant="secondary" onclick={load}>Check again</Button>
    </div>
  </section>
{:else if org && org.setupStep !== 'organization' && org.organization}
  <section class="done" aria-labelledby="done-title">
    <h2 id="done-title">{org.organization.name} is already set up</h2>
    <p>
      {org.organization.approvalThreshold} of {org.organization.approvers.length} approvers must approve
      a flagged proposal.
    </p>
    <ul class="approvers" aria-label="Approvers">
      {#each org.organization.approvers as approver (approver.partyId)}
        <li>{approver.displayName} <PartyId partyId={approver.partyId} /></li>
      {/each}
    </ul>
    <Button href={nextStep}>
      {org.setupStep === 'done' ? 'Go to overview' : 'Continue setup'}
    </Button>
  </section>
{:else}
  <form onsubmit={submit} novalidate>
    <Field label="Treasury name" error={submitted ? nameError : null}>
      {#snippet control(attrs)}
        <input {...attrs} bind:value={name} autocomplete="organization" maxlength="120" />
      {/snippet}
    </Field>

    <Field label="Base asset" hint="Distributions are paid in Canton Coin for now.">
      {#snippet control(attrs)}
        <input {...attrs} value="CC" readonly />
      {/snippet}
    </Field>

    <fieldset class="approvers-field">
      <legend>Approvers</legend>
      {#if testMode}
        <p class="hint">Pick the demo parties who can approve flagged proposals.</p>
        {#if candidates.length === 0}
          <p class="hint">No demo parties were found. Check that the backend is running.</p>
        {/if}
        {#snippet pickerList(list: DemoParty[], label: string)}
          <ul class="picker" aria-label={label}>
            {#each list as party (party.partyId)}
              <li>
                <label class="check">
                  <input
                    type="checkbox"
                    checked={picked.includes(party.partyId)}
                    onchange={(e) => toggle(party.partyId, e.currentTarget.checked)}
                  />
                  <span>{party.displayName}</span>
                </label>
                <PartyId partyId={party.partyId} />
              </li>
            {/each}
          </ul>
        {/snippet}
        {#if suggested.length > 0}
          {@render pickerList(suggested, 'Approver demo parties')}
        {/if}
        {#if others.length > 0}
          <h3 class="subheading">Other demo parties</h3>
          {@render pickerList(others, 'Other demo parties')}
        {/if}
      {:else}
        <p class="hint">Paste each approver's party id. They sign with their own wallet.</p>
        {#each typed, index (index)}
          <div class="row">
            <Field label={`Approver ${index + 1} party id`} error={rowErrors[index] ?? null}>
              {#snippet control(attrs)}
                <input
                  {...attrs}
                  bind:value={typed[index]}
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="name::1220abc…"
                />
              {/snippet}
            </Field>
            {#if typed.length > 1}
              <Button
                variant="quiet"
                small
                aria-label={`Remove approver ${index + 1}`}
                onclick={() => (typed = typed.filter((_, i) => i !== index))}>Remove</Button
              >
            {/if}
          </div>
        {/each}
        <Button variant="secondary" small onclick={() => (typed = [...typed, ''])}>
          <Icon name="plus" size={14} /> Add approver
        </Button>
      {/if}
      {#if submitted && approversError}
        <p class="field-error" role="alert"><Icon name="alert" size={14} /> {approversError}</p>
      {/if}
    </fieldset>

    <div class="threshold">
      <Field
        label="Approval threshold"
        hint="How many approvers must approve a flagged proposal before it is paid."
        short
      >
        {#snippet control(attrs)}
          <select
            {...attrs}
            value={effectiveThreshold}
            onchange={(e) => (threshold = Number(e.currentTarget.value))}
          >
            {#each Array.from({ length: Math.max(approverCount, 1) }, (_, i) => i + 1) as option (option)}
              <option value={option}>{option} of {Math.max(approverCount, 1)}</option>
            {/each}
          </select>
        {/snippet}
      </Field>
      <Seal
        required={effectiveThreshold}
        signed={0}
        label={`${effectiveThreshold} of ${Math.max(approverCount, 1)} approvals`}
        size="md"
      />
    </div>

    {#if failure}
      <ErrorState title={failure.title} message={failure.message} />
    {/if}
    <Button type="submit" {busy}>Continue</Button>
  </form>
{/if}

<style>
  .notice {
    display: flex;
    gap: var(--space-3);
    padding: var(--space-4);
    background: var(--color-info-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    max-width: 40rem;
  }
  .notice h2 {
    font-size: var(--text-18);
  }
  .done {
    max-width: 40rem;
  }
  .approvers {
    list-style: none;
    padding: 0;
  }
  .approvers li {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    margin-bottom: var(--space-1);
  }
  .approvers-field {
    margin: 0 0 var(--space-4);
    padding: 0;
    border: 0;
    max-width: 32rem;
  }
  legend {
    padding: 0;
    font-weight: 500;
  }
  .hint {
    margin: 0 0 var(--space-2);
    color: var(--color-text-muted);
    font-size: var(--text-13);
  }
  .picker {
    list-style: none;
    margin: 0 0 var(--space-3);
    padding: 0;
  }
  .picker li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--color-border);
  }
  .subheading {
    margin: var(--space-3) 0 var(--space-1);
    font-size: var(--text-13);
    font-weight: 500;
    color: var(--color-text-muted);
  }
  .check {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 2rem;
  }
  .check input {
    width: 1.1rem;
    height: 1.1rem;
  }
  .row {
    display: flex;
    gap: var(--space-2);
    align-items: flex-start;
  }
  .row :global(.field) {
    flex: 1;
    min-width: 0;
  }
  .row :global(button) {
    margin-top: 1.9rem;
  }
  .field-error {
    display: flex;
    gap: var(--space-1);
    align-items: center;
    margin: var(--space-2) 0 0;
    color: var(--color-danger-text);
    font-size: var(--text-13);
    font-weight: 500;
  }
  .threshold {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--space-5);
    margin-bottom: var(--space-4);
  }
  .threshold :global(.field) {
    margin-bottom: 0;
  }
</style>
