<script lang="ts">
  /**
   * Launch and connect (userflow section 3). LocalNet: password sign-in, then the role switcher.
   * MainNet: a "Connect Grofty Wallet" panel; the real connection is a later step, here we only
   * detect whether the Grofty SDK can find the extension.
   */
  import { resolve } from '$app/paths';
  import { createGroftyClient } from '@groftylabs/dapp-sdk';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import type { Pathname } from '$app/types';
  import { ApiError } from '$lib/api/client';
  import Button from '$lib/components/Button.svelte';
  import ErrorState from '$lib/components/ErrorState.svelte';
  import PartyId from '$lib/components/PartyId.svelte';
  import RoleSwitcher from '$lib/components/RoleSwitcher.svelte';
  import Skeleton from '$lib/components/Skeleton.svelte';
  import { describeError } from '$lib/errors';
  import { navigate } from '$lib/nav';
  import { homeFor, localnetHomeFor } from '$lib/routing';
  import { sessionStore } from '$lib/stores/session.svelte';

  let password = $state('');
  let signingIn = $state(false);
  let signInError = $state<string | null>(null);
  let retrying = $state(false);
  let groftyState = $state<'looking' | 'found' | 'missing'>('looking');

  const signedIn = $derived(sessionStore.session?.signedIn === true);
  const party = $derived(sessionStore.party);

  /**
   * `?next=<path>`: where to go after choosing a party (the invite page sends people here with
   * `/invite/<code>`). Only same-site paths count: it must start with a single `/`, so
   * `//evil.example` and `https://evil.example` are ignored.
   */
  const next = $derived.by((): Pathname | null => {
    const value = page.url.searchParams.get('next');
    if (value === null || !value.startsWith('/') || value.startsWith('//')) return null;
    if (value.includes('\\')) return null;
    // The parsed URL must stay on this origin.
    try {
      const parsed = new URL(value, 'http://same.site');
      if (parsed.origin !== 'http://same.site') return null;
    } catch {
      return null;
    }
    return value as Pathname; // Not a typed route (it carries a code), so the cast is deliberate.
  });
  const destination = $derived(
    next ??
      (sessionStore.network === 'localnet'
        ? localnetHomeFor(party)
        : homeFor(party?.primaryRole ?? null)),
  );

  onMount(() => {
    void sessionStore.load();
  });

  // On MainNet a visitor who already has a session goes straight to their home.
  $effect(() => {
    if (sessionStore.network === 'mainnet' && signedIn) {
      void navigate(destination, { replaceState: true });
    }
  });

  // Only MainNet needs the wallet, so look for it once the network is known.
  $effect(() => {
    if (sessionStore.network !== 'mainnet') return;
    let cancelled = false;
    void createGroftyClient({ discoveryTimeoutMs: 1500 })
      .then((client) => {
        if (!cancelled) groftyState = client ? 'found' : 'missing';
      })
      .catch(() => {
        if (!cancelled) groftyState = 'missing';
      });
    return () => {
      cancelled = true;
    };
  });

  async function retry(): Promise<void> {
    retrying = true;
    await sessionStore.refresh();
    retrying = false;
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!password || signingIn) return;
    signingIn = true;
    signInError = null;
    try {
      await sessionStore.signIn(password);
      password = '';
    } catch (e) {
      const copy = describeError(e, "Couldn't sign you in.");
      signInError =
        e instanceof ApiError && (e.status === 401 || e.status === 403)
          ? 'That password did not match. Check it and try again.'
          : `${copy.title} ${copy.message}`;
    } finally {
      signingIn = false;
    }
  }
</script>

<svelte:head>
  <title>Launch app · Mithra</title>
</svelte:head>

<main id="main" tabindex="-1">
  <a class="back" href={resolve('/')}>Mithra</a>
  <h1>Launch app</h1>

  {#if sessionStore.status === 'error'}
    {@const copy = describeError(sessionStore.error, "Mithra couldn't load.")}
    <ErrorState title={copy.title} message={copy.message} onretry={retry} {retrying} />
  {:else if sessionStore.status !== 'ready'}
    <Skeleton shape="block" height="10rem" label="Loading" />
  {:else if sessionStore.network === 'localnet'}
    <section class="panel" aria-labelledby="signin-heading">
      {#if !signedIn}
        <h2 id="signin-heading">Sign in to LocalNet</h2>
        <p>
          LocalNet has no wallet, so Mithra signs for you on the server. Enter the LocalNet password
          to continue.
        </p>
        <form onsubmit={submit}>
          <label for="password">Password</label>
          <input
            id="password"
            type="password"
            autocomplete="current-password"
            bind:value={password}
            aria-describedby={signInError ? 'signin-error' : undefined}
            aria-invalid={signInError ? 'true' : undefined}
            required
          />
          {#if signInError}<p id="signin-error" class="field-error" role="alert">
              {signInError}
            </p>{/if}
          <Button type="submit" busy={signingIn} disabled={!password}>Sign in</Button>
        </form>
      {:else}
        <h2 id="signin-heading">Choose who to act as</h2>
        <p>
          Pick a demo party. Mithra opens the screens for that party's role, and you can switch
          again at any time from the header.
        </p>
        <RoleSwitcher {next} />
        {#if party}
          <p class="current">
            Signed in as <strong>{party.displayName}</strong>
            <PartyId partyId={party.partyId} />
          </p>
          <Button href={destination}>Continue as {party.displayName}</Button>
        {/if}
      {/if}
    </section>
  {:else}
    <section class="panel" aria-labelledby="grofty-heading">
      <h2 id="grofty-heading">Connect Grofty Wallet</h2>
      <p>
        On MainNet you sign with Grofty Wallet, a browser extension for Canton. Install it, unlock
        it, then come back to this page and connect.
      </p>
      <p>
        <a href="https://grofty.cc" target="_blank" rel="noreferrer noopener"
          >How to install Grofty Wallet</a
        >
      </p>
      {#if groftyState === 'looking'}
        <Button disabled>Looking for Grofty Wallet…</Button>
      {:else if groftyState === 'missing'}
        <Button disabled>Connect Grofty Wallet</Button>
        <p class="note" role="status">Grofty connection is set up in the MainNet build</p>
      {:else}
        <Button disabled>Connect Grofty Wallet</Button>
        <p class="note" role="status">
          Grofty Wallet is installed. Connecting with it is not switched on in this build yet.
        </p>
      {/if}
    </section>
  {/if}
</main>

<style>
  main {
    max-width: 32rem;
    margin: 0 auto;
    padding: var(--space-6) var(--space-4) var(--space-7);
  }
  .back {
    display: inline-block;
    margin-bottom: var(--space-5);
    font-family: var(--font-serif);
    font-size: var(--text-24);
    text-decoration: none;
    color: var(--color-text);
  }
  .panel {
    padding: var(--space-5);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
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
  .field-error {
    margin: 0;
    color: var(--color-danger-text);
  }
  .current,
  .note {
    margin-top: var(--space-4);
    color: var(--color-text-muted);
  }
</style>
