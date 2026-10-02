<script lang="ts">
  /**
   * Settings (userflow 12): the organization, the mandate's terms and seal, the network, and on
   * LocalNet the Infrastructure panel with live node status (refreshed every 10 s).
   */
  import { onMount } from 'svelte';
  import type { InfrastructureResponse } from '@mithra/shared';
  import { getInfrastructure, getOrg, updatePolicyDraft } from '$lib/api/treasury';
  import Amount from '$lib/components/Amount.svelte';
  import Button from '$lib/components/Button.svelte';
  import DataTable from '$lib/components/DataTable.svelte';
  import ErrorState from '$lib/components/ErrorState.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import PartyId from '$lib/components/PartyId.svelte';
  import Seal from '$lib/components/Seal.svelte';
  import Skeleton from '$lib/components/Skeleton.svelte';
  import StatusChip from '$lib/components/StatusChip.svelte';
  import { describeError } from '$lib/errors';
  import { formatDateTime } from '$lib/format';
  import { navigate } from '$lib/nav';
  import { fieldsFromTerms } from '$lib/policyForm';
  import { createResource } from '$lib/resource.svelte';
  import { live } from '$lib/stores/live.svelte';
  import { sessionStore } from '$lib/stores/session.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { poll } from '$lib/timing';
  import type { TableColumn } from '$lib/types/ui';

  type InfraNode = InfrastructureResponse['nodes'][number];

  const org = createResource(getOrg);
  const infra = createResource(getInfrastructure);
  let editing = $state(false);

  const isTreasurer = $derived(sessionStore.party?.roles.includes('treasurer') ?? false);
  const localnet = $derived(sessionStore.network === 'localnet');
  const mandate = $derived(org.data?.mandate ?? null);
  const organization = $derived(org.data?.organization ?? null);

  const nodeColumns: TableColumn[] = [
    { key: 'name', label: 'Node' },
    { key: 'operator', label: 'Operator' },
    { key: 'status', label: 'Status' },
    { key: 'hosts', label: 'Hosts the treasury' },
  ];

  onMount(() => {
    void sessionStore.load();
    void org.load();
    void infra.load();
    const offs = [
      live.subscribe('seal', () => void org.load()),
      poll(() => void infra.load(), 10_000),
    ];
    return () => {
      for (const off of offs) off();
    };
  });

  /**
   * "Edit and re-seal": starts a draft from the current mandate's terms and goes to the policy
   * step. Changes only take effect once sealed again.
   */
  async function editAndReseal(): Promise<void> {
    if (!mandate) return;
    editing = true;
    try {
      const fields = fieldsFromTerms(mandate.terms);
      if (fields) await updatePolicyDraft(fields);
      await navigate('/setup/policy');
    } catch (e) {
      const copy = describeError(e, "Couldn't start an edit.");
      toasts.push(`${copy.title} ${copy.message}`, 'error', 0);
    } finally {
      editing = false;
    }
  }
</script>

<svelte:head>
  <title>Settings · Mithra</title>
</svelte:head>

<PageHeader
  title="Settings"
  description="Your organization, the agent's mandate and the network."
/>

