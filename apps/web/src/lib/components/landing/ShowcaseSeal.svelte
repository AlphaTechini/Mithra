<script lang="ts">
  /**
   * The landing page's live seal (userflow section 2): the seal closing on the latest approved
   * distribution of this ledger, read from the aggregate-only `GET /api/public/showcase`. When
   * there is none (or the backend cannot be reached) it replays a clearly labelled example
   * instead, so a first-time visitor still sees what a seal is. The replay plays once on load and
   * again on request; with reduced motion the seal simply shows its final state.
   *
   * The signature count here is a demonstration of a finished record, so it is stepped by this
   * component on purpose; the app's real seals only ever show what the ledger reports.
   */
  import { ShowcaseSchema, type Showcase } from '@mithra/shared';
  import { onMount } from 'svelte';
  import { apiGet } from '$lib/api/client';
  import { formatAmount } from '$lib/format';
  import Button from '../Button.svelte';
  import Icon from '../Icon.svelte';
  import Seal from '../Seal.svelte';
  import Skeleton from '../Skeleton.svelte';

  type Distribution = NonNullable<Showcase>;

  /** What the example replays: the demo story's flagged cycle (docs/demo-script.md). */
  const EXAMPLE: Distribution = {
    cycleLabel: 'September 2026',
    total: '1200',
    assetSymbol: 'CC',
    payees: 4,
    approvals: { have: 2, need: 2, approvers: 3 },
  };

  const STEP_MS = 700;

  let distribution = $state<Distribution | null>(null);
  let live = $state(false);
  let signed = $state(0);
  let reduced = $state(false);
  let timers: ReturnType<typeof setTimeout>[] = [];

  const sentence = $derived.by(() => {
    if (!distribution) return '';
    const { cycleLabel, total, assetSymbol, payees, approvals } = distribution;
    const amount = formatAmount(total).replace(/\.00$/, '');
    return `${cycleLabel}, ${amount} ${assetSymbol} to ${payees} ${payees === 1 ? 'holder' : 'holders'}, approved ${approvals.have} of ${approvals.approvers}`;
  });
  const sealLabel = $derived(
    distribution
      ? `Approved ${distribution.approvals.have} of ${distribution.approvals.approvers}`
      : '',
  );

  function stop(): void {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
  }

  function play(): void {
    stop();
    if (!distribution) return;
    const { need } = distribution.approvals;
    if (reduced) {
      signed = need;
      return;
    }
    signed = 0;
    for (let i = 1; i <= need; i += 1) {
      timers.push(setTimeout(() => (signed = i), 500 + i * STEP_MS));
    }
  }

  onMount(() => {
    reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let cancelled = false;
    void (async () => {
      let found: Showcase = null;
      try {
        found = await apiGet('/public/showcase', ShowcaseSchema);
      } catch {
        // No answer is the same as no record: the example is shown, and labelled as one.
      }
      if (cancelled) return;
      live = found !== null;
      distribution = found ?? EXAMPLE;
      play();
    })();
    return () => {
      cancelled = true;
      stop();
    };
  });
</script>

<div class="showcase" aria-labelledby="showcase-heading">
  <h2 id="showcase-heading" class="sr-only">A distribution being sealed</h2>
  {#if distribution}
    <Seal required={distribution.approvals.need} {signed} label={sealLabel} size="lg" />
    <p class="sentence">{sentence}</p>
    <p class="source">
      {#if live}
        <Icon name="check-circle" size={16} />
        <span>Latest approved distribution on this ledger</span>
      {:else}
        <Icon name="flask" size={16} />
        <span
          ><strong>Example.</strong> A demo replay: nothing has been approved on this ledger yet.</span
        >
      {/if}
    </p>
    {#if !reduced}
      <Button variant="quiet" small onclick={play}>Replay the seal</Button>
    {/if}
  {:else}
    <Skeleton shape="block" height="12rem" label="Loading the seal" />
  {/if}
</div>

<style>
  .showcase {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-5);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    text-align: center;
  }
  .showcase > :global(.skeleton) {
    width: 100%;
  }
  .sentence {
    margin: 0;
    font-family: var(--font-serif);
    font-size: var(--text-18);
    font-variant-numeric: tabular-nums lining-nums;
  }
  .source {
    display: flex;
    align-items: flex-start;
    justify-content: center;
    gap: var(--space-2);
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--text-13);
    text-align: left;
  }
  .source :global(svg) {
    flex: none;
    margin-top: 0.15rem;
  }
</style>
