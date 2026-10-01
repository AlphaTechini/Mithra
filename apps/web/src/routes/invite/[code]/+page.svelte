<script lang="ts">
  /**
   * Invitation (userflow 6 steps 1 and 2). Public: shows the fund and what is offered. Signed out
   * on LocalNet it points to the demo sign-in and the role switcher; on MainNet it offers
   * "Connect Grofty Wallet" (the connection itself is M10, so the button is disabled with the
   * same message as /launch). Signed in as a holder it continues to /holder/welcome.
   */
  import type { Invite } from '@mithra/shared';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { ApiError } from '$lib/api/client';
  import { fetchInvite } from '$lib/api/holder';
  import Button from '$lib/components/Button.svelte';
  import ErrorState from '$lib/components/ErrorState.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import RoleSwitcher from '$lib/components/RoleSwitcher.svelte';
  import Skeleton from '$lib/components/Skeleton.svelte';
  import { describeError } from '$lib/errors';
  import { sessionStore } from '$lib/stores/session.svelte';

  const code = $derived(page.params['code'] ?? '');

  let invite = $state<Invite | null>(null);
  let inviteError = $state<unknown>(null);
  let loading = $state(true);

  async function loadInvite(): Promise<void> {
    loading = true;
    try {
      invite = await fetchInvite(code);
      inviteError = null;
    } catch (e) {
      invite = null;
      inviteError = e;
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void sessionStore.load();
    void loadInvite();
  });

  const signedIn = $derived(sessionStore.session?.signedIn === true);
  const party = $derived(sessionStore.party);
  const isHolder = $derived(party?.roles.includes('holder') ?? false);
  const isAuditor = $derived(party?.roles.includes('auditor') ?? false);
  const notFound = $derived(inviteError instanceof ApiError && inviteError.status === 404);
  const failure = $derived(
    inviteError && !notFound ? describeError(inviteError, "Couldn't load this invitation.") : null,
  );
  const sessionFailure = $derived(
    sessionStore.status === 'error'
      ? describeError(sessionStore.error, "Mithra couldn't load your session.")
      : null,
  );
</script>

<svelte:head>
  <title>Invitation · Mithra</title>
</svelte:head>

<main id="main" tabindex="-1">
  <a class="brand" href={resolve('/')}>Mithra</a>

  {#if loading || (sessionStore.status !== 'ready' && !sessionFailure)}
    <Skeleton shape="block" height="10rem" label="Loading your invitation" />
  {:else if notFound}
    <ErrorState title="This invite link isn't valid." message="Ask the fund for a new one." />
  {:else if failure}
    <ErrorState title={failure.title} message={failure.message} onretry={loadInvite} />
  {:else if sessionFailure}
    <ErrorState
      title={sessionFailure.title}
      message={sessionFailure.message}
      onretry={() => sessionStore.refresh()}
    />
  {:else if invite}
    {#if invite.kind === 'auditor'}
      <PageHeader title="You're invited to audit {invite.orgName}." />
      <p>Open the audit workspace to ask for records. You only see what the fund grants you.</p>
    {:else}
      <PageHeader title="{invite.orgName} invited you" />
      <p>
        You're invited as a fund holder. Accept your units and turn on auto-receive so yield arrives
        without you having to accept each payment.
      </p>
    {/if}
    {#if invite.used}
      <p class="note" role="status">
        This invite has already been used. If it was yours, sign in to continue.
      </p>
    {/if}

    <section class="panel" aria-label="Continue">
      {#if invite.kind === 'auditor'}
        <Button href="/auditor">Go to the audit workspace</Button>
        {#if !signedIn || !isAuditor}
          <p class="hint">
            {#if sessionStore.network === 'mainnet'}
              Connect Grofty Wallet first.
            {:else}
              Sign in to the demo, then pick {invite.displayName} in the role switcher.
            {/if}
          </p>
        {/if}
      {:else if signedIn && isHolder}
        <p class="who">Signed in as <strong>{party?.displayName}</strong>.</p>
        <Button href="/holder/welcome">Continue</Button>
      {:else if sessionStore.network === 'mainnet'}
        <Button disabled>Connect Grofty Wallet</Button>
        <p class="hint" role="status">Grofty connection is set up in the MainNet build</p>
      {:else if signedIn}
        <p>
          You're signed in as <strong>{party?.displayName}</strong>. Pick
          <strong>{invite.displayName}</strong> in the role switcher to accept this invitation.
        </p>
        <RoleSwitcher />
      {:else}
        <p>
          Sign in to the demo, then pick <strong>{invite.displayName}</strong> in the role switcher.
        </p>
        <a class="action" href="{resolve('/launch')}?next=/invite/{encodeURIComponent(code)}"
          >Sign in to the demo</a
        >
      {/if}
    </section>
  {/if}
</main>

<style>
  main {
    max-width: 36rem;
    margin: 0 auto;
    padding: var(--space-6) var(--space-4) var(--space-7);
  }
  .brand {
    display: inline-block;
    margin-bottom: var(--space-5);
    font-family: var(--font-serif);
    font-size: var(--text-24);
    color: var(--color-text);
    text-decoration: none;
  }
  .panel {
    display: grid;
    justify-items: start;
    gap: var(--space-3);
    margin-top: var(--space-5);
    padding: var(--space-5);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
  }
  .panel p {
    margin: 0;
  }
  .hint,
  .note {
    color: var(--color-text-muted);
  }
  .action {
    display: inline-flex;
    align-items: center;
    min-height: 2.5rem;
    padding: 0 var(--space-4);
    border-radius: var(--radius-md);
    background: var(--color-primary);
    color: var(--color-on-primary);
    font-weight: 500;
    text-decoration: none;
  }
  .action:hover {
    background: var(--color-primary-hover);
  }
</style>
