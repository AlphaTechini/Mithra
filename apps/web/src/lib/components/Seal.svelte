<script lang="ts">
  /**
   * The signature ring: one segment per required signer, filled in Saffron for every signature the
   * ledger reports. `signed` is a prop only; this component has no way to increment it, so the
   * ring can never show an optimistic count (U3). When signed reaches required the ring becomes a
   * solid seal stamped with `label`. In the `expiring` state the ring empties in proportion to
   * the time left on an access grant. This is the only component allowed to use the seal colour.
   *
   * Accessibility: role="img" with an aria-label that states the count in words. Not focusable,
   * it is informative only. Reduced motion: the settle animation is switched off in base.css.
   */
  import { onMount, untrack } from 'svelte';

  interface Props {
    /** Number of ring segments (signers required). */
    required: number;
    /** Signatures the ledger reports. Never an optimistic value. */
    signed: number;
    /** Visible stamp text, e.g. "Approved 2 of 3". */
    label: string;
    state?: 'open' | 'sealed' | 'expiring';
    /** `expiring` only: when the grant ends. */
    expiresAt?: Date | string | number;
    /** `expiring` only: when the grant began. */
    grantedAt?: Date | string | number;
    size?: 'sm' | 'md' | 'lg';
  }

  let {
    required,
    signed,
    label,
    state: mode = 'open',
    expiresAt,
    grantedAt,
    size = 'md',
  }: Props = $props();

  const PX = { sm: 56, md: 112, lg: 168 } as const;
  const R = 42;
  const CIRC = 2 * Math.PI * R;
  const GAP_DEG = 8;

  const segments = $derived(Math.max(1, Math.floor(required)));
  const count = $derived(Math.min(Math.max(0, Math.floor(signed)), segments));
  const isSealed = $derived(mode === 'sealed' || (mode === 'open' && signed >= required));
  const isExpiring = $derived(mode === 'expiring');

  // Time-left fraction for the expiring ring, refreshed once a minute.
  let now = $state(Date.now());
  onMount(() => {
    const timer = window.setInterval(() => (now = Date.now()), 60_000);
    return () => window.clearInterval(timer);
  });
  const remaining = $derived.by(() => {
    if (!isExpiring || expiresAt === undefined) return 1;
    const end = new Date(expiresAt).getTime();
    const start = grantedAt === undefined ? NaN : new Date(grantedAt).getTime();
    if (Number.isNaN(end)) return 1;
    if (Number.isNaN(start) || end <= start) return now >= end ? 0 : 1;
    return Math.min(1, Math.max(0, (end - now) / (end - start)));
  });

  // Settle animation: segments that were just filled get a short animation. Detected by comparing
  // against the previous prop value; nothing here ever changes `signed`.
  let previous = untrack(() => count);
  let freshFrom = $state(Number.POSITIVE_INFINITY);
  $effect(() => {
    const current = count;
    if (current > previous) {
      freshFrom = previous;
      const timer = window.setTimeout(() => (freshFrom = Number.POSITIVE_INFINITY), 450);
      previous = current;
      return () => window.clearTimeout(timer);
    }
    previous = current;
  });

  const segmentAngle = $derived(360 / segments);
  const gap = $derived(segments > 1 ? GAP_DEG : 0);
  const segmentLength = $derived(((segmentAngle - gap) / 360) * CIRC);

  const ariaLabel = $derived.by(() => {
    if (isExpiring) {
      const pct = Math.round(remaining * 100);
      return `${label}. ${pct} percent of the access period remains.`;
    }
    const base = `${count} of ${segments} ${segments === 1 ? 'signature' : 'signatures'}`;
    return isSealed ? `${base}, sealed. ${label}` : `${base}. ${label}`;
  });

  // Stamp text, wrapped to short lines so it fits inside the disc.
  const stampLines = $derived.by(() => {
    const words = label.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    for (const word of words) {
      const last = lines[lines.length - 1];
      if (last !== undefined && (last + ' ' + word).length <= 11)
        lines[lines.length - 1] = last + ' ' + word;
      else lines.push(word);
    }
    return lines;
  });
  const stamped = $derived(isSealed && size !== 'sm');
  const showCaption = $derived(!stamped);
</script>

