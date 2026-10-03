<script lang="ts">
  /**
   * The right-hand pane of the auditor workspace for one request: the question and the scope as
   * requested, then whatever its status allows. Pending: "Request sent" and Withdraw. Denied or
   * withdrawn: the outcome. Granted: the read-only evidence room, refetched on live `audit`
   * events and every 30 seconds; a `410 access_ended` swaps the records for "Access ended {date}".
   * Ended: the same message, and the records are gone.
   */
  import type { AuditRequestView } from '@mithra/shared';
  import { untrack } from 'svelte';
  import { getEvidence, isAccessEnded, withdrawRequest } from '$lib/api/audit';
  import { describeError } from '$lib/errors';
  import { formatDateTime, formatShortDate } from '$lib/format';
  import { createResource } from '$lib/resource.svelte';
  import { live } from '$lib/stores/live.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { debounce, poll } from '$lib/timing';
  import Button from '../Button.svelte';
  import ErrorState from '../ErrorState.svelte';
  import Icon from '../Icon.svelte';
  import Skeleton from '../Skeleton.svelte';
  import AuditStatus from './AuditStatus.svelte';
  import EvidenceRoomView from './EvidenceRoomView.svelte';
  import { endedAt } from './status';

  interface Props {
    request: AuditRequestView;
    /** The request changed on the server (withdrawn, or access ended): reload the list. */
    onchanged: () => void;
  }

  let { request, onchanged }: Props = $props();

  const grantId = $derived(request.status === 'granted' ? (request.grant?.grantId ?? null) : null);
  const evidence = createResource(() => {
    if (grantId === null) return Promise.reject(new Error('No active grant'));
    return getEvidence(grantId);
  });

  const ended = $derived(request.status === 'ended' || isAccessEnded(evidence.error));
  // A request still marked granted whose evidence answered 410 ended early (revoked): the
  // scheduled `expiresAt` is not when it ended, so no date is shown until the server's own
  // `closedAt` arrives with the reloaded request.
  const endedDate = $derived(
    request.status === 'ended' ? endedAt(request) : (request.grant?.closedAt ?? null),
  );
  let reportedEnd = false;

  $effect(() => {
    if (isAccessEnded(evidence.error) && !reportedEnd) {
      reportedEnd = true;
      onchanged();
    }
  });

  // Follows the grant: a request that is granted while this pane is open starts loading at once.
  $effect(() => {
    if (grantId === null) return;
    untrack(() => void evidence.load());
    const refresh = debounce(() => void evidence.load(), 300);
    const offs = [
      live.subscribe('audit', refresh),
      live.onReconnect(refresh),
      poll(() => void evidence.load(), 30_000),
    ];
    return () => {
      refresh.cancel();
      for (const off of offs) off();
    };
  });

  let withdrawing = $state(false);
  let withdrawFailure = $state<{ title: string; message: string } | null>(null);

  async function withdraw(): Promise<void> {
    withdrawing = true;
    withdrawFailure = null;
    try {
      await withdrawRequest(request.requestId);
      toasts.push('Request withdrawn');
      onchanged();
    } catch (e) {
      withdrawFailure = describeError(e, "Couldn't withdraw your request.");
    } finally {
      withdrawing = false;
    }
  }

  const failure = $derived(
    evidence.error && !isAccessEnded(evidence.error) && !evidence.data
      ? describeError(evidence.error, "Couldn't load the evidence room.")
      : null,
  );
</script>

<section class="panel" aria-labelledby="request-heading">
  <header>
    <h2 id="request-heading">Your request</h2>
    <p class="question">{request.question}</p>
    <p class="meta">
      <AuditStatus {request} />
      <span class="muted">Requested {formatDateTime(request.requestedAt)}</span>
    </p>
  </header>

  {#if request.status === 'pending'}
    <div class="callout" role="status">
      <Icon name="check-circle" size={18} />
      <div>
        <p><strong>Request sent</strong></p>
        <p class="muted">
          The treasurer sees the exact records below next to your question, then grants or denies
          access.
        </p>
      </div>
    </div>
    {#if withdrawFailure}
      <ErrorState title={withdrawFailure.title} message={withdrawFailure.message} />
    {/if}
    <div>
      <Button variant="secondary" busy={withdrawing} onclick={withdraw}>Withdraw request</Button>
    </div>
  {:else if request.status === 'denied'}
    <div class="callout danger" role="status">
      <Icon name="ban" size={18} />
      <div>
        <p><strong>Request denied</strong></p>
        {#if request.denial}
          <p class="muted">
            {request.denial.reason} ({formatShortDate(request.denial.at)})
          </p>
        {/if}
      </div>
    </div>
  {:else if request.status === 'withdrawn'}
    <p class="muted">You withdrew this request. No records were shared.</p>
  {/if}

  {#if ended}
    <div class="callout danger" role="status">
      <Icon name="key-off" size={18} />
      <div>
        <p><strong>Access ended{endedDate ? ` ${formatShortDate(endedDate)}` : ''}</strong></p>
        <p class="muted">
          {isAccessEnded(evidence.error)
            ? evidence.error.message
            : 'The shared records are no longer available to you.'}
        </p>
      </div>
    </div>
  {:else if grantId !== null}
    {#if evidence.loading}
      <Skeleton shape="block" height="14rem" label="Loading the evidence room" />
    {:else if failure}
      <ErrorState
        title={failure.title}
        message={failure.message}
        onretry={() => void evidence.load()}
      />
    {:else if evidence.data}
      <EvidenceRoomView room={evidence.data} />
    {/if}
  {/if}

  <section class="scope" aria-labelledby="scope-requested-heading">
    <h3 id="scope-requested-heading">Records you asked for</h3>
    <ul>
      {#each request.scope as item (item.recordId)}
        <li>
          <strong>{item.label}</strong>
          <span class="muted">{item.reason}</span>
        </li>
      {/each}
    </ul>
    <p class="muted">{request.excluded}</p>
  </section>
</section>

<style>
  .panel {
    display: grid;
    gap: var(--space-4);
    min-width: 0;
  }
  h2,
  h3,
  p {
    margin: 0;
  }
  header {
    display: grid;
    gap: var(--space-2);
  }
  .question {
    font-family: var(--font-serif);
    font-size: var(--text-18);
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
  }
  .muted {
    color: var(--color-text-muted);
    font-size: var(--text-13);
  }
  .callout {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: var(--color-success-bg);
    color: var(--color-success-text);
    border-radius: var(--radius-md);
  }
  .callout.danger {
    background: var(--color-danger-bg);
    color: var(--color-danger-text);
  }
  .callout .muted {
    color: inherit;
  }
  .scope ul {
    display: grid;
    gap: var(--space-2);
    margin: var(--space-2) 0;
    padding: 0;
    list-style: none;
    max-width: none;
  }
  .scope li {
    display: grid;
    gap: var(--space-1);
  }
</style>
