<script lang="ts">
  /** Unknown party: set up a treasury, or open an invitation with a code (userflow section 3). */
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { onMount } from 'svelte';
  import Button from '$lib/components/Button.svelte';
  import PartyBar from '$lib/components/PartyBar.svelte';
  import SessionGate from '$lib/components/SessionGate.svelte';
  import { navigate } from '$lib/nav';
  import { homeFor } from '$lib/routing';
  import { sessionStore } from '$lib/stores/session.svelte';

  let code = $state('');

  onMount(() => {
    void sessionStore.load();
  });

  // A party that already has a role does not belong here.
  $effect(() => {
    const role = sessionStore.party?.primaryRole;
    if (role) void navigate(homeFor(role), { replaceState: true });
  });

  function openInvite(event: SubmitEvent): void {
    event.preventDefault();
    const trimmed = code.trim();
    if (trimmed) void goto(resolve('/invite/[code]', { code: trimmed }));
  }
</script>

<svelte:head>
  <title>Get started · Mithra</title>
</svelte:head>

<SessionGate allow="any">
  <header class="top">
    <a class="brand" href={resolve('/')}>Mithra</a>
    <PartyBar />
  </header>
  <main id="main" tabindex="-1">
    <h1>How are you joining?</h1>
    <div class="choices">
      <section aria-labelledby="treasury-heading">
        <h2 id="treasury-heading">Set up a treasury</h2>
        <p>Create your fund's organization, set its policy and seal the mandate.</p>
        <Button href="/setup/organization">Set up a treasury</Button>
      </section>
      <section aria-labelledby="invited-heading">
        <h2 id="invited-heading">I was invited</h2>
        <p>Enter the invite code from your link.</p>
        <form onsubmit={openInvite}>
          <label for="invite-code">Invite code</label>
          <input id="invite-code" bind:value={code} autocomplete="off" spellcheck="false" />
          <Button type="submit" variant="secondary" disabled={!code.trim()}>Open invitation</Button>
        </form>
      </section>
    </div>
  </main>
</SessionGate>

<style>
  .top {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-5);
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
  }
  .brand {
    font-family: var(--font-serif);
    font-size: var(--text-24);
    color: var(--color-text);
    text-decoration: none;
  }
  main {
    max-width: 52rem;
    margin: 0 auto;
    padding: var(--space-6) var(--space-4) var(--space-7);
  }
  .choices {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: var(--space-4);
  }
  section {
    padding: var(--space-5);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
  }
  form {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
  }
  label {
    font-weight: 500;
  }
  input {
    width: 100%;
    min-height: 2.5rem;
    padding: 0 var(--space-3);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }
</style>
