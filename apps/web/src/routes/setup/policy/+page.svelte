<script lang="ts">
  /**
   * Setup step 2: the policy, drafted by the agent (userflow 4). One prompt box; the structured
   * policy card sits beside the plain-English summary. Every field is editable in place: edits
   * are saved to the draft after 400 ms and the summary shown is always the server's, recomputed
   * from the saved fields. Nothing here is applied: only sealing the mandate does that (A1).
   */
  import { onMount } from 'svelte';
  import type { PartyRef, PolicyDraft } from '@mithra/shared';
  import { draftPolicy, getOrg, getPolicyDraft, updatePolicyDraft } from '$lib/api/treasury';
  import Button from '$lib/components/Button.svelte';
  import ErrorState from '$lib/components/ErrorState.svelte';
  import Field from '$lib/components/Field.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import PendingNotice from '$lib/components/PendingNotice.svelte';
  import PolicyEditor from '$lib/components/treasury/PolicyEditor.svelte';
  import Skeleton from '$lib/components/Skeleton.svelte';
  import { describeError, type ErrorCopy } from '$lib/errors';
  import { navigate } from '$lib/nav';
  import { parseForm, toForm, type PolicyForm } from '$lib/policyForm';
  import { debounce } from '$lib/timing';

  const EXAMPLE =
    'Pay monthly yield on the 1st. Auto-pay if the total is under 5,000 CC and nothing looks off. Otherwise 2 of 3 approvals.';
  const SAVE_DELAY_MS = 400;

  let draft = $state<PolicyDraft | null>(null);
  let form = $state<PolicyForm | null>(null);
  let approvers = $state<PartyRef[]>([]);
  let loading = $state(true);
  let loadError = $state<unknown>(null);

  let prompt = $state('');
  let lastPrompt = $state<string | null>(null);
  let drafting = $state(false);
  let draftFailure = $state<ErrorCopy | null>(null);
  let saving = $state(false);
  let saveFailure = $state<ErrorCopy | null>(null);
  let leaving = $state(false);

  let saveSeq = 0;
  /** True while an edit has not been saved yet. */
  let dirty = false;
  let inflight: Promise<void> | null = null;

  const parsed = $derived(form && draft ? parseForm(form, draft.fields.approvers) : null);
  const errors = $derived(parsed?.errors ?? {});
  const hasErrors = $derived(parsed !== null && parsed.errors !== null);
  const approverNames = $derived(
    draft
      ? draft.fields.approvers.map(
          (id) => approvers.find((a) => a.partyId === id)?.displayName ?? id,
        )
      : [],
  );

  function save(): Promise<void> {
    if (!form || !draft) return Promise.resolve();
    const result = parseForm(form, draft.fields.approvers);
    if (!result.fields) return Promise.resolve();
    const fields = result.fields;
    const mine = ++saveSeq;
    dirty = false;
    saving = true;
    saveFailure = null;
    const run = (async () => {
      try {
        const updated = await updatePolicyDraft(fields);
        // Only the newest save counts, and only the server's summary is shown (never a local one).
        if (mine === saveSeq) draft = updated;
      } catch (e) {
        if (mine === saveSeq) {
          saveFailure = describeError(e, "Couldn't save your edit.");
          dirty = true;
        }
      } finally {
        if (mine === saveSeq) saving = false;
      }
    })();
    inflight = run;
    return run;
  }

  const scheduleSave = debounce(() => void save(), SAVE_DELAY_MS);

  function onEdit(): void {
    dirty = true;
    scheduleSave();
  }

  /** Saves an edit that is still waiting for its 400 ms, and waits for a save in flight. */
  async function flush(): Promise<void> {
    scheduleSave.cancel();
    if (dirty) await save();
    else if (inflight) await inflight;
  }

  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    try {
      const [existing, org] = await Promise.all([getPolicyDraft(), getOrg().catch(() => null)]);
      approvers = org?.organization?.approvers ?? [];
      draft = existing;
      form = existing ? toForm(existing.fields) : null;
    } catch (e) {
      loadError = e;
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
    return () => scheduleSave.cancel();
  });

  async function ask(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || drafting) return;
    drafting = true;
    draftFailure = null;
    try {
      await flush();
      const next = await draftPolicy(text);
      saveSeq++;
      dirty = false;
      draft = next;
      form = toForm(next.fields);
      lastPrompt = text;
      prompt = '';
    } catch (e) {
      draftFailure = describeError(e, "The agent couldn't draft a policy.");
    } finally {
      drafting = false;
    }
  }

  async function review(): Promise<void> {
    if (!draft || hasErrors) return;
    leaving = true;
    try {
      await flush();
      if (saveFailure) return;
      await navigate('/setup/mandate');
    } finally {
      leaving = false;
    }
  }

  const SOURCE = {
    agent: 'Drafted by the agent from your description.',
    edited: 'Edited by you.',
    'current-mandate': 'Started from your current mandate.',
  } as const;
