<script lang="ts">
  /**
   * One cycle, live (userflow 9 and 10). The agent timeline fills in as `timeline` events arrive;
   * then the proposal: verdict, per-holder amounts, the checks with actual values, the memo and
   * the decision record. A clean proposal shows the Hold countdown; a flagged one shows the
   * approvals seal ring and, for an approver who has not approved yet, Approve and Reject.
   *
   * Everything shown as paid, approved or counted comes from the server's last answer: payments
   * read "Pending ledger confirmation" until the ledger confirms them (P4), and the seal ring
   * shows `approvals.length` from the server, never a number the browser increments (U3).
   */
  import { onMount, untrack } from 'svelte';
  import { page } from '$app/state';
  import type { CycleDetail, DecisionRecordView, PayoutRow } from '@mithra/shared';
  import {
    approveProposal,
    cancelCycle,
    getCycle,
    getDecisionRecord,
    holdCycle,
    rejectProposal,
    releaseCycle,
  } from '$lib/api/treasury';
  import Amount from '$lib/components/Amount.svelte';
  import AppLink from '$lib/components/AppLink.svelte';
  import AgentTimeline from '$lib/components/AgentTimeline.svelte';
  import Button from '$lib/components/Button.svelte';
  import DataTable from '$lib/components/DataTable.svelte';
  import Dialog from '$lib/components/Dialog.svelte';
  import ErrorState from '$lib/components/ErrorState.svelte';
  import Field from '$lib/components/Field.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import PartyId from '$lib/components/PartyId.svelte';
  import PendingNotice from '$lib/components/PendingNotice.svelte';
  import Seal from '$lib/components/Seal.svelte';
  import Skeleton from '$lib/components/Skeleton.svelte';
  import StatusChip from '$lib/components/StatusChip.svelte';
  import CheckList from '$lib/components/treasury/CheckList.svelte';
  import DecisionRecordPanel from '$lib/components/treasury/DecisionRecordPanel.svelte';
  import FundsWarning from '$lib/components/treasury/FundsWarning.svelte';
  import { cycleChip, isSettled, paymentChip } from '$lib/cycle';
  import { describeError, type ErrorCopy } from '$lib/errors';
  import { formatClock, formatDateTime, formatShortDate } from '$lib/format';
  import { createResource } from '$lib/resource.svelte';
  import { live } from '$lib/stores/live.svelte';
  import { sessionStore } from '$lib/stores/session.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { debounce, poll } from '$lib/timing';
  import type { TableColumn, TimelineStep } from '$lib/types/ui';

  const cycleId = $derived(page.params['cycleId'] ?? '');
  const cycle = createResource(() => getCycle(untrack(() => cycleId)));

  const detail = $derived(cycle.data);
  const proposal = $derived(detail?.proposal ?? null);
  const status = $derived(detail?.summary.status ?? null);
  const me = $derived(sessionStore.party);
  const isTreasurer = $derived(me?.roles.includes('treasurer') ?? false);
  const isApprover = $derived(me?.roles.includes('approver') ?? false);

  const youApproved = $derived(
    proposal !== null &&
      me !== null &&
      proposal.approvals.some((a) => a.approver.partyId === me.partyId),
  );
  const canDecide = $derived(
    proposal !== null &&
      me !== null &&
      status === 'awaiting-approval' &&
      proposal.approvers.some((a) => a.partyId === me.partyId) &&
      !youApproved,
  );
  const canCancel = $derived(
    isTreasurer && (status === 'awaiting-approval' || status === 'countdown' || status === 'held'),
  );

  // Hold countdown, ticking once a second while it runs.
  let now = $state(Date.now());
  const countdownActive = $derived(status === 'countdown' && detail?.countdown?.held === false);
  const remainingMs = $derived(
    detail?.countdown ? new Date(detail.countdown.executesAt).getTime() - now : 0,
  );

  $effect(() => {
    if (!countdownActive) return;
    now = Date.now();
    const timer = window.setInterval(() => (now = Date.now()), 1000);
    return () => window.clearInterval(timer);
  });

  // Actions.
  let acting = $state<'hold' | 'release' | 'cancel' | null>(null);
  let actionFailure = $state<ErrorCopy | null>(null);
  let note = $state('');
  let approving = $state(false);
  let decisionFailure = $state<ErrorCopy | null>(null);
  let dialog = $state<'reject' | 'cancel' | 'record' | null>(null);
  let reason = $state('');
  let reasonSubmitted = $state(false);
  let rejecting = $state(false);
  let record = $state<DecisionRecordView | null>(null);
  let recordFailure = $state<ErrorCopy | null>(null);

  const reasonError = $derived(reason.trim() === '' ? 'Say briefly why you reject it.' : null);

  function toStep(step: CycleDetail['timeline'][number]): TimelineStep {
    return {
      id: step.id,
      label: step.label,
      status: step.status,
      ...(step.detail ? { detail: step.detail } : {}),
      ...(step.at ? { at: step.at } : {}),
    };
  }

  const steps = $derived((detail?.timeline ?? []).map(toStep));

  async function run(kind: 'hold' | 'release' | 'cancel'): Promise<void> {
    acting = kind;
    actionFailure = null;
    try {
      if (kind === 'hold') await holdCycle(cycleId);
      else if (kind === 'release') await releaseCycle(cycleId);
      else await cancelCycle(cycleId);
      toasts.push(
        kind === 'hold'
          ? 'Held. Nothing is paid until you release it.'
          : kind === 'release'
            ? 'Released'
            : 'Proposal cancelled',
      );
      dialog = null;
      await cycle.load();
    } catch (e) {
      actionFailure = describeError(
        e,
        `Couldn't ${kind === 'cancel' ? 'cancel the proposal' : kind}.`,
      );
      dialog = null;
    } finally {
      acting = null;
    }
  }

  async function approve(): Promise<void> {
    if (!proposal || approving) return;
    approving = true;
    decisionFailure = null;
    try {
      // The ring and the toast use the count the server answers with, nothing local (U3).
      const updated = await approveProposal(proposal.proposalId, note.trim());
      cycle.set(updated);
      note = '';
      const have = updated.proposal?.approvals.length;
      const need = updated.proposal?.approvalThreshold;
      toasts.push(
        have !== undefined && need !== undefined ? `Approved (${have} of ${need})` : 'Approved',
      );
    } catch (e) {
      decisionFailure = describeError(e, "Couldn't record your approval.");
    } finally {
      approving = false;
    }
  }

  async function reject(): Promise<void> {
    reasonSubmitted = true;
    if (!proposal || reasonError || rejecting) return;
    rejecting = true;
    decisionFailure = null;
    try {
      const updated = await rejectProposal(proposal.proposalId, reason.trim());
      cycle.set(updated);
      reason = '';
      reasonSubmitted = false;
      dialog = null;
      toasts.push('Rejected');
    } catch (e) {
      decisionFailure = describeError(e, "Couldn't record your rejection.");
      dialog = null;
    } finally {
      rejecting = false;
    }
  }

  async function openRecord(): Promise<void> {
    recordFailure = null;
    if (detail?.decisionRecord) {
      record = detail.decisionRecord;
      dialog = 'record';
      return;
    }
    if (!proposal) return;
    dialog = 'record';
    try {
      record = await getDecisionRecord(proposal.decisionRecordId);
    } catch (e) {
      recordFailure = describeError(e, "Couldn't load the decision record.");
    }
  }

  // Polling is a fallback beside the live stream: quick while something is moving, slow while
  // payments wait for a holder to accept.
  const pollMs = $derived(
    status === null || isSettled(status) ? null : status === 'awaiting-acceptance' ? 15_000 : 4_000,
  );

  onMount(() => {
    void cycle.load();
    const refetch = debounce(() => void cycle.load(), 250);
    const offs = [
      live.subscribe('timeline', (event) => {
        if (event.cycleId !== cycleId) return;
        const current = cycle.data;
        if (current) {
          const index = current.timeline.findIndex((s) => s.id === event.step.id);
          const timeline = [...current.timeline];
          if (index >= 0) timeline[index] = event.step;
          else timeline.push(event.step);
          cycle.set({ ...current, timeline });
        }
        refetch();
      }),
      live.subscribe('cycle', (event) => {
        if (event.cycleId === cycleId) refetch();
      }),
      live.onReconnect(refetch),
    ];
    if (page.url.searchParams.get('record') === '1') {
      const stop = $effect.root(() => {
        $effect(() => {
          if (cycle.data && dialog === null && record === null) {
            untrack(() => void openRecord());
          }
        });
      });
      offs.push(stop);
    }
    return () => {
      refetch.cancel();
      for (const off of offs) off();
    };
  });

  $effect(() => {
    const ms = pollMs;
    if (ms === null) return;
    return poll(() => void cycle.load(), ms);
  });

  const columns: TableColumn[] = [
    { key: 'holder', label: 'Holder' },
    { key: 'units', label: 'Units on record date', numeric: true },
    { key: 'share', label: 'Share', numeric: true },
    { key: 'amount', label: 'Amount', numeric: true },
    { key: 'payment', label: 'Payment' },
  ];

  const TRIGGER = {
    schedule: 'Started by the schedule',
    prompt: 'Started by a prompt to the agent',
    manual: 'Started with Run cycle now',
  } as const;

  const chip = $derived(detail ? cycleChip(detail.summary) : null);
  const approvalsSeen = $derived(proposal?.approvals.length ?? 0);
  const approvalsNeeded = $derived(proposal?.approvalThreshold ?? 0);
