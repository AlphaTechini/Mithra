<script lang="ts">
  /**
   * "Run cycle now": a small dialog with the period (defaults to the previous month), the total
   * (defaults to the mandate's fixed amount when there is one) and an optional record date. Left
   * empty, the server applies the mandate's record date rule and says why when it cannot proceed.
   */
  import { untrack } from 'svelte';
  import { DecimalString, type MandateView } from '@mithra/shared';
  import { runCycle } from '$lib/api/treasury';
  import { describeError } from '$lib/errors';
  import { previousMonth, todayIso } from '$lib/format';
  import { navigate } from '$lib/nav';
  import { toasts } from '$lib/stores/toasts.svelte';
  import Button from '../Button.svelte';
  import Dialog from '../Dialog.svelte';
  import ErrorState from '../ErrorState.svelte';
  import Field from '../Field.svelte';

  interface Props {
    mandate: MandateView | null;
    onclose: () => void;
  }

  let { mandate, onclose }: Props = $props();

  // Defaults are read once when the dialog opens; the fields stay editable.
  let period = $state(previousMonth());
  let total = $state(untrack(() => mandate?.terms.fixedAmount ?? ''));
  let recordDate = $state('');
  let busy = $state(false);
  let failure = $state<{ title: string; message: string } | null>(null);

  const periodError = $derived(
    /^\d{4}-(0[1-9]|1[0-2])$/.test(period) ? null : 'Choose a month, like 2026-09.',
  );
  const totalError = $derived(
    total.trim() === '' || DecimalString.safeParse(total.trim()).success
      ? null
      : 'Enter the total as a number, like 1200 or 1200.50.',
  );
  const valid = $derived(!periodError && !totalError);
  const recordRule = $derived(mandate?.terms.recordDateText ?? null);

  async function submit(event?: Event): Promise<void> {
    event?.preventDefault();
    if (!valid || busy) return;
    busy = true;
    failure = null;
    try {
      const { cycleId } = await runCycle({
        cycleId: period,
        ...(total.trim() ? { total: total.trim() } : {}),
        ...(recordDate ? { recordDate } : {}),
      });
      toasts.push('Cycle started');
      onclose();
      await navigate(`/app/cycles/${cycleId}`);
    } catch (e) {
      failure = describeError(e, "Couldn't start the cycle.");
    } finally {
      busy = false;
    }
  }
</script>

<Dialog title="Run cycle now" {onclose} initialFocus="input">
  <form onsubmit={submit}>
    <p>
      The agent snapshots holders, computes each amount, runs the checks and prepares the proposal.
      You will see it happen on the next page.
    </p>
    <Field label="Period" error={periodError} short>
      {#snippet control(attrs)}
        <input {...attrs} type="month" bind:value={period} />
      {/snippet}
    </Field>
    <Field
      label={`Total (${mandate?.terms.assetSymbol ?? 'CC'})`}
      error={totalError}
      hint={mandate?.terms.fixedAmount
        ? 'Your mandate sets a fixed amount, so it is filled in.'
        : 'Leave empty to use the amount the mandate or the agent provides.'}
      short
    >
      {#snippet control(attrs)}
        <input {...attrs} bind:value={total} inputmode="decimal" autocomplete="off" />
      {/snippet}
    </Field>
    <Field
      label="Record date"
      hint={recordRule
        ? `Left empty, the record date is: ${recordRule.toLowerCase()}.`
        : 'Left empty, the mandate decides.'}
      short
    >
      {#snippet control(attrs)}
        <input {...attrs} type="date" bind:value={recordDate} max={todayIso()} />
      {/snippet}
    </Field>
    {#if failure}<ErrorState title={failure.title} message={failure.message} />{/if}
    <button type="submit" class="sr-only" tabindex="-1" aria-hidden="true">Run cycle now</button>
  </form>
  {#snippet footer()}
    <Button variant="secondary" onclick={onclose}>Cancel</Button>
    <Button {busy} disabled={!valid} onclick={() => submit()}>Run cycle now</Button>
  {/snippet}
</Dialog>