</script>

<svelte:head>
  <title>Policy · Set up · Mithra</title>
</svelte:head>

<PageHeader
  title="Policy"
  description="Describe how yield should be paid. The agent drafts the policy and you review it."
/>

<form class="ask" onsubmit={ask}>
  <Field
    label="Describe your policy"
    hint="Keep chatting to adjust it, for example “make the cap 3,000”."
  >
    {#snippet control(attrs)}
      <textarea {...attrs} bind:value={prompt} rows="3" placeholder={EXAMPLE}></textarea>
    {/snippet}
  </Field>
  <Button type="submit" busy={drafting} disabled={prompt.trim() === ''}>Ask the agent</Button>
</form>

{#if draftFailure}
  <ErrorState title={draftFailure.title} message={draftFailure.message} />
{/if}

{#if loading}
  <Skeleton shape="block" height="18rem" label="Loading your policy draft" />
{:else if loadError && !draft}
  {@const copy = describeError(loadError, "Couldn't load your policy draft.")}
  <ErrorState title={copy.title} message={copy.message} onretry={load} />
{:else if drafting && !draft}
  <Skeleton shape="block" height="18rem" label="The agent is drafting your policy" />
{:else if draft && form}
  <div class="layout" aria-busy={drafting}>
    <div class="card-col">
      {#if drafting}<PendingNotice message="The agent is redrafting your policy…" />{/if}
      <PolicyEditor
        bind:form
        {errors}
        approverCount={draft.fields.approvers.length}
        oninput={onEdit}
      />
    </div>
    <aside class="summary" aria-labelledby="summary-title">
      <h2 id="summary-title">In plain English</h2>
      <p class="text" aria-live="polite">{draft.summary}</p>
      <p class="meta">
        {#if saving}
          <Icon name="spinner" size={14} spin /> Updating the summary…
        {:else if saveFailure}
          <Icon name="alert" size={14} /> {saveFailure.title} {saveFailure.message}
        {:else}
          {SOURCE[draft.source]}
        {/if}
      </p>
      {#if lastPrompt}<p class="meta">You asked: “{lastPrompt}”</p>{/if}
      <p class="meta">
        Approvers: {approverNames.join(', ')}.
      </p>
      <p class="meta">Nothing is applied until you seal the mandate.</p>
      <Button onclick={review} busy={leaving} disabled={hasErrors || drafting}
        >Review mandate</Button
      >
      {#if hasErrors}
        <p class="meta warn">Fix the highlighted fields to continue.</p>
      {/if}
    </aside>
  </div>
{:else}
  <p class="empty">
    No policy yet. Describe how yield should be paid above and the agent drafts it; you can edit
    every field before you review.
  </p>
{/if}

<style>
  .ask {
    max-width: 40rem;
    margin-bottom: var(--space-5);
  }
  .ask :global(.field) {
    max-width: none;
  }
  .layout {
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
    gap: var(--space-5);
    align-items: start;
  }
  .summary {
    position: sticky;
    top: var(--space-4);
    padding: var(--space-4);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }
  .summary h2 {
    font-size: var(--text-18);
  }
  .text {
    font-size: var(--text-15);
  }
  .meta {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    color: var(--color-text-muted);
    font-size: var(--text-13);
  }
  .warn {
    color: var(--color-danger-text);
  }
  .empty {
    color: var(--color-text-muted);
  }
  @media (max-width: 800px) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
    }
    .summary {
      position: static;
      order: -1;
    }
  }
</style>
