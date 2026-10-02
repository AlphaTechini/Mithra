<script lang="ts">
  /**
   * The landing page (userflow section 2): the headline, the live seal replay, Launch app and the
   * demo video, then three sections only: the problem in three sourced numbers, how it works as a
   * real sequence, and why Canton. The footer has the network badge and the GitHub link.
   */
  import { onMount } from 'svelte';
  import Button from '$lib/components/Button.svelte';
  import ShowcaseSeal from '$lib/components/landing/ShowcaseSeal.svelte';
  import NetworkBadge from '$lib/components/NetworkBadge.svelte';
  import { sessionStore } from '$lib/stores/session.svelte';

  const GITHUB_URL = 'https://github.com/AlphaTechini/Mithra';

  onMount(() => {
    void sessionStore.load();
  });

  /** Set by the deployment (`DEMO_VIDEO_URL`); the button is hidden until there is a video. */
  const demoVideoUrl = $derived(sessionStore.config?.demoVideoUrl ?? null);

  const NUMBERS = [
    {
      figure: '88%',
      text: 'of US companies report problems in their payment operations, and 98% still do some payment work by hand.',
      source: 'Modern Treasury, 2025',
    },
    {
      figure: '$894M',
      text: 'was paid on a Revlon loan in 2020 when $7.8M of interest was meant, after three people had reviewed the payment.',
      source: 'The 2020 Citibank payment to Revlon lenders',
    },
    {
      figure: '10 to 25 business days',
      text: 'is how long one bank confirmation takes when an auditor asks for evidence.',
      source: 'Chase and NatWest',
    },
  ] as const;

  const STEPS = [
    {
      title: 'Set the rules',
      text: 'Tell the agent your policy in plain English. You review it and seal it as a Mandate: the cap, the approvals needed and the schedule.',
    },
    {
      title: 'The agent runs the cycle',
      text: 'It snapshots who held units on the record date, has code compute every amount, runs the checks and writes a memo. Within the Mandate it pays after a short countdown with a Hold button.',
    },
    {
      title: 'Your team approves what is flagged',
      text: 'A total far from the average, or units that jumped before the record date, needs your approvers. The seal fills one signature at a time and the payments go out when it closes.',
    },
    {
      title: 'Auditors see only what you grant',
      text: 'An auditor asks a question, the agent proposes the smallest set of records that answers it, and you grant it for a set time. When the time is up the records disappear from their view.',
    },
  ] as const;
</script>

<svelte:head>
  <title>Mithra: your fund's payouts, run by an agent you can audit</title>
  <meta
    name="description"
    content="Mithra prepares every distribution, pays inside limits your team sets on Canton, and shows auditors exactly what they ask for."
  />
</svelte:head>

<header class="top">
  <p class="wordmark">Mithra</p>
</header>