<figure class="seal" style:--seal-size="{PX[size]}px" data-state={isSealed ? 'sealed' : mode}>
  <svg
    class="ring"
    width={PX[size]}
    height={PX[size]}
    viewBox="0 0 100 100"
    role="img"
    aria-label={ariaLabel}
  >
    {#if isSealed}
      <g class="stamp">
        <circle
          cx="50"
          cy="50"
          r="47"
          fill="var(--color-seal)"
          stroke="var(--color-seal-ink)"
          stroke-width="2"
        />
        <circle
          cx="50"
          cy="50"
          r="40"
          fill="none"
          stroke="var(--color-seal-ink)"
          stroke-width="1"
          stroke-dasharray="2 3"
        />
        {#if stamped}
          <text class="stamp-text" x="50" text-anchor="middle" fill="var(--color-seal-ink)">
            {#each stampLines as line, i (i)}
              <tspan x="50" y={50 + (i - (stampLines.length - 1) / 2) * 12 + 4}>{line}</tspan>
            {/each}
          </text>
        {:else}
          <path
            d="M33 51l11 11 23-24"
            fill="none"
            stroke="var(--color-seal-ink)"
            stroke-width="7"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        {/if}
      </g>
    {:else if isExpiring}
      <circle
        cx="50"
        cy="50"
        r={R}
        fill="none"
        stroke="var(--color-border-strong)"
        stroke-width="12"
        opacity="0.35"
      />
      {#if remaining > 0}
        <circle
          class="remaining"
          cx="50"
          cy="50"
          r={R}
          fill="none"
          stroke="var(--color-seal-ink)"
          stroke-width="12"
          stroke-dasharray="{remaining * CIRC} {CIRC}"
          transform="rotate(-90 50 50)"
        />
        <circle
          class="remaining"
          cx="50"
          cy="50"
          r={R}
          fill="none"
          stroke="var(--color-seal)"
          stroke-width="8"
          stroke-dasharray="{remaining * CIRC} {CIRC}"
          transform="rotate(-90 50 50)"
        />
      {/if}
      <path
        d="M36 51l10 10 19-21"
        fill="none"
        stroke="var(--color-text)"
        stroke-width="6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    {:else}
      {#each Array.from({ length: segments }, (_, i) => i) as i (i)}
        {@const filled = i < count}
        {@const rotation = -90 + i * segmentAngle + gap / 2}
        <g transform="rotate({rotation} 50 50)">
          <circle
            cx="50"
            cy="50"
            r={R}
            fill="none"
            stroke={filled ? 'var(--color-seal-ink)' : 'var(--color-border-strong)'}
            stroke-width="12"
            stroke-dasharray="{segmentLength + 2} {CIRC}"
            stroke-dashoffset="1"
            data-underlay
          />
          <circle
            class="segment"
            class:fresh={filled && i >= freshFrom}
            cx="50"
            cy="50"
            r={R}
            fill="none"
            stroke={filled ? 'var(--color-seal)' : 'var(--color-surface)'}
            stroke-width="8"
            stroke-dasharray="{segmentLength} {CIRC}"
            data-segment
            data-filled={filled ? 'true' : 'false'}
          />
        </g>
      {/each}
      <text class="fraction" x="50" y="58" text-anchor="middle" fill="var(--color-text)"
        >{count}/{segments}</text
      >
    {/if}
  </svg>
  {#if showCaption}
    <figcaption>{label}</figcaption>
  {/if}
</figure>

<style>
  .seal {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    max-width: calc(var(--seal-size) + 4rem);
    text-align: center;
  }
  .ring {
    display: block;
    width: var(--seal-size);
    height: var(--seal-size);
    overflow: visible;
  }
  figcaption {
    font-size: var(--text-13);
    color: var(--color-text-muted);
  }
  .fraction {
    font-family: var(--font-serif);
    font-size: 22px;
    font-weight: 500;
    font-variant-numeric: tabular-nums lining-nums;
  }
  .stamp-text {
    font-family: var(--font-serif);
    font-size: 12px;
    font-weight: 600;
  }
  .stamp {
    transform-origin: 50% 50%;
    animation: stamp var(--motion-settle) ease-out;
  }
  .segment.fresh {
    transform-origin: 50% 50%;
    animation: settle var(--motion-settle) ease-out;
  }
  .remaining {
    transition: stroke-dasharray 1s linear;
  }
  @keyframes settle {
    from {
      opacity: 0.2;
      stroke-width: 14;
    }
    60% {
      stroke-width: 7;
    }
    to {
      opacity: 1;
      stroke-width: 8;
    }
  }
  @keyframes stamp {
    from {
      transform: scale(1.12);
      opacity: 0.3;
    }
    to {
      transform: scale(1);
      opacity: 1;
    }
  }
</style>
