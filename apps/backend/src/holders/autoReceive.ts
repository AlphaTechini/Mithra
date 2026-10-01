import type { AssetAdapter } from '../wallet';

/** How long a holder's auto-receive answer is reused. */
export const AUTO_RECEIVE_TTL_MS = 60_000;

/** A failed lookup is remembered only briefly, so a registry hiccup does not stick for a minute. */
export const AUTO_RECEIVE_ERROR_TTL_MS = 5_000;

/** A positive amount for the registry lookup; the lookup only asks how a transfer would settle. */
const PROBE_AMOUNT = '1';

export interface AutoReceiveOptions {
  asset: AssetAdapter;
  /** The sender the registry is asked about: the treasury. */
  treasury: string;
  ttlMs?: number;
  now?: () => number;
  /** Called with the failure when the registry cannot be asked (the status is then null). */
  onError?: (holder: string, error: unknown) => void;
}

/**
 * Whether a holder has auto-receive (a transfer preapproval) on. The registry reports it: a
 * transfer lookup answers `direct` when the receiver pre-approved transfers (wallet-sdk.md,
 * grofty.md). Answers are cached for 60 s per holder; `null` when the registry cannot say.
 */
export class AutoReceiveStatus {
  private readonly cache = new Map<string, { value: boolean | null; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<boolean | null>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: AutoReceiveOptions) {
    this.ttlMs = options.ttlMs ?? AUTO_RECEIVE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async get(holder: string): Promise<boolean | null> {
    const cached = this.cache.get(holder);
    if (cached && this.now() < cached.expiresAt) return cached.value;
    const running = this.inflight.get(holder);
    if (running) return running;
    const lookup = this.lookup(holder).finally(() => this.inflight.delete(holder));
    this.inflight.set(holder, lookup);
    return lookup;
  }

  /** Answers for several holders, as a map. */
  async getMany(holders: readonly string[]): Promise<Map<string, boolean | null>> {
    const answers = await Promise.all(holders.map((h) => this.get(h)));
    return new Map(holders.map((h, i) => [h, answers[i] ?? null]));
  }

  /** Forget the cached answer (after the holder turned auto-receive on). */
  invalidate(holder: string): void {
    this.cache.delete(holder);
  }

  private async lookup(holder: string): Promise<boolean | null> {
    let value: boolean | null;
    try {
      const result = await this.options.asset.transferLeg({
        sender: this.options.treasury,
        receiver: holder,
        amount: PROBE_AMOUNT,
      });
      value = result.kind === 'direct';
    } catch (error) {
      this.options.onError?.(holder, error);
      value = null;
    }
    const ttl = value === null ? Math.min(AUTO_RECEIVE_ERROR_TTL_MS, this.ttlMs) : this.ttlMs;
    this.cache.set(holder, { value, expiresAt: this.now() + ttl });
    return value;
  }
}
