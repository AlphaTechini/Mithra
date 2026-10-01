<script lang="ts">
  /**
   * Review one audit request (userflow 11 step 5). The auditor's question sits beside the exact
   * records that would be shared (the server's `preview`), the treasurer picks an expiry and
   * Grant access or Deny. A granted request shows its expiry ring and End access now; an ended one
   * says "Access ended {date}". The seal closes only from the server's response (U3).
   */
  import type { AuditRequestDetail, GrantAccessRequest } from '@mithra/shared';
  import { page } from '$app/state';
  import { denyAccess, getAuditRequest, grantAccess, revokeGrant } from '$lib/api/audit';
  import AuditStatus from '$lib/components/audit/AuditStatus.svelte';
  import { EXPIRY_CHOICES, endedAt } from '$lib/components/audit/status';
  import Button from '$lib/components/Button.svelte';
  import Dialog from '$lib/components/Dialog.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import ErrorState from '$lib/components/ErrorState.svelte';
  import Field from '$lib/components/Field.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import PendingNotice from '$lib/components/PendingNotice.svelte';
  import Seal from '$lib/components/Seal.svelte';
  import Skeleton from '$lib/components/Skeleton.svelte';
  import { describeError } from '$lib/errors';
  import { formatDateTime, formatShortDate } from '$lib/format';
  import { createResource } from '$lib/resource.svelte';
  import { live } from '$lib/stores/live.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { debounce, poll } from '$lib/timing';
  import { onMount } from 'svelte';

  const requestId = $derived(page.params['requestId'] ?? '');
  const detail = createResource(() => getAuditRequest(requestId));

  const request = $derived(detail.data?.request ?? null);
  const grant = $derived(request?.grant ?? null);

  type Failure = { title: string; message: string };

  let expiresIn = $state<GrantAccessRequest['expiresIn']>('7d');
  /** Records the treasurer unticked; everything available is shared by default. */
  let dropped = $state<Record<string, boolean>>({});
  let granting = $state(false);
  let grantFailure = $state<Failure | null>(null);
  /** The closed seal is shown for a few seconds after a grant, then the expiry ring takes over. */
  let stamp = $state(false);

  let denyOpen = $state(false);
  let denyReason = $state('');
  let denying = $state(false);
  let denyFailure = $state<Failure | null>(null);
  let denyTouched = $state(false);

  let endOpen = $state(false);
  let ending = $state(false);
  let endFailure = $state<Failure | null>(null);

  const preview = $derived(detail.data?.preview ?? null);
  const sharedIds = $derived(
    preview
      ? preview.filter((p) => p.available && !dropped[p.recordId]).map((p) => p.recordId)
      : [],
  );
  /** Records an active or ended grant covers; falls back to the scope if there is no preview. */
  const grantedRecords = $derived.by(() => {
    const ids = new Set(grant?.recordIds ?? []);
    if (preview) return preview.filter((p) => ids.has(p.recordId));
    return (request?.scope ?? [])
      .filter((s) => ids.has(s.recordId))
      .map((s) => ({ recordId: s.recordId, label: s.label, summary: s.reason, available: true }));
  });
  const denyError = $derived(
    denyTouched && denyReason.trim() === '' ? 'Give the auditor a reason.' : null,
  );

  onMount(() => {
    void detail.load();
    const refresh = debounce(() => void detail.load(), 300);
    const offs = [
      live.subscribe('audit', refresh),
      live.onReconnect(refresh),
      poll(() => void detail.load(), 30_000),
    ];
    return () => {
      refresh.cancel();
      for (const off of offs) off();
    };
  });

  $effect(() => {
    if (!stamp) return;
    const timer = window.setTimeout(() => (stamp = false), 4000);
    return () => window.clearTimeout(timer);
  });

  async function grantNow(): Promise<void> {
    if (!request || sharedIds.length === 0 || granting) return;
    granting = true;
    grantFailure = null;
    try {
      const result: AuditRequestDetail = await grantAccess(request.requestId, {
        expiresIn,
        recordIds: sharedIds,
      });
      detail.set(result);
      if (result.request.grant) {
        stamp = true;
        toasts.push(`Access granted until ${formatShortDate(result.request.grant.expiresAt)}`);
      }
    } catch (e) {
      grantFailure = describeError(e, "Couldn't grant access.");
    } finally {
      granting = false;
    }
  }

  async function denyNow(event?: Event): Promise<void> {
    event?.preventDefault();
    denyTouched = true;
    if (!request || denyReason.trim() === '' || denying) return;
    denying = true;
    denyFailure = null;
    try {
      detail.set(await denyAccess(request.requestId, { reason: denyReason.trim() }));
      denyOpen = false;
      toasts.push('Request denied');
    } catch (e) {
      denyFailure = describeError(e, "Couldn't deny the request.");
    } finally {
      denying = false;
    }
  }

  async function endNow(): Promise<void> {
    if (!grant || ending) return;
    ending = true;
    endFailure = null;
    try {
      const result = await revokeGrant(grant.grantId);
      detail.set(result);
      endOpen = false;
      const when = endedAt(result.request);
      toasts.push(when ? `Access ended ${formatShortDate(when)}` : 'Access ended');
    } catch (e) {
      endFailure = describeError(e, "Couldn't end access.");
    } finally {
      ending = false;
    }
  }

  const failure = $derived(
    detail.error && !detail.data
      ? describeError(detail.error, "Couldn't load this request.")
      : null,
  );
