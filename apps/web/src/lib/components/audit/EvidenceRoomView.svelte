<script lang="ts">
  /**
   * The auditor's evidence room (userflow 11 step 6). Read-only: no inputs, only the records the
   * treasurer shared, with the grant ring at the top and an export for working papers. Holders
   * appear only as the labels the server sent ("Holder A"); no party id is ever rendered here.
   */
  import type { EvidenceRecord, EvidenceRoom } from '@mithra/shared';
  import { exportUrl } from '$lib/api/audit';
  import { formatDateTime, formatShortDate } from '$lib/format';
  import type { TableColumn } from '$lib/types/ui';
  import Amount from '../Amount.svelte';
  import DataTable from '../DataTable.svelte';
  import EmptyState from '../EmptyState.svelte';
  import TxLink from '../holder/TxLink.svelte';
  import Icon from '../Icon.svelte';
  import Seal from '../Seal.svelte';
  import StatusChip from '../StatusChip.svelte';

  let { room }: { room: EvidenceRoom } = $props();

  type Decision = NonNullable<EvidenceRecord['decision']>;
  type Outcome = NonNullable<EvidenceRecord['outcome']>;
  type Payout = Decision['payouts'][number];
  type Payment = Outcome['payments'][number];

  const PAYOUT_COLUMNS: TableColumn[] = [
    { key: 'holderLabel', label: 'Holder' },
    { key: 'units', label: 'Units', numeric: true },
    { key: 'amount', label: 'Amount', numeric: true },
  ];
  const PAYMENT_COLUMNS: TableColumn[] = [
    { key: 'holderLabel', label: 'Holder' },
    { key: 'amount', label: 'Amount', numeric: true },
    { key: 'status', label: 'Status' },
    { key: 'link', label: 'Transaction' },
  ];
  const OUTCOME_WORD = { executed: 'Executed', rejected: 'Rejected', cancelled: 'Cancelled' };
  const OUTCOME_ICON = {
    executed: 'check-circle',
    rejected: 'x-circle',
    cancelled: 'ban',
  } as const;
</script>

