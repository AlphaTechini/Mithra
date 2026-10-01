<script lang="ts">
  /** Step 2 shell. The agent-drafted policy card is added later. */
  import Button from '$lib/components/Button.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
</script>

<svelte:head>
  <title>Policy · Set up · Mithra</title>
</svelte:head>

<PageHeader
  title="Policy"
  description="Describe how yield should be paid. The agent drafts the policy and you review it."
/>
<form>
  <div class="field">
    <label for="policy-prompt">Describe your policy</label>
    <textarea
      id="policy-prompt"
      rows="4"
      disabled
      placeholder="Pay monthly yield on the 1st. Auto-pay if the total is under 5,000 CC and nothing looks off. Otherwise 2 of 3 approvals."
    ></textarea>
  </div>
  <p class="note">
    The agent isn't connected in this build yet, so a policy can't be drafted here.
  </p>
  <Button type="submit" disabled>Continue</Button>
</form>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    max-width: 36rem;
    margin-bottom: var(--space-3);
  }
  label {
    font-weight: 500;
  }
  textarea {
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-surface-sunken);
    color: var(--color-text-muted);
  }
  .note {
    color: var(--color-text-muted);
  }
</style>
