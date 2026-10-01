<script lang="ts">
  /**
   * Garnet warning shown when the balance is below the next total plus fees (P5), with "Add funds".
   * The numbers come from the server; nothing is calculated here.
   */
  import Amount from '../Amount.svelte';
  import Button from '../Button.svelte';
  import Icon from '../Icon.svelte';
  import AddFundsDialog from './AddFundsDialog.svelte';

  interface Props {
    balance: string;
    required: string;
    /** Reload the page's data after funds were added. */
    onfunded: () => void;
    /** Heading text, for example for a blocked cycle. */
    title?: string;
    /** What needs the money, e.g. "The next distribution" or "This distribution". */
    what?: string;
  }

  let {
    balance,
    required,
    onfunded,
    title = 'The treasury balance is too low.',
    what = 'The next distribution',
  }: Props = $props();

  let open = $state(false);
</script>

<section class="warning" role="alert" aria-label="Low balance">
  <Icon name="alert" size={20} />
  <div class="body">
    <p class="title"><strong>{title}</strong></p>
    <p>
      The balance is <Amount value={balance} />. {what} needs
      <Amount value={required} /> including fees. Add funds before it runs.
    </p>
    <Button variant="secondary" onclick={() => (open = true)}>Add funds</Button>
  </div>
</section>

{#if open}
  <AddFundsDialog {required} onclose={() => (open = false)} ondone={onfunded} />
{/if}

<style>
  .warning {
    display: flex;
    gap: var(--space-3);
    padding: var(--space-4);
    margin-bottom: var(--space-4);
    background: var(--color-danger-bg);
    color: var(--color-danger-text);
    border: 1px solid var(--color-danger);
    border-radius: var(--radius-md);
  }
  .warning :global(svg) {
    flex: none;
    margin-top: 0.1rem;
  }
  .body {
    min-width: 0;
  }
  p {
    margin: 0 0 var(--space-2);
  }
  .title {
    font-size: var(--text-15);
  }
</style>
