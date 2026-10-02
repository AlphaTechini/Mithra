import { isNotNull } from 'drizzle-orm';
import type { PartyRef } from '@mithra/shared';
import type { Config } from '../config/env';
import type { Database } from '../db';
import { invites } from '../db/schema';

/** `hint::1220ab…cd`, for parties without a configured name. */
export function shortPartyId(partyId: string): string {
  const [hint = partyId, namespace = ''] = partyId.split('::');
  if (!namespace) return hint;
  return `${hint}::${namespace.slice(0, 6)}…${namespace.slice(-2)}`;
}

/**
 * Display names for parties: LocalNet demo names, then invite names, then the configured system
 * parties, then a shortened id. Callers decide who may see which party; this only names them.
 */
export class PartyNames {
  private invited = new Map<string, string>();
  private loadedAt = 0;
  private inFlight: Promise<void> | null = null;
  private generation = 0;

  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly ttlMs = 10_000,
  ) {}

  /** Reloads the invite names when the cache is stale; concurrent callers share one query. */
  private refresh(): Promise<void> {
    if (Date.now() - this.loadedAt < this.ttlMs) return Promise.resolve();
    if (!this.inFlight) {
      const pending = this.load().finally(() => {
        if (this.inFlight === pending) this.inFlight = null;
      });
      this.inFlight = pending;
    }
    return this.inFlight;
  }

  private async load(): Promise<void> {
    const generation = this.generation;
    const rows = await this.db
      .select({ partyId: invites.partyId, displayName: invites.displayName })
      .from(invites)
      .where(isNotNull(invites.partyId));
    const next = new Map<string, string>();
    for (const row of rows) if (row.partyId) next.set(row.partyId, row.displayName);
    // An invalidate() during the query means these rows may be stale: do not cache them.
    if (generation !== this.generation) return;
    this.invited = next;
    this.loadedAt = Date.now();
  }

  /** Forget cached invite names (call after creating or binding an invite). */
  invalidate(): void {
    this.generation += 1;
    this.inFlight = null;
    this.loadedAt = 0;
  }

  async name(partyId: string): Promise<string> {
    await this.refresh();
    const demo = this.config.localnet?.demoParties.find((p) => p.partyId === partyId);
    if (demo) return demo.displayName;
    const invited = this.invited.get(partyId);
    if (invited) return invited;
    if (partyId === this.config.parties.treasury) return 'Treasury';
    if (partyId === this.config.parties.agent) return 'Mithra agent';
    if (partyId === this.config.parties.operator) return 'Mithra operator';
    return shortPartyId(partyId);
  }

  async ref(partyId: string): Promise<PartyRef> {
    return { partyId, displayName: await this.name(partyId) };
  }

  async refs(partyIds: readonly string[]): Promise<PartyRef[]> {
    return Promise.all(partyIds.map((p) => this.ref(p)));
  }
}
