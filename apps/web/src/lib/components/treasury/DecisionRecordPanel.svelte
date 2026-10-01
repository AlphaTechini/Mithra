<script lang="ts">
  /**
   * The decision record for one agent action: what triggered it, a fingerprint of every input it
   * used, the checks and their results, the memo, the verdict and the mandate version it ran
   * under. Opens as a dialog from the cycle page (or with `?record=1`).
   */
  import type { DecisionRecordView } from '@mithra/shared';
  import { formatDateTime } from '$lib/format';
  import Amount from '../Amount.svelte';
  import Dialog from '../Dialog.svelte';
  import ErrorState from '../ErrorState.svelte';
  import Skeleton from '../Skeleton.svelte';
  import CheckList from './CheckList.svelte';

  interface Props {
    /** Null while it loads. */
    record: DecisionRecordView | null;
    failure?: { title: string; message: string } | null;
    onretry?: () => void;
    onclose: () => void;
  }

  let { record, failure = null, onretry, onclose }: Props = $props();

  const TRIGGER = { schedule: 'Schedule', prompt: 'A prompt', manual: 'Run cycle now' } as const;
</script>

<Dialog title="Decision record" {onclose} wide>
  {#if failure}
    <ErrorState title={failure.title} message={failure.message} {onretry} />
  {:else if !record}
    <Skeleton shape="line" lines={4} label="Loading the decision record" />
  {:else}
    <dl class="meta">
      <dt>Trigger</dt>
      <dd>{TRIGGER[record.trigger]}: {record.triggerDetail}</dd>
      <dt>Recorded</dt>
      <dd>{formatDateTime(record.createdAt)}</dd>
      <dt>Verdict</dt>
      <dd>{record.verdict === 'within-mandate' ? 'Within mandate' : 'Needs approval'}</dd>
      <dt>Mandate</dt>
      <dd>Version {record.mandateVersion}, cap <Amount value={record.cap} /></dd>
    </dl>

    <h3>Inputs, as fingerprints</h3>
    <ul class="prints">
      {#each record.inputFingerprints as print (print.label)}
        <li><span>{print.label}</span> <code>{print.sha256}</code></li>
      {/each}
    </ul>
    {#if record.modelFingerprints.length > 0}
      <h3>Model, as fingerprints</h3>
      <ul class="prints">
        {#each record.modelFingerprints as print (print.label)}
          <li><span>{print.label}</span> <code>{print.sha256}</code></li>
        {/each}
      </ul>
    {/if}

    <h3>Checks</h3>
    <CheckList checks={record.checks} label="Checks in this record" />

    <h3>Memo</h3>
    <p class="source">{record.memoSource}</p>
    <p class="memo">{record.memo}</p>
  {/if}
</Dialog>

<style>
  h3 {
    margin-top: var(--space-4);
  }
  .meta {
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
    overflow-wrap: anywhere;
  }
  .prints {
    list-style: none;
    margin: 0;
    padding: 0;
    max-width: none;
  }
  .prints li {
    display: flex;
    flex-direction: column;
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--color-border);
  }
  code {
    overflow-wrap: anywhere;
    color: var(--color-text-muted);
    font-size: var(--text-13);
  }
  .source {
    color: var(--color-text-muted);
    font-size: var(--text-13);
    margin-bottom: var(--space-1);
  }
  .memo {
    white-space: pre-wrap;
    max-width: none;
  }
</style>