{#if org.loading}
  <Skeleton shape="block" height="12rem" label="Loading settings" />
{:else if org.error && !org.data}
  {@const copy = describeError(org.error, "Couldn't load settings.")}
  <ErrorState title={copy.title} message={copy.message} onretry={() => void org.load()} />
{:else}
  <section aria-labelledby="org-title">
    <h2 id="org-title">Organization</h2>
    {#if organization}
      <dl>
        <dt>Name</dt>
        <dd>{organization.name}</dd>
        <dt>Treasurer</dt>
        <dd>
          {organization.treasurer.displayName}
          <PartyId partyId={organization.treasurer.partyId} />
        </dd>
        <dt>Approvers</dt>
        <dd>
          <ul class="plain">
            {#each organization.approvers as approver (approver.partyId)}
              <li>{approver.displayName} <PartyId partyId={approver.partyId} /></li>
            {/each}
          </ul>
        </dd>
        <dt>Threshold</dt>
        <dd>{organization.approvalThreshold} of {organization.approvers.length}</dd>
      </dl>
      <p class="note">Changes to the organization require re-sealing the mandate.</p>
    {:else}
      <p>No organization yet.</p>
      <Button href="/setup/organization">Set up a treasury</Button>
    {/if}
  </section>

  <section aria-labelledby="mandate-title">
    <h2 id="mandate-title">Mandate</h2>
    {#if mandate}
      <div class="mandate">
        <Seal
          required={mandate.seal.required}
          signed={mandate.seal.signed}
          state="sealed"
          label="Mandate sealed"
          size="md"
        />
        <dl>
          <dt>Version</dt>
          <dd>
            {mandate.version}, sealed {formatDateTime(mandate.sealedAt)} by {mandate.sealedBy
              .displayName}
          </dd>
          <dt>Auto-execute cap</dt>
          <dd><Amount value={mandate.terms.cap} symbol={mandate.terms.assetSymbol} /></dd>
          <dt>Approvals needed</dt>
          <dd>{mandate.terms.approvalThreshold} of {mandate.terms.approvers.length}</dd>
          <dt>Schedule</dt>
          <dd>{mandate.terms.scheduleText}</dd>
          <dt>Record date</dt>
          <dd>{mandate.terms.recordDateText}</dd>
          {#if mandate.terms.fixedAmount}
            <dt>Fixed amount</dt>
            <dd><Amount value={mandate.terms.fixedAmount} symbol={mandate.terms.assetSymbol} /></dd>
          {/if}
          <dt>Flag if</dt>
          <dd>
            the total deviates more than {mandate.terms.deviationPct}% from the {mandate.terms
              .trailingCycles}-cycle average, or a holder's units change more than {mandate.terms
              .unitChangePct}% in the {mandate.terms.unitChangeWindowDays}
            days before the record date
          </dd>
          <dt>Fee buffer</dt>
          <dd><Amount value={mandate.terms.feeBuffer} symbol={mandate.terms.assetSymbol} /></dd>
          <dt>Execution</dt>
          <dd>
            {mandate.agentExecutes
              ? 'The agent pays inside the cap.'
              : 'You sign each payout in Grofty Wallet.'}
          </dd>
        </dl>
      </div>
      {#if isTreasurer}
        <Button variant="secondary" busy={editing} onclick={editAndReseal}>Edit and re-seal</Button>
      {/if}
    {:else}
      <p>No mandate is sealed yet.</p>
      {#if isTreasurer}<Button href="/setup/organization">Set up a treasury</Button>{/if}
    {/if}
  </section>

  <section aria-labelledby="network-title">
    <h2 id="network-title">Network</h2>
    {#if sessionStore.network === 'localnet'}
      <p><Icon name="flask" size={16} /> LocalNet test mode. Nothing here is real money.</p>
    {:else if sessionStore.network === 'mainnet'}
      <p>
        <Icon name="globe" size={16} /> MainNet payouts. Payments move real CC from your Grofty Wallet.
        Mithra's own records (organization, Mandate, approvals, decisions) stay on the LocalNet ledger.
      </p>
    {:else}
      <p>The network isn't known yet.</p>
    {/if}
  </section>

  {#if localnet}
    <section aria-labelledby="infra-title">
      <h2 id="infra-title">Infrastructure</h2>
      {#if infra.loading}
        <Skeleton shape="table" rows={3} label="Loading infrastructure" />
      {:else if infra.error && !infra.data}
        {@const copy = describeError(infra.error, "Couldn't load infrastructure.")}
        <ErrorState title={copy.title} message={copy.message} onretry={() => void infra.load()} />
      {:else if infra.data}
        {@const data = infra.data}
        <p>
          The treasury party is hosted on {data.nodes.length} nodes and keeps running while
          {data.hostingThreshold} of {data.nodes.length} are online.
        </p>
        <p class="summary" aria-live="polite">{data.summary}</p>
        <dl>
          <dt>Treasury party</dt>
          <dd><PartyId partyId={data.treasuryParty} /></dd>
          <dt>Hosting threshold</dt>
          <dd>{data.hostingThreshold} of {data.nodes.length}</dd>
        </dl>
        <DataTable
          caption="Hosting nodes"
          columns={nodeColumns}
          rows={data.nodes}
          rowKey={(n: InfraNode) => n.id}
        >
          {#snippet cell(node: InfraNode, column: TableColumn)}
            {#if column.key === 'name'}
              {node.name}
            {:else if column.key === 'operator'}
              {node.operator}
            {:else if column.key === 'status'}
              <StatusChip kind={node.online ? 'online' : 'offline'} />
            {:else}
              {node.hostsTreasury ? 'Yes' : 'No'}
            {/if}
          {/snippet}
        </DataTable>
      {/if}
    </section>
  {/if}
{/if}

<style>
  section {
    margin-bottom: var(--space-6);
    max-width: 52rem;
  }
  h2 {
    font-size: var(--text-24);
  }
  dl {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--space-2) var(--space-5);
    margin: 0 0 var(--space-3);
  }
  dt {
    color: var(--color-text-muted);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .plain {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .note {
    color: var(--color-text-muted);
    font-size: var(--text-13);
  }
  .mandate {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-5);
    margin-bottom: var(--space-3);
  }
  .mandate dl {
    flex: 1;
    min-width: 16rem;
  }
  .summary {
    font-weight: 600;
  }
  @media (max-width: 600px) {
    dl {
      grid-template-columns: minmax(0, 1fr);
      gap: 0;
    }
    dd {
      margin-bottom: var(--space-2);
    }
  }
</style>
