<script lang="ts">
  /**
   * The structured policy card: every field of the draft, editable in place. The parent owns the
   * form values and the validation errors; every edit calls `oninput` so the parent can save the
   * draft and show the server's summary. Nothing here applies a policy: sealing does (A1).
   */
  import {
    COMMON_SCHEDULES,
    RECORD_DATE_RULES,
    type PolicyForm,
    type PolicyFormErrors,
  } from '$lib/policyForm';
  import Field from '../Field.svelte';

  interface Props {
    form: PolicyForm;
    errors: PolicyFormErrors;
    approverCount: number;
    oninput: () => void;
  }

  let { form = $bindable(), errors, approverCount, oninput }: Props = $props();

  const CUSTOM = 'custom';
  const scheduleChoice = $derived(
    COMMON_SCHEDULES.find((s) => s.cron === form.scheduleCron.trim())?.cron ?? CUSTOM,
  );

  function chooseSchedule(value: string): void {
    if (value !== CUSTOM) {
      form.scheduleCron = value;
      oninput();
    }
  }
</script>

<form class="card" onsubmit={(e) => e.preventDefault()} aria-label="Policy">
  <fieldset>
    <legend>Schedule</legend>
    <Field label="How often">
      {#snippet control(attrs)}
        <select
          {...attrs}
          value={scheduleChoice}
          onchange={(e) => chooseSchedule(e.currentTarget.value)}
        >
          {#each COMMON_SCHEDULES as schedule (schedule.cron)}
            <option value={schedule.cron}>{schedule.label}</option>
          {/each}
          <option value={CUSTOM}>Custom schedule</option>
        </select>
      {/snippet}
    </Field>
    <div class="pair">
      <Field
        label="Cron expression"
        error={errors.scheduleCron ?? null}
        hint="Minute, hour, day, month, weekday."
      >
        {#snippet control(attrs)}
          <input
            {...attrs}
            bind:value={form.scheduleCron}
            {oninput}
            autocomplete="off"
            spellcheck="false"
          />
        {/snippet}
      </Field>
      <Field label="Time zone" error={errors.scheduleTimezone ?? null}>
        {#snippet control(attrs)}
          <input {...attrs} bind:value={form.scheduleTimezone} {oninput} autocomplete="off" />
        {/snippet}
      </Field>
    </div>
    <Field label="Record date">
      {#snippet control(attrs)}
        <select {...attrs} bind:value={form.recordDateRule} onchange={oninput}>
          {#each RECORD_DATE_RULES as rule (rule.value)}
            <option value={rule.value}>{rule.label}</option>
          {/each}
        </select>
      {/snippet}
    </Field>
  </fieldset>

  <fieldset>
    <legend>Limits</legend>
    <div class="pair">
      <Field
        label="Auto-execute cap (CC)"
        error={errors.cap ?? null}
        hint="Above this the agent needs approvals."
      >
        {#snippet control(attrs)}
          <input
            {...attrs}
            bind:value={form.cap}
            {oninput}
            inputmode="decimal"
            autocomplete="off"
          />
        {/snippet}
      </Field>
      <Field
        label="Approvals needed"
        error={errors.approvalThreshold ?? null}
        hint={`Out of ${approverCount} approver${approverCount === 1 ? '' : 's'}.`}
      >
        {#snippet control(attrs)}
          <input
            {...attrs}
            bind:value={form.approvalThreshold}
            {oninput}
            inputmode="numeric"
            autocomplete="off"
          />
        {/snippet}
      </Field>
    </div>
    <div class="pair">
      <Field
        label="Fixed amount (CC)"
        error={errors.fixedAmount ?? null}
        hint="Optional. Leave empty if the total changes each cycle."
      >
        {#snippet control(attrs)}
          <input
            {...attrs}
            bind:value={form.fixedAmount}
            {oninput}
            inputmode="decimal"
            autocomplete="off"
          />
        {/snippet}
      </Field>
      <Field
        label="Fee buffer (CC)"
        error={errors.feeBuffer ?? null}
        hint="Kept back for network fees."
      >
        {#snippet control(attrs)}
          <input
            {...attrs}
            bind:value={form.feeBuffer}
            {oninput}
            inputmode="decimal"
            autocomplete="off"
          />
        {/snippet}
      </Field>
    </div>
  </fieldset>

  <fieldset>
    <legend>Flag if</legend>
    <div class="pair">
      <Field
        label="Total deviates by more than (%)"
        error={errors.deviationPct ?? null}
        hint="Compared with the trailing average."
      >
        {#snippet control(attrs)}
          <input
            {...attrs}
            bind:value={form.deviationPct}
            {oninput}
            inputmode="decimal"
            autocomplete="off"
          />
        {/snippet}
      </Field>
      <Field
        label="Trailing cycles"
        error={errors.trailingCycles ?? null}
        hint="Cycles in the average."
      >
        {#snippet control(attrs)}
          <input
            {...attrs}
            bind:value={form.trailingCycles}
            {oninput}
            inputmode="numeric"
            autocomplete="off"
          />
        {/snippet}
      </Field>
    </div>
    <div class="pair">
      <Field label="A holder's units change by more than (%)" error={errors.unitChangePct ?? null}>
        {#snippet control(attrs)}
          <input
            {...attrs}
            bind:value={form.unitChangePct}
            {oninput}
            inputmode="decimal"
            autocomplete="off"
          />
        {/snippet}
      </Field>
      <Field
        label="In the days before the record date"
        error={errors.unitChangeWindowDays ?? null}
        hint="Number of days."
      >
        {#snippet control(attrs)}
          <input
            {...attrs}
            bind:value={form.unitChangeWindowDays}
            {oninput}
            inputmode="numeric"
            autocomplete="off"
          />
        {/snippet}
      </Field>
    </div>
  </fieldset>
</form>

<style>
  .card {
    padding: var(--space-4);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }
  fieldset {
    margin: 0 0 var(--space-3);
    padding: 0;
    border: 0;
    min-width: 0;
  }
  legend {
    margin-bottom: var(--space-2);
    padding: 0;
    font-family: var(--font-serif);
    font-size: var(--text-18);
    font-weight: 500;
  }
  .pair {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0 var(--space-4);
  }
  .pair :global(.field) {
    max-width: none;
  }
  @media (max-width: 600px) {
    .pair {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
