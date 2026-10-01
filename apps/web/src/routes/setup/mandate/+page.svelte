<script lang="ts">
  /**
   * Step 3 shell: the statement of what the agent can and cannot do, and a one-segment seal ring
   * for the treasurer. Sealing itself is added later, so the button is disabled.
   */
  import Button from '$lib/components/Button.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Seal from '$lib/components/Seal.svelte';
</script>

<svelte:head>
  <title>Seal the mandate · Set up · Mithra</title>
</svelte:head>

<PageHeader
  title="Seal the mandate"
  description="The mandate is your signed grant of authority to the agent. Changing it later needs a new signature."
/>
<div class="columns">
  <section aria-labelledby="can">
    <h2 id="can">The agent can</h2>
    <ul>
      <li>Prepare each distribution and run its checks.</li>
      <li>
        Pay automatically when the total is within your cap and every payee held units on the record
        date.
      </li>
      <li>Create a proposal that needs approvals when a check raises a flag.</li>
      <li>Explain its work and draft audit scopes.</li>
    </ul>
  </section>
  <section aria-labelledby="cannot">
    <h2 id="cannot">The agent cannot</h2>
    <ul>
      <li>Move money outside the mandate, however it is prompted.</li>
      <li>Sign a mandate, approve a proposal or approve an audit request.</li>
      <li>Clear a flag raised by a check.</li>
      <li>Show one holder's data to another holder or to an auditor without a grant.</li>
    </ul>
  </section>
</div>
<div class="seal-row">
  <Seal required={1} signed={0} label="Waiting for the treasurer" />
  <div>
    <p class="note">
      This step isn't available in this build yet, so the mandate can't be sealed here.
    </p>
    <Button disabled>Seal mandate</Button>
  </div>
</div>

<style>
  .columns {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: var(--space-4);
    margin-bottom: var(--space-6);
  }
  section {
    padding: var(--space-4) var(--space-5);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
  }
  ul {
    margin: 0;
  }
  .seal-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-5);
  }
  .note {
    color: var(--color-text-muted);
  }
</style>