</script>

<svelte:head>
  <title>Audit request · Mithra</title>
</svelte:head>

<PageHeader
  title="Audit request"
  description={request
    ? `From ${request.auditor.displayName}, requested ${formatDateTime(request.requestedAt)}`
    : 'The auditor’s question and the records it would share.'}
>
  {#snippet actions()}
    {#if request}<AuditStatus {request} />{/if}
  {/snippet}
</PageHeader>

{#if detail.loading}
  <Skeleton shape="block" height="14rem" label="Loading the audit request" />
{:else if failure}
  <ErrorState title={failure.title} message={failure.message} onretry={() => void detail.load()} />
{:else if request}
  <div class="sides">
    <section class="card" aria-labelledby="question-heading">
      <h2 id="question-heading">Auditor's question</h2>
      <p class="question">{request.question}</p>
      <h3>What is excluded</h3>
      <p class="muted">{request.excluded}</p>
    </section>

    <section class="card" aria-labelledby="records-heading">
      <h2 id="records-heading">
        {request.status === 'pending'
          ? 'Records that would be shared'
          : grant
            ? 'Records shared'
            : 'Records requested'}
      </h2>

      {#if request.status === 'pending' && preview}
        <p class="muted">
          {sharedIds.length} of {preview.length}
          {preview.length === 1 ? 'record' : 'records'} selected. Untick any record you do not want to
          share.
        </p>
        <ul class="records" aria-label="Records that would be shared">
          {#each preview as record (record.recordId)}
            <li>
              <label class="keep">
                <input
                  type="checkbox"
                  checked={record.available && !dropped[record.recordId]}
                  disabled={!record.available}
                  onchange={(e) => (dropped[record.recordId] = !e.currentTarget.checked)}
                />
                <span class="label">{record.label}</span>
              </label>
              <span class="summary">{record.summary}</span>
              {#if !record.available}
                <span class="unavailable">
                  <Icon name="alert" size={14} /> No longer on the ledger, so it cannot be shared.
                </span>
              {/if}
            </li>
          {/each}
        </ul>
      {:else if grant}
        <ul class="records" aria-label="Records shared">
          {#each grantedRecords as record (record.recordId)}
            <li>
              <span class="label">{record.label}</span>
              <span class="summary">{record.summary}</span>
            </li>
          {/each}
        </ul>
      {:else}
        <ul class="records" aria-label="Records requested">
          {#each request.scope as item (item.recordId)}
            <li>
              <span class="label">{item.label}</span>
              <span class="summary">{item.reason}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>

  <section class="decision card" aria-labelledby="decision-heading">
    {#if request.status === 'pending'}
      <h2 id="decision-heading">Your decision</h2>
      <div class="decide">
        <Seal required={1} signed={0} label="Not granted yet" size="md" />
        <div class="controls">
          <fieldset>
            <legend>Access lasts</legend>
            <div class="choices">
              {#each EXPIRY_CHOICES as choice (choice.value)}
                <label class="choice">
                  <input type="radio" name="expiry" value={choice.value} bind:group={expiresIn} />
                  <span>{choice.label}</span>
                </label>
              {/each}
            </div>
          </fieldset>
          {#if grantFailure}
            <ErrorState title={grantFailure.title} message={grantFailure.message} />
          {/if}
          {#if granting}<PendingNotice message="Waiting for the ledger to confirm…" />{/if}
          <div class="buttons">
            <Button busy={granting} disabled={sharedIds.length === 0} onclick={grantNow}
              >Grant access</Button
            >
            <Button
              variant="danger"
              disabled={granting}
              aria-haspopup="dialog"
              onclick={() => {
                denyOpen = true;
                denyFailure = null;
              }}>Deny</Button
            >
          </div>
          {#if sharedIds.length === 0}
            <p class="muted">Select at least one record to grant access.</p>
          {/if}
        </div>
      </div>
    {:else if grant && request.status === 'granted'}
      <h2 id="decision-heading">Access granted until {formatShortDate(grant.expiresAt)}</h2>
      <div class="decide">
        {#if stamp}
          <Seal
            required={1}
            signed={1}
            state="sealed"
            label="Access granted until {formatShortDate(grant.expiresAt)}"
            size="lg"
          />
        {:else}
          <Seal
            required={1}
            signed={1}
            state="expiring"
            grantedAt={grant.grantedAt}
            expiresAt={grant.expiresAt}
            label="Access granted until {formatShortDate(grant.expiresAt)}"
            size="md"
          />
        {/if}
        <div class="controls">
          <p class="muted">
            {request.auditor.displayName} can read the records above, and nothing else, until
            {formatDateTime(grant.expiresAt)}. The ring empties as that time approaches.
          </p>
          <div class="buttons">
            <Button
              variant="danger"
              aria-haspopup="dialog"
              onclick={() => {
                endOpen = true;
                endFailure = null;
              }}>End access now</Button
            >
          </div>
        </div>
      </div>
    {:else if request.status === 'ended'}
      <h2 id="decision-heading">Access ended {formatShortDate(endedAt(request) ?? '')}</h2>
      <p class="muted">
        {request.auditor.displayName} no longer sees any of these records.
      </p>
    {:else if request.status === 'denied'}
      <h2 id="decision-heading">Request denied</h2>
      {#if request.denial}
        <p class="muted">{request.denial.reason} ({formatShortDate(request.denial.at)})</p>
      {/if}
    {:else}
      <h2 id="decision-heading">Request withdrawn</h2>
      <p class="muted">The auditor withdrew this request. No records were shared.</p>
    {/if}
  </section>
{:else}
  <EmptyState
    message="This request is no longer here."
    actionLabel="Back to audit"
    actionHref="/app/audit"
  />
{/if}

{#if denyOpen}
  <Dialog title="Deny this request" onclose={() => (denyOpen = false)} initialFocus="textarea">
    <form onsubmit={denyNow}>
      <p>No records are shared. The auditor sees your reason.</p>
      <Field label="Reason" error={denyError}>
        {#snippet control(attrs)}
          <textarea
            {...attrs}
            bind:value={denyReason}
            rows="3"
            maxlength="500"
            onblur={() => (denyTouched = true)}></textarea>
        {/snippet}
      </Field>
      {#if denyFailure}<ErrorState title={denyFailure.title} message={denyFailure.message} />{/if}
      <button type="submit" class="sr-only" tabindex="-1" aria-hidden="true">Deny</button>
    </form>
    {#snippet footer()}
      <Button variant="secondary" onclick={() => (denyOpen = false)}>Cancel</Button>
      <Button variant="danger" busy={denying} onclick={() => denyNow()}>Deny</Button>
    {/snippet}
  </Dialog>
{/if}

{#if endOpen && grant}
  <Dialog title="End access now?" onclose={() => (endOpen = false)}>
    <p>
      {request?.auditor.displayName} loses access to the shared records straight away. This cannot be
      undone; they would need to send a new request.
    </p>
    {#if endFailure}<ErrorState title={endFailure.title} message={endFailure.message} />{/if}
    {#snippet footer()}
      <Button variant="secondary" onclick={() => (endOpen = false)}>Keep access</Button>
      <Button variant="danger" busy={ending} onclick={endNow}>End access now</Button>
    {/snippet}
  </Dialog>
{/if}

<style>
  h2,
  h3,
  p {
    margin: 0;
  }
  .sides {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: var(--space-4);
    align-items: start;
  }
  .card {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-4);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    min-width: 0;
  }
  .decision {
    margin-top: var(--space-4);
  }
  h3 {
    font-size: var(--text-15);
  }
  .question {
    font-family: var(--font-serif);
    font-size: var(--text-18);
    overflow-wrap: anywhere;
  }
  .muted {
    color: var(--color-text-muted);
  }
  .records {
    display: grid;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
    max-width: none;
  }
  .records li {
    display: grid;
    gap: var(--space-1);
    padding: var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }
  .label {
    font-weight: 600;
  }
  .keep {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .keep input {
    width: 1.125rem;
    height: 1.125rem;
    flex: none;
  }
  .summary {
    color: var(--color-text-muted);
    font-size: var(--text-13);
  }
  .unavailable {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    color: var(--color-danger-text);
    font-size: var(--text-13);
    font-weight: 500;
  }
  .decide {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: var(--space-4) var(--space-5);
  }
  .controls {
    display: grid;
    gap: var(--space-3);
    flex: 1 1 16rem;
    min-width: 0;
  }
  fieldset {
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }
  legend {
    padding: 0;
    margin-bottom: var(--space-2);
    font-weight: 600;
  }
  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
  }
  .choice {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 2.5rem;
  }
  .choice input {
    width: 1.125rem;
    height: 1.125rem;
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  form {
    display: grid;
    gap: var(--space-3);
  }
  @media (max-width: 800px) {
    .sides {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
