<script lang="ts">
  /**
   * The Agent page: the whole conversation with the agent, its suggestions and every tool call as
   * an action card with a link to what it touched (A10). The same conversation also lives in the
   * agent panel, which opens from any screen.
   */
  import { onMount } from 'svelte';
  import AgentComposer from '$lib/components/AgentComposer.svelte';
  import AgentTranscript from '$lib/components/AgentTranscript.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Skeleton from '$lib/components/Skeleton.svelte';
  import { agentStore } from '$lib/stores/agent.svelte';

  onMount(() => {
    void agentStore.load();
  });
</script>

<svelte:head>
  <title>Agent · Mithra</title>
</svelte:head>

<PageHeader
  title="Agent"
  description="Work with the agent: drafts, distributions, explanations and what it has done."
/>

<div class="chat">
  {#if agentStore.loading}
    <Skeleton shape="line" lines={4} label="Loading the conversation" />
  {:else}
    <AgentTranscript
      messages={agentStore.rows}
      busy={agentStore.busy}
      error={agentStore.error}
      onretry={() => void agentStore.retry()}
      hint="No conversations yet. Ask the agent to prepare a distribution, explain a flag or find a payment, and what it does is listed here as cards."
      label="Conversation with the agent"
    />
  {/if}
  <div class="composer">
    <AgentComposer
      suggestions={agentStore.suggestions}
      busy={agentStore.busy}
      onsend={(text: string) => void agentStore.send(text)}
    />
  </div>
</div>

<style>
  .chat {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    max-width: 44rem;
  }
  .composer {
    padding-top: var(--space-3);
    border-top: 1px solid var(--color-border);
  }
</style>
