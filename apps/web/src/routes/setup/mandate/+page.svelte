<script lang="ts">
  /**
   * Setup step 3: seal the mandate (userflow 4). The statement of what the agent can and cannot
   * do, the terms, and a one-segment seal ring for the treasurer. "Seal mandate" starts the
   * sealing; then the page follows the server's SealStatus (live `seal` events with a 2 s poll as
   * a fallback). The ring fills only when the server says the treasurer's signature is in (U3),
   * and closes when the mandate is sealed on the ledger.
   */
  import { onMount } from 'svelte';
  import type { PolicyDraft, SealStatus } from '@mithra/shared';
  import { getPolicyDraft, getSealStatus, sealMandate } from '$lib/api/treasury';
  import Button from '$lib/components/Button.svelte';
  import ErrorState from '$lib/components/ErrorState.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import PendingNotice from '$lib/components/PendingNotice.svelte';
  import Seal from '$lib/components/Seal.svelte';
  import Skeleton from '$lib/components/Skeleton.svelte';
  import StatusChip from '$lib/components/StatusChip.svelte';
  import { describeError, type ErrorCopy } from '$lib/errors';
  import { formatAmount } from '$lib/format';
  import { navigate } from '$lib/nav';
  import { sessionStore } from '$lib/stores/session.svelte';
  import { RECORD_DATE_RULES } from '$lib/policyForm';
  import { live } from '$lib/stores/live.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';

  const POLL_MS = 2000;
  const REDIRECT_MS = 1600;

  let draft = $state<PolicyDraft | null>(null);
  let loading = $state(true);
  let loadError = $state<unknown>(null);
  let seal = $state<SealStatus | null>(null);
  let starting = $state(false);
  let failure = $state<ErrorCopy | null>(null);
  let celebrated = false;

  const sealing = $derived(seal !== null && seal.state === 'awaiting-nodes');
  const sealed = $derived(seal?.state === 'sealed');
  const failed = $derived(seal?.state === 'failed');

  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    try {
      draft = await getPolicyDraft();
    } catch (e) {
      loadError = e;
    } finally {
      loading = false;
    }
  }

  function apply(next: SealStatus): void {
    // Only ever replace the status with what the server reports.
    if (seal && next.sealId !== seal.sealId) return;
    seal = next;
    if (next.state === 'sealed' && !celebrated) {
      celebrated = true;
      toasts.push('Mandate sealed');
      // Read the roles again first: a session loaded before the organization existed has none, and
      // the treasurer's screens would send it back to the start page.
      window.setTimeout(
        () => void sessionStore.refresh().then(() => navigate('/app/overview')),
        REDIRECT_MS,
      );
    }
  }

  async function start(): Promise<void> {
    if (!draft || starting) return;
    starting = true;
    failure = null;
    celebrated = false;
    try {
      const next = await sealMandate(draft.draftId);
      seal = null;
      apply(next);
    } catch (e) {
      failure = describeError(e, "Couldn't seal the mandate.");
    } finally {
      starting = false;
    }
  }

  onMount(() => {
    void load();
    const off = live.subscribe('seal', (event) => apply(event.seal));
    const timer = window.setInterval(() => {
      if (seal && sealing) {
        const id = seal.sealId;
        void getSealStatus(id)
          .then((next) => {
            if (seal?.sealId === id) apply(next);
          })
          .catch(() => {
            // The next tick tries again; a stream update may also arrive first.
          });
      }
    }, POLL_MS);
    return () => {
      off();
      window.clearInterval(timer);
    };
  });

  const ruleLabel = (value: string): string =>
    RECORD_DATE_RULES.find((r) => r.value === value)?.label ?? value;
</script>

<svelte:head>
  <title>Seal the mandate · Set up · Mithra</title>
</svelte:head>

<PageHeader
  title="Seal the mandate"
  description="Check what the agent may do. Sealing signs this authority; nothing changes on the ledger before then."
/>