</script>

<svelte:head>
  <title>{detail ? `${detail.summary.label} · Mithra` : 'Cycle · Mithra'}</title>
</svelte:head>

{#snippet checksSection()}
  {#if proposal}
    <section aria-labelledby="checks-title">
      <h2 id="checks-title">Checks</h2>
      <CheckList checks={proposal.checks} />
    </section>
  {/if}
{/snippet}

{#snippet memoSection()}
  {#if proposal}
    <section aria-labelledby="memo-title">
      <details open={isApprover && !isTreasurer}>
        <summary id="memo-title">Agent's memo</summary>
        <p class="source">{proposal.memoSource}</p>
        <p class="memo">{proposal.memo}</p>
      </details>
    </section>
  {/if}
{/snippet}

{#snippet tableSection()}
  {#if proposal}
    <section aria-labelledby="payouts-title">
      <h2 id="payouts-title">Per-holder amounts</h2>
      <DataTable
        caption="Per-holder amounts"
        hideCaption
        {columns}
        rows={proposal.payouts}
        rowKey={(r: PayoutRow) => r.holder.partyId}
      >
        {#snippet cell(row: PayoutRow, column: TableColumn)}
          {#if column.key === 'holder'}
            {row.holder.displayName}
          {:else if column.key === 'units'}
            {row.units.toLocaleString('en-US')}
          {:else if column.key === 'share'}
            {row.sharePct}%
          {:else if column.key === 'amount'}
            <Amount value={row.amount} />
          {:else if row.payment}
            <StatusChip kind={paymentChip(row.payment)} />
            {#if row.payment.link}
              <span class="tx"
                ><AppLink link={row.payment.link.href}>View transaction</AppLink></span
              >
            {/if}
          {:else}
            <span class="muted">Not paid yet</span>
          {/if}
        {/snippet}
      </DataTable>
    </section>
  {/if}
{/snippet}

{#if cycle.loading}
  <div class="skeletons">
    <Skeleton shape="line" lines={2} label="Loading the cycle" />
    <Skeleton shape="block" height="12rem" label="Loading the timeline" />
  </div>
{:else if cycle.error && !detail}
  {@const copy = describeError(cycle.error, "Couldn't load this cycle.")}
  <PageHeader title="Cycle" />
  <ErrorState title={copy.title} message={copy.message} onretry={() => void cycle.load()} />
  <p><Button variant="quiet" href="/app/cycles">Back to cycles</Button></p>
{:else if detail}
  <PageHeader title={detail.summary.label} description={TRIGGER[detail.summary.trigger]}>
    {#snippet actions()}
      {#if canCancel}
        <Button variant="danger" onclick={() => (dialog = 'cancel')} aria-haspopup="dialog"
          >Cancel proposal</Button
        >
      {/if}
    {/snippet}
  </PageHeader>

  <p class="chips">
    {#if chip}<StatusChip kind={chip.kind} progress={chip.progress} />{/if}
    {#if detail.summary.seeded}<StatusChip kind="seeded" />{/if}
    {#if detail.summary.recordDate}
      <span class="muted"
        >Record date {formatShortDate(detail.summary.recordDate + 'T00:00:00Z')}</span
      >
    {/if}
  </p>

  {#if actionFailure}<ErrorState title={actionFailure.title} message={actionFailure.message} />{/if}
  {#if detail.error}
    <ErrorState title="This cycle hit a problem." message={detail.error} />
  {/if}

  {#if status === 'needs-funds' && detail.fundsShortfall}
    <FundsWarning
      balance={detail.fundsShortfall.balance}
      required={detail.fundsShortfall.required}
      what="This distribution"
      title="This cycle can't be paid yet."
      onfunded={() => void cycle.load()}
    />
  {/if}

  {#if detail.outcome && detail.outcome.kind !== 'executed'}
    <section class="outcome" aria-label="Outcome">
      <Icon name={detail.outcome.kind === 'rejected' ? 'x-circle' : 'ban'} size={20} />
      <p>
        <strong>{detail.outcome.kind === 'rejected' ? 'Rejected' : 'Cancelled'}</strong>
        by {detail.outcome.actor.displayName} on {formatDateTime(detail.outcome.at)}.
        {#if detail.outcome.reason}Reason: {detail.outcome.reason}{/if}
        No payments were made.
      </p>
    </section>
  {/if}

  <section aria-labelledby="timeline-title">
    <h2 id="timeline-title">What the agent did</h2>
    {#if steps.length > 0}
      <AgentTimeline {steps} label="Agent progress for this cycle" />
    {:else}
      <p class="muted">The agent hasn't started this cycle yet.</p>
    {/if}
  </section>

  {#if proposal}
    <section aria-labelledby="proposal-title" class="proposal">
      <h2 id="proposal-title">Proposal</h2>
      <div class="verdict-row">
        <div>
          <p class="total"><Amount value={proposal.total} size="large" /></p>
          <p class="muted">
            to {proposal.payouts.length}
            {proposal.payouts.length === 1 ? 'holder' : 'holders'}
          </p>
        </div>
        <div>
          <p class="verdict">
            <Icon name={proposal.verdict === 'within-mandate' ? 'shield' : 'flag'} size={18} />
            {#if proposal.verdict === 'within-mandate'}
              Within mandate
            {:else}
              Needs {proposal.approvalThreshold} of {proposal.approvers.length} approvals
            {/if}
          </p>
          {#if proposal.verdictReasons.length > 0}
            <ul class="reasons" aria-label="Why approval is needed">
              {#each proposal.verdictReasons as line (line)}<li>{line}</li>{/each}
            </ul>
          {/if}
          <p class="muted">
            Record date {formatShortDate(proposal.recordDate + 'T00:00:00Z')}.
            <button type="button" class="link" onclick={openRecord}>View decision record</button>
          </p>
        </div>
      </div>

      {#if status === 'countdown' && detail.countdown && !detail.countdown.held}
        <div class="countdown" role="group" aria-label="Automatic payment countdown">
          <Icon name="clock" size={20} />
          {#if remainingMs > 0}
            <p>
              Payments run in <strong role="timer">{formatClock(remainingMs)}</strong>
              unless someone holds them.
            </p>
            {#if isTreasurer}
              <Button variant="secondary" busy={acting === 'hold'} onclick={() => run('hold')}
                >Hold</Button
              >
            {/if}
          {:else}
            <PendingNotice message="Submitting payments, waiting for the ledger…" />
          {/if}
        </div>
      {:else if status === 'held' || detail.countdown?.held}
        <div class="countdown held" role="group" aria-label="Payments on hold">
          <Icon name="pause" size={20} />
          <p>On hold. Nothing is paid until the treasurer releases it.</p>
          {#if isTreasurer}
            <Button busy={acting === 'release'} onclick={() => run('release')}>Release</Button>
          {/if}
        </div>
      {:else if status === 'executing'}
        <PendingNotice message="Waiting for the ledger to confirm the payments…" />
      {/if}

      {#if proposal.verdict === 'needs-approval'}
        <div class="approvals" role="group" aria-label="Approvals">
          <Seal
            required={approvalsNeeded}
            signed={approvalsSeen}
            label={`Approved ${approvalsSeen} of ${approvalsNeeded}`}
            size="lg"
          />
          <div class="approvers">
            <ul aria-label="Approvers">
              {#each proposal.approvers as approver (approver.partyId)}
                {@const given = proposal.approvals.find(
                  (a) => a.approver.partyId === approver.partyId,
                )}
                <li>
                  <span class="who"
                    >{approver.displayName} <PartyId partyId={approver.partyId} /></span
                  >
                  <StatusChip kind={given ? 'approved' : 'waiting'} />
                  {#if given}
                    <span class="muted"
                      >{formatDateTime(given.at)}{given.note ? `: ${given.note}` : ''}</span
                    >
                  {/if}
                </li>
              {/each}
            </ul>

            {#if canDecide}
              <div class="decide">
                <Field label="Note (optional)" hint="Shown with your approval in the record.">
                  {#snippet control(attrs)}
                    <textarea {...attrs} bind:value={note} rows="2" maxlength="500"></textarea>
                  {/snippet}
                </Field>
                <div class="buttons">
                  <Button busy={approving} disabled={rejecting} onclick={approve}>Approve</Button>
                  <Button
                    variant="danger"
                    disabled={approving}
                    onclick={() => (dialog = 'reject')}
                    aria-haspopup="dialog">Reject</Button
                  >
                </div>
                {#if approving}
                  <PendingNotice message="Waiting for the ledger to confirm your approval…" />
                {/if}
              </div>
            {:else if youApproved && status === 'awaiting-approval'}
              <p class="muted">You approved this proposal. Waiting for the others.</p>
            {/if}
            {#if decisionFailure}
              <ErrorState title={decisionFailure.title} message={decisionFailure.message} />
            {/if}
          </div>
        </div>
      {/if}

      {#if isApprover && !isTreasurer}
        {@render checksSection()}
        {@render memoSection()}
        {@render tableSection()}
      {:else}
        {@render tableSection()}
        {@render checksSection()}
        {@render memoSection()}
      {/if}
    </section>
  {:else if status !== 'running' && !detail.error}
    <p class="muted">No proposal was prepared for this cycle.</p>
  {:else}
    <p class="muted">The proposal appears here when the agent finishes.</p>
  {/if}
{/if}

{#if dialog === 'cancel'}
  <Dialog title="Cancel this proposal?" onclose={() => (dialog = null)}>
    <p>No payments will be made for this cycle. You can run the cycle again afterwards.</p>
    {#snippet footer()}
      <Button variant="secondary" onclick={() => (dialog = null)}>Keep proposal</Button>
      <Button variant="danger" busy={acting === 'cancel'} onclick={() => run('cancel')}
        >Cancel proposal</Button
      >
    {/snippet}
  </Dialog>
{:else if dialog === 'reject'}
  <Dialog title="Reject this proposal" onclose={() => (dialog = null)} initialFocus="textarea">
    <p>No payments will be made. The reason is shown to the treasurer and kept in the record.</p>
    <Field label="Reason" error={reasonSubmitted ? reasonError : null}>
      {#snippet control(attrs)}
        <textarea {...attrs} bind:value={reason} rows="3" maxlength="500"></textarea>
      {/snippet}
    </Field>
    {#snippet footer()}
      <Button variant="secondary" onclick={() => (dialog = null)}>Cancel</Button>
      <Button variant="danger" busy={rejecting} onclick={reject}>Reject</Button>
    {/snippet}
  </Dialog>
{:else if dialog === 'record'}
  <DecisionRecordPanel
    {record}
    failure={recordFailure}
    onretry={openRecord}
    onclose={() => (dialog = null)}
  />
{/if}

<style>
  .skeletons {
    display: grid;
    gap: var(--space-4);
  }
  section {
    margin-bottom: var(--space-6);
  }
  h2 {
    font-size: var(--text-24);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
  }
  .muted {
    color: var(--color-text-muted);
  }
  .outcome {
    display: flex;
    gap: var(--space-3);
    padding: var(--space-4);
    background: var(--color-danger-bg);
    color: var(--color-danger-text);
    border: 1px solid var(--color-danger);
    border-radius: var(--radius-md);
  }
  .outcome p {
    margin: 0;
  }
  .verdict-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-5);
    margin-bottom: var(--space-4);
  }
  .total {
    margin: 0;
    font-size: var(--text-44);
  }
  .verdict {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0 0 var(--space-2);
    font-size: var(--text-18);
    font-weight: 600;
  }
  .reasons {
    margin: 0 0 var(--space-2);
  }
  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--color-link);
    text-decoration: underline;
    text-underline-offset: 0.15em;
  }
  .countdown {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    margin-bottom: var(--space-4);
    background: var(--color-info-bg);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
  }
  .countdown p {
    margin: 0;
  }
  .countdown strong {
    font-variant-numeric: tabular-nums;
  }
  .approvals {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-5);
    padding: var(--space-4);
    margin-bottom: var(--space-5);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }
  .approvers {
    flex: 1;
    min-width: 15rem;
  }
  .approvers ul {
    list-style: none;
    margin: 0 0 var(--space-3);
    padding: 0;
    max-width: none;
  }
  .approvers li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--color-border);
  }
  .who {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    font-weight: 500;
  }
  .decide :global(.field) {
    max-width: none;
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
  }
  details summary {
    cursor: pointer;
    font-family: var(--font-serif);
    font-size: var(--text-24);
    margin-bottom: var(--space-2);
  }
  .source {
    color: var(--color-text-muted);
    font-size: var(--text-13);
    margin-bottom: var(--space-1);
  }
  .memo {
    white-space: pre-wrap;
    max-width: var(--measure);
  }
  .tx {
    display: block;
    margin-top: var(--space-1);
    font-size: var(--text-13);
  }
  @media (max-width: 600px) {
    .total {
      font-size: var(--text-32);
    }
  }
</style>
