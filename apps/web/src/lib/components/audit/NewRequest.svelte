<script lang="ts">
  /**
   * New audit request (userflow 11 steps 2 to 4). The auditor describes what they need in plain
   * English; the agent proposes the smallest scope, record by record with a reason (A8). The
   * auditor can drop records and edit reasons, then "Request access". Nothing about the scope is
   * decided here: the records and reasons come from the server, and only what the auditor keeps
   * is sent back.
   */
  import type { AuditRequestDetail, ScopeDraft, ScopeItemView } from '@mithra/shared';
  import { createAuditRequest, draftScope } from '$lib/api/audit';
  import { describeError } from '$lib/errors';
  import { toasts } from '$lib/stores/toasts.svelte';
  import Button from '../Button.svelte';
  import EmptyState from '../EmptyState.svelte';
  import ErrorState from '../ErrorState.svelte';
  import Field from '../Field.svelte';
  import Icon from '../Icon.svelte';
  import PendingNotice from '../PendingNotice.svelte';

  interface Props {
    /** Called with the created request once the server has accepted it. */
    oncreated: (detail: AuditRequestDetail) => void;
  }

  let { oncreated }: Props = $props();

  const EXAMPLE = 'Show all Q3 distributions and the approvals behind any flagged one.';

  interface Row {
    item: ScopeItemView;
    keep: boolean;
    reason: string;
  }

  let question = $state('');
  let draft = $state<ScopeDraft | null>(null);
  /** The question the current proposal answers; editing the question makes the proposal stale. */
  let draftedQuestion = $state('');
  let rows = $state<Row[]>([]);
  let proposing = $state(false);
  let requesting = $state(false);
  let proposeFailure = $state<{ title: string; message: string } | null>(null);
  let requestFailure = $state<{ title: string; message: string } | null>(null);

  const trimmed = $derived(question.trim());
  const kept = $derived(rows.filter((r) => r.keep));
  const stale = $derived(draft !== null && trimmed !== draftedQuestion);
  const canRequest = $derived(draft !== null && !stale && kept.length > 0 && !requesting);

  async function propose(event?: Event): Promise<void> {
    event?.preventDefault();
    if (!trimmed || proposing) return;
    proposing = true;
    proposeFailure = null;
    requestFailure = null;
    // The question this proposal is for. If it changes while the request is out, the answer is for
    // a question that is no longer on screen, so it is dropped rather than shown for the new one.
    const asked = trimmed;
    try {
      const result = await draftScope(asked);
      if (asked !== trimmed) return;
      draft = result;
      draftedQuestion = asked;
      rows = result.items.map((item) => ({ item, keep: true, reason: item.reason }));
    } catch (e) {
      if (asked === trimmed) proposeFailure = describeError(e, "Couldn't propose a scope.");
    } finally {
      proposing = false;
    }
  }

  async function requestAccess(): Promise<void> {
    if (!draft || !canRequest) return;
    requesting = true;
    requestFailure = null;
    try {
      const detail = await createAuditRequest({
        question: draftedQuestion,
        items: kept.map((r) => ({
          recordId: r.item.recordId,
          kind: r.item.kind,
          reason: r.reason,
        })),
        excluded: draft.excluded,
      });
      toasts.push('Request sent');
      question = '';
      draft = null;
      rows = [];
      oncreated(detail);
    } catch (e) {
      requestFailure = describeError(e, "Couldn't send your request.");
    } finally {
      requesting = false;
    }
  }
</script>

<section class="new" aria-labelledby="new-request-heading">
  <h2 id="new-request-heading">New request</h2>

  <form onsubmit={propose}>
    <Field
      label="What do you need to see?"
      hint="Describe it in plain English. The agent proposes the smallest set of records that answers it."
    >
      {#snippet control(attrs)}
        <textarea
          {...attrs}
          bind:value={question}
          rows="3"
          maxlength="2000"
          placeholder="For example: {EXAMPLE}"></textarea>
      {/snippet}
    </Field>
    <div class="actions">
      <Button type="submit" busy={proposing} disabled={!trimmed}>Propose scope</Button>
      <Button variant="quiet" onclick={() => (question = EXAMPLE)}>Use the example</Button>
    </div>
  </form>

  {#if proposeFailure}
    <ErrorState title={proposeFailure.title} message={proposeFailure.message} />
  {/if}

  {#if draft}
    <div class="scope" aria-labelledby="scope-heading">
      <h3 id="scope-heading">Proposed scope</h3>

      {#if draft.notice}
        <p class="notice" role="status">
          <Icon name="alert" size={16} />
          <span>{draft.notice}</span>
        </p>
      {/if}

      {#if stale}
        <p class="notice" role="status">
          <Icon name="alert" size={16} />
          <span>You changed the question. Propose scope again to update the records.</span>
        </p>
      {/if}

      {#if rows.length === 0}
        <EmptyState
          message="No records match that question. Describe the period or the records differently and propose again."
        />
      {:else}
        <p class="count">
          {kept.length} of {rows.length}
          {rows.length === 1 ? 'record' : 'records'} included.
        </p>
        <ul class="records" aria-label="Proposed records">
          {#each rows as row (row.item.recordId)}
            <li class:dropped={!row.keep}>
              <label class="keep">
                <input type="checkbox" bind:checked={row.keep} />
                <span class="label">{row.item.label}</span>
              </label>
              <label class="reason">
                <span class="why">Why this record</span>
                <input
                  type="text"
                  bind:value={row.reason}
                  maxlength="500"
                  disabled={!row.keep}
                  aria-label="Reason for {row.item.label}"
                />
              </label>
            </li>
          {/each}
        </ul>
      {/if}

      <div class="excluded">
        <h4>What is excluded</h4>
        <p>{draft.excluded}</p>
      </div>

      {#if requestFailure}
        <ErrorState title={requestFailure.title} message={requestFailure.message} />
      {/if}
      {#if requesting}<PendingNotice message="Sending your request to the ledger…" />{/if}

      <div class="actions">
        <Button busy={requesting} disabled={!canRequest} onclick={requestAccess}
          >Request access</Button
        >
        {#if rows.length > 0 && kept.length === 0}
          <span class="hint">Keep at least one record to request access.</span>
        {/if}
      </div>
    </div>
  {/if}
</section>

<style>
  .new {
    display: grid;
    gap: var(--space-4);
  }
  h2,
  h3,
  h4,
  p {
    margin: 0;
  }
  form {
    display: grid;
    gap: var(--space-3);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
  }
  .scope {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-4);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
  }
  .notice {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--color-neutral-bg);
    color: var(--color-neutral-text);
    border-radius: var(--radius-md);
    font-size: var(--text-13);
  }
  .count,
  .hint {
    color: var(--color-text-muted);
    font-size: var(--text-13);
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
    gap: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }
  .records li.dropped .label {
    color: var(--color-text-muted);
    text-decoration: line-through;
  }
  .keep {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-weight: 600;
  }
  .keep input {
    width: 1.125rem;
    height: 1.125rem;
    flex: none;
  }
  .reason {
    display: grid;
    gap: var(--space-1);
  }
  .why {
    color: var(--color-text-muted);
    font-size: var(--text-13);
  }
  .reason input {
    width: 100%;
    min-height: 2.25rem;
    padding: 0 var(--space-3);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }
  .reason input:disabled {
    background: var(--color-surface-sunken);
    color: var(--color-text-muted);
  }
  .excluded h4 {
    margin-bottom: var(--space-1);
  }
  .excluded p {
    color: var(--color-text-muted);
  }
</style>
