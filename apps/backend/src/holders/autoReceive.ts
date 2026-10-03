import type { AssetAdapter } from '../wallet';

/** How long a holder's auto-receive answer is reused. */
export const AUTO_RECEIVE_TTL_MS = 60_000;

/** A failed lookup is remembered only briefly, so a registry hiccup does not stick for a minute. */
export const AUTO_RECEIVE_ERROR_TTL_MS = 5_000;

/** A positive amount for the registry lookup; the lookup only asks how a transfer would settle. */
const PROBE_AMOUNT = '1';

interface AutoReceiveCommon {
  ttlMs?: number;
  now?: () => number;
  /** Called with the failure when the registry cannot be asked (the status is then null). */
  onError?: (holder: string, error: unknown) => void;
}

/**
 * Where the answer comes from: the token standard registry (LocalNet: ask how a transfer from the
 * treasury would settle), or a `lookup` function (MainNet: a public Scan, see `mainnet/scan.ts`).
 */
export type AutoReceiveOptions = AutoReceiveCommon &
  (
    | {
        asset: AssetAdapter;
        /** The sender the registry is asked about: the treasury. */
        treasury: string;
      }
    | { lookup: (holder: string) => Promise<boolean | null> }
  );

/**
 * Whether a holder has auto-receive (a transfer preapproval) on. The registry reports it: a
 * transfer lookup answers `direct` when the receiver pre-approved transfers (wallet-sdk.md,
 * grofty.md). Answers are cached for 60 s per holder; `null` when the registry cannot say.
 */
export class AutoReceiveStatus {
  private readonly cache = new Map<string, { value: boolean | null; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<boolean | null>>();
  /** Bumped by `invalidate`: a lookup started under an older generation is not cached or shared. */
  private readonly generations = new Map<string, number>();
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
    const lookup: Promise<boolean | null> = this.lookup(holder, this.generationOf(holder)).finally(
      () => {
        // Only this lookup's own entry: `invalidate` may already have replaced it.
        if (this.inflight.get(holder) === lookup) this.inflight.delete(holder);
      },
    );
    this.inflight.set(holder, lookup);
    return lookup;
  }

  /** Answers for several holders, as a map. */
  async getMany(holders: readonly string[]): Promise<Map<string, boolean | null>> {
    const answers = await Promise.all(holders.map((h) => this.get(h)));
    return new Map(holders.map((h, i) => [h, answers[i] ?? null]));
  }

  /**
   * Forget the cached answer (after the holder turned auto-receive on), and any lookup still in
   * flight: it asked before the change, so it is neither shared nor cached.
   */
  invalidate(holder: string): void {
    this.generations.set(holder, this.generationOf(holder) + 1);
    this.cache.delete(holder);
    this.inflight.delete(holder);
  }

  private generationOf(holder: string): number {
    return this.generations.get(holder) ?? 0;
  }

  private async lookup(holder: string, generation: number): Promise<boolean | null> {
    let value: boolean | null;
    try {
      if ('lookup' in this.options) {
        value = await this.options.lookup(holder);
      } else {
        const result = await this.options.asset.transferLeg({
          sender: this.options.treasury,
          receiver: holder,
          amount: PROBE_AMOUNT,
        });
        value = result.kind === 'direct';
      }
    } catch (error) {
      this.options.onError?.(holder, error);
      value = null;
    }
    if (generation !== this.generationOf(holder)) return value;
    const ttl = value === null ? Math.min(AUTO_RECEIVE_ERROR_TTL_MS, this.ttlMs) : this.ttlMs;
    this.cache.set(holder, { value, expiresAt: this.now() + ttl });
    return value;
  }
}