<main id="main" tabindex="-1">
  <section class="hero" aria-labelledby="hero-heading">
    <div class="pitch">
      <h1 id="hero-heading">Your fund's payouts, run by an agent you can audit.</h1>
      <p class="lede">
        Mithra prepares every distribution, pays inside limits your team sets on Canton, and shows
        auditors exactly what they ask for. Nothing more.
      </p>
      <p class="actions">
        <Button href="/launch">Launch app</Button>
        {#if demoVideoUrl}
          <Button variant="secondary" externalHref={demoVideoUrl}>Watch the 3-minute demo</Button>
        {/if}
      </p>
    </div>
    <ShowcaseSeal />
  </section>

  <section class="band" aria-labelledby="problem-heading">
    <h2 id="problem-heading">Payments go wrong even when people check them</h2>
    <ul class="numbers">
      {#each NUMBERS as item (item.figure)}
        <li>
          <p class="figure">{item.figure}</p>
          <p>{item.text}</p>
          <p class="source">Source: {item.source}</p>
        </li>
      {/each}
    </ul>
  </section>

  <section class="band" aria-labelledby="how-heading">
    <h2 id="how-heading">How it works</h2>
    <ol class="steps">
      {#each STEPS as step (step.title)}
        <li>
          <h3>{step.title}</h3>
          <p>{step.text}</p>
        </li>
      {/each}
    </ol>
  </section>

  <section class="band" aria-labelledby="canton-heading">
    <h2 id="canton-heading">Why Canton</h2>
    <div class="why">
      <div>
        <h3>Each holder sees only their own payment</h3>
        <p>
          On Canton a record is visible only to the parties on it. A holder's screen has their units
          and their payments, and nothing of the other holders. The privacy is in the ledger, not in
          a filter in the app.
        </p>
      </div>
      <div>
        <h3>The agent's limits are enforced by the ledger</h3>
        <p>
          The cap, who may be paid, how much each holder gets and one distribution per cycle are
          rules in the Mandate contract. If the agent, or the app, tries to break one, the ledger
          rejects the transaction.
        </p>
      </div>
    </div>
  </section>
</main>

<footer class="foot">
  <NetworkBadge />
  <a href={GITHUB_URL} target="_blank" rel="external noopener noreferrer"
    >Mithra on GitHub<span class="sr-only"> (opens in a new tab)</span></a
  >
</footer>

<style>
  .top,
  main,
  .foot {
    width: 100%;
    max-width: 68rem;
    margin: 0 auto;
    padding-left: var(--space-4);
    padding-right: var(--space-4);
  }
  .top {
    padding-top: var(--space-5);
  }
  .wordmark {
    margin: 0;
    font-family: var(--font-serif);
    font-size: var(--text-24);
    font-weight: 500;
  }
  main {
    padding-bottom: var(--space-7);
  }

  .hero {
    display: grid;
    grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
    align-items: center;
    gap: var(--space-7);
    padding: var(--space-7) 0;
  }
  h1 {
    font-size: var(--text-44);
    max-width: 16ch;
  }
  .lede {
    font-size: var(--text-18);
    color: var(--color-text-muted);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    margin: var(--space-5) 0 0;
  }

  .band {
    padding: var(--space-6) 0;
    border-top: 1px solid var(--color-border);
  }
  .band h2 {
    margin-bottom: var(--space-5);
  }

  .numbers {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-5);
    margin: 0;
    padding: 0;
    list-style: none;
    max-width: none;
  }
  .numbers li {
    padding: var(--space-4) var(--space-5);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
  }
  .figure {
    margin: 0 0 var(--space-2);
    font-family: var(--font-serif);
    font-size: var(--text-32);
    line-height: var(--leading-tight);
    font-variant-numeric: tabular-nums lining-nums;
  }
  .source {
    margin: 0;
    font-size: var(--text-13);
    color: var(--color-text-muted);
  }

  .steps {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--space-5);
    margin: 0;
    padding: 0;
    list-style: none;
    counter-reset: step;
    max-width: none;
  }
  .steps li {
    counter-increment: step;
    padding-top: var(--space-3);
    border-top: 2px solid var(--color-text);
  }
  .steps li::before {
    content: counter(step) '.';
    display: block;
    margin-bottom: var(--space-1);
    font-family: var(--font-serif);
    font-size: var(--text-24);
    font-variant-numeric: tabular-nums lining-nums;
  }

  .why {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-6);
  }

  .foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding-top: var(--space-5);
    padding-bottom: var(--space-6);
    border-top: 1px solid var(--color-border);
  }

  @media (max-width: 62rem) {
    .steps {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .numbers {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 48rem) {
    .hero {
      grid-template-columns: 1fr;
      gap: var(--space-5);
      padding: var(--space-5) 0 var(--space-6);
    }
    h1 {
      font-size: var(--text-32);
      max-width: none;
    }
    .steps,
    .why {
      grid-template-columns: 1fr;
    }
  }
</style>