<section class="room" aria-labelledby="room-heading">
  <header class="head">
    <div class="ring">
      <Seal
        required={1}
        signed={1}
        state="expiring"
        grantedAt={room.grantedAt}
        expiresAt={room.expiresAt}
        label="Access until {formatShortDate(room.expiresAt)}"
        size="md"
      />
    </div>
    <div class="intro">
      <h2 id="room-heading">Evidence room</h2>
      <p class="question"><span class="sr-only">Your question: </span>{room.question}</p>
      <dl class="dates">
        <div>
          <dt>Access granted</dt>
          <dd>{formatDateTime(room.grantedAt)}</dd>
        </div>
        <div>
          <dt>Access ends</dt>
          <dd>{formatDateTime(room.expiresAt)}</dd>
        </div>
      </dl>
      <!-- A download from the API, not an app route, so it is not resolved against the app base. -->
      <!-- eslint-disable svelte/no-navigation-without-resolve -->
      <a class="export" href={exportUrl(room.grantId)} download>
        <Icon name="audit" size={16} /> Export summary
      </a>
      <!-- eslint-enable svelte/no-navigation-without-resolve -->
      <p class="readonly">Read-only. These records disappear from your view when access ends.</p>
    </div>
  </header>

  {#if room.records.length === 0}
    <EmptyState message="The treasurer shared no records in this grant." />
  {:else}
    <ol class="records" aria-label="Shared records">
      {#each room.records as record (record.recordId)}
        {@const decision = record.decision}
        <li>
          <article class="record" aria-labelledby="rec-{record.recordId}">
            <h3 id="rec-{record.recordId}">{record.cycleLabel}</h3>

            {#if decision}
              <section aria-label="Decision record, {record.cycleLabel}">
                <h4>Decision record</h4>
                <dl class="facts">
                  <div>
                    <dt>Trigger</dt>
                    <dd>{decision.trigger}</dd>
                  </div>
                  <div>
                    <dt>Record date</dt>
                    <dd>{decision.recordDate}</dd>
                  </div>
                  <div>
                    <dt>Total</dt>
                    <dd><Amount value={decision.total} /></dd>
                  </div>
                  <div>
                    <dt>Verdict</dt>
                    <dd class="verdict" class:flag={decision.verdict === 'needs-approval'}>
                      <Icon
                        name={decision.verdict === 'needs-approval' ? 'flag' : 'shield'}
                        size={14}
                      />
                      {decision.verdict === 'needs-approval' ? 'Needs approval' : 'Within mandate'}
                    </dd>
                  </div>
                  <div>
                    <dt>Mandate</dt>
                    <dd>
                      Version {decision.mandateVersion}, cap <Amount value={decision.cap} />
                    </dd>
                  </div>
                  <div>
                    <dt>Written</dt>
                    <dd>{formatDateTime(decision.createdAt)}</dd>
                  </div>
                </dl>

                <h5>Agent's memo</h5>
                <p class="memo">{decision.memo}</p>

                <h5>Checks</h5>
                <ul class="checks" aria-label="Checks, {record.cycleLabel}">
                  {#each decision.checks as check (check.label)}
                    <li>
                      <span class="check-head">
                        <StatusChip kind={check.passed ? 'passed' : 'flagged'} />
                        <strong>{check.label}</strong>
                        {#if check.blocking}<span class="muted">(blocking)</span>{/if}
                      </span>
                      <span class="muted">
                        Actual {check.actual}, limit {check.limit}. Source: {check.source}.
                      </span>
                    </li>
                  {/each}
                </ul>

                <h5>Inputs fingerprint</h5>
                <ul class="prints" aria-label="Input fingerprints, {record.cycleLabel}">
                  {#each decision.inputFingerprints as print (print.label)}
                    <li><span>{print.label}</span> <code>{print.sha256}</code></li>
                  {/each}
                </ul>
                {#if decision.modelFingerprints.length > 0}
                  <h5>Model fingerprints</h5>
                  <ul class="prints" aria-label="Model fingerprints, {record.cycleLabel}">
                    {#each decision.modelFingerprints as print (print.label)}
                      <li><span>{print.label}</span> <code>{print.sha256}</code></li>
                    {/each}
                  </ul>
                {/if}

                <h5>Per-holder amounts</h5>
                <DataTable
                  caption="Amounts per holder, {record.cycleLabel}"
                  columns={PAYOUT_COLUMNS}
                  rows={decision.payouts}
                  rowKey={(row: Payout) => row.holderLabel}
                >
                  {#snippet cell(row: Payout, column: TableColumn)}
                    {#if column.key === 'amount'}
                      <Amount value={row.amount} />
                    {:else if column.key === 'units'}
                      {row.units.toLocaleString('en-US')}
                    {:else}
                      {row.holderLabel}
                    {/if}
                  {/snippet}
                </DataTable>
              </section>
            {/if}

            {#if record.outcome}
              {@const outcome = record.outcome}
              <section aria-label="Outcome, {record.cycleLabel}">
                <h4>Outcome</h4>
                <p class="outcome">
                  <Icon name={OUTCOME_ICON[outcome.kind]} size={16} />
                  <strong>{OUTCOME_WORD[outcome.kind]}</strong>
                  <span class="muted">{formatDateTime(outcome.at)}</span>
                </p>
                {#if outcome.reason}<p>{outcome.reason}</p>{/if}

                {#if outcome.approvals.length > 0}
                  <h5>Approvals</h5>
                  <ul class="approvals" aria-label="Approvals, {record.cycleLabel}">
                    {#each outcome.approvals as approval (approval.approverLabel + approval.at)}
                      <li>
                        <strong>{approval.approverLabel}</strong>
                        <span class="muted">{formatDateTime(approval.at)}</span>
                        {#if approval.note}<span>{approval.note}</span>{/if}
                      </li>
                    {/each}
                  </ul>
                {/if}

                {#if outcome.payments.length > 0}
                  <h5>Payments</h5>
                  <DataTable
                    caption="Payments, {record.cycleLabel}"
                    columns={PAYMENT_COLUMNS}
                    rows={outcome.payments}
                    rowKey={(row: Payment) => row.holderLabel}
                  >
                    {#snippet cell(row: Payment, column: TableColumn)}
                      {#if column.key === 'amount'}
                        <Amount value={row.amount} />
                      {:else if column.key === 'link'}
                        {#if row.link}
                          <TxLink
                            link={row.link}
                            context="{row.holderLabel}, {record.cycleLabel}"
                          />
                        {:else}
                          <span class="muted">Not yet on the ledger</span>
                        {/if}
                      {:else if column.key === 'status'}
                        {#if row.status === 'paid' || row.status === 'awaiting-acceptance'}
                          <StatusChip kind={row.status} />
                        {:else if row.status === 'awaiting-signature'}
                          <span class="plain-status"
                            ><Icon name="key" size={16} /> Awaiting signature in Grofty</span
                          >
                        {:else}
                          {row.status}
                        {/if}
                      {:else}
                        {row.holderLabel}
                      {/if}
                    {/snippet}
                  </DataTable>
                {/if}
              </section>
            {/if}
          </article>
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .plain-status {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
  }
  .room {
    display: grid;
    gap: var(--space-5);
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4) var(--space-5);
    align-items: flex-start;
    padding: var(--space-4);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
  }
  .ring {
    flex: none;
  }
  .intro {
    display: grid;
    gap: var(--space-2);
    min-width: 0;
    flex: 1 1 16rem;
  }
  h2,
  h3,
  h4,
  h5,
  p {
    margin: 0;
  }
  .question {
    font-family: var(--font-serif);
    font-size: var(--text-18);
  }
  .dates {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-5);
    margin: 0;
  }
  dt {
    color: var(--color-text-muted);
    font-size: var(--text-13);
  }
  dd {
    margin: 0;
    font-weight: 500;
  }
  .export {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    justify-self: start;
    min-height: 2.5rem;
    padding: 0 var(--space-4);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    color: var(--color-link);
    font-weight: 600;
    text-decoration: none;
  }
  .readonly,
  .muted {
    color: var(--color-text-muted);
    font-size: var(--text-13);
  }
  .records {
    display: grid;
    gap: var(--space-4);
    margin: 0;
    padding: 0;
    list-style: none;
    max-width: none;
  }
  .record {
    display: grid;
    gap: var(--space-4);
    padding: var(--space-4);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    min-width: 0;
  }
  .record section {
    display: grid;
    gap: var(--space-2);
    min-width: 0;
  }
  h4 {
    font-size: var(--text-18);
    padding-top: var(--space-2);
    border-top: 1px solid var(--color-border);
  }
  h5 {
    margin-top: var(--space-2);
    font-size: var(--text-15);
  }
  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: var(--space-3);
    margin: 0;
  }
  .verdict {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    color: var(--color-success-text);
  }
  .verdict.flag {
    color: var(--color-danger-text);
  }
  .memo {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .checks,
  .prints,
  .approvals {
    display: grid;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
    max-width: none;
  }
  .checks li,
  .approvals li {
    display: grid;
    gap: var(--space-1);
  }
  .check-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }
  .prints li {
    display: grid;
    gap: var(--space-1);
    min-width: 0;
  }
  .prints code {
    overflow-wrap: anywhere;
    color: var(--color-text-muted);
  }
  .outcome {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }
</style>