{#if loading}
  <Skeleton shape="block" height="16rem" label="Loading your policy draft" />
{:else if loadError && !draft}
  {@const copy = describeError(loadError, "Couldn't load your policy draft.")}
  <ErrorState title={copy.title} message={copy.message} onretry={load} />
{:else if !draft}
  <p>There is no policy to seal yet. Describe your policy first and review it.</p>
  <Button href="/setup/policy">Go to policy</Button>
{:else}
  <div class="columns">
    <section aria-labelledby="can-title">
      <h2 id="can-title">The agent can</h2>
      <ul>
        {#each draft.agentCan as line (line)}<li>{line}</li>{/each}
      </ul>
    </section>
    <section aria-labelledby="cannot-title" class="cannot">
      <h2 id="cannot-title">The agent cannot</h2>
      <ul>
        {#each draft.agentCannot as line (line)}<li>{line}</li>{/each}
      </ul>
    </section>
  </div>

  <section class="terms" aria-labelledby="terms-title">
    <h2 id="terms-title">Terms</h2>
    <p>{draft.summary}</p>
    <dl>
      <dt>Auto-execute cap</dt>
      <dd>{formatAmount(draft.fields.cap)} CC</dd>
      <dt>Approvals needed</dt>
      <dd>{draft.fields.approvalThreshold} of {draft.fields.approvers.length}</dd>
      <dt>Schedule</dt>
      <dd><code>{draft.fields.scheduleCron}</code> ({draft.fields.scheduleTimezone})</dd>
      <dt>Record date</dt>
      <dd>{ruleLabel(draft.fields.recordDateRule)}</dd>
    </dl>
  </section>

  <section class="sealing" aria-labelledby="seal-title" aria-live="polite">
    <h2 id="seal-title" class="sr-only">Seal</h2>
    <Seal
      required={1}
      signed={seal?.treasurerSigned ? 1 : 0}
      state={sealed ? 'sealed' : 'open'}
      hold={!sealed}
      label={sealed ? 'Mandate sealed' : 'Your signature'}
      size="lg"
    />
    <div class="status">
      {#if sealed}
        <p class="done"><Icon name="check-circle" size={18} /> <strong>Mandate sealed</strong></p>
        <p>Taking you to the overview.</p>
        <Button href="/app/overview">Go to overview</Button>
      {:else if seal?.state === 'awaiting-nodes'}
        {@const nodes = seal.nodeConfirmations}
        <PendingNotice
          message={nodes
            ? `Waiting for treasury nodes: ${nodes.confirmed} of ${nodes.required} confirmations`
            : 'Waiting for treasury nodes to confirm…'}
        />
        {#if nodes}
          <ul class="nodes" aria-label="Treasury nodes">
            {#each nodes.nodes as node (node.id)}
              <li>
                <span class="node-name">{node.name}</span>
                <span class="node-op">{node.operator}</span>
                <StatusChip kind={node.confirmed ? 'confirmed' : 'waiting'} />
              </li>
            {/each}
          </ul>
        {/if}
      {:else if failed}
        <ErrorState
          title="The mandate wasn't sealed."
          message={seal?.error ?? 'Try again. If it keeps failing, check the backend logs.'}
        />
        <Button onclick={start} busy={starting}>Try again</Button>
      {:else}
        {#if failure}<ErrorState title={failure.title} message={failure.message} />{/if}
        <Button onclick={start} busy={starting}>Seal mandate</Button>
        <p class="note">You sign this yourself. The agent never signs for you.</p>
      {/if}
    </div>
  </section>
{/if}

<style>
  .columns {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-4);
    margin-bottom: var(--space-5);
  }
  .columns section {
    padding: var(--space-4);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }
  .cannot {
    border-color: var(--color-border-strong);
  }
  h2 {
    font-size: var(--text-18);
  }
  ul {
    margin: 0;
    padding-left: var(--space-5);
  }
  li {
    margin-bottom: var(--space-2);
  }
  .terms {
    margin-bottom: var(--space-5);
  }
  dl {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--space-1) var(--space-4);
    margin: 0;
  }
  dt {
    color: var(--color-text-muted);
  }
  dd {
    margin: 0;
  }
  .sealing {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-5);
    padding: var(--space-4);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }
  .status {
    flex: 1;
    min-width: 14rem;
  }
  .done {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--color-success-text);
  }
  .note {
    margin: var(--space-2) 0 0;
    color: var(--color-text-muted);
    font-size: var(--text-13);
  }
  .nodes {
    list-style: none;
    padding: 0;
    margin: var(--space-2) 0 0;
  }
  .nodes li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--color-border);
  }
  .node-name {
    font-weight: 500;
  }
  .node-op {
    color: var(--color-text-muted);
    flex: 1;
  }
  @media (max-width: 600px) {
    .columns {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
