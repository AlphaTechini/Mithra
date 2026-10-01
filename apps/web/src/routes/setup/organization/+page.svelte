<script lang="ts">
  /** Step 1 shell. The real form (treasury name, approvers, threshold) is added later. */
  import Button from '$lib/components/Button.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
</script>

<svelte:head>
  <title>Organization · Set up · Mithra</title>
</svelte:head>

<PageHeader
  title="Organization"
  description="Name your treasury, choose its approvers and set how many must approve."
/>
<form>
  <fieldset disabled>
    <legend class="sr-only">Organization details</legend>
    <div class="field">
      <label for="org-name">Treasury name</label>
      <input id="org-name" />
    </div>
    <div class="field">
      <label for="org-asset">Base asset</label>
      <input id="org-asset" value="CC" readonly />
    </div>
    <div class="field">
      <label for="org-approvers">Approvers</label>
      <textarea id="org-approvers" rows="3"></textarea>
    </div>
    <div class="field">
      <label for="org-threshold">Approval threshold</label>
      <select id="org-threshold"><option>2 of 3</option></select>
    </div>
  </fieldset>
  <p class="note">This form isn't available in this build yet, so you can't continue from here.</p>
  <Button type="submit" disabled>Continue</Button>
</form>

<style>
  fieldset {
    margin: 0 0 var(--space-4);
    padding: 0;
    border: 0;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    max-width: 28rem;
    margin-bottom: var(--space-4);
  }
  label {
    font-weight: 500;
  }
  input,
  textarea,
  select {
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }
  :disabled {
    background: var(--color-surface-sunken);
    color: var(--color-text-muted);
  }
  .note {
    color: var(--color-text-muted);
  }
</style>
