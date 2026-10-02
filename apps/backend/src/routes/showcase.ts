import { ShowcaseSchema, type CycleDetail, type CycleSummary, type Showcase } from '@mithra/shared';
import type { FastifyInstance } from 'fastify';

/** What the showcase reads: the cycle list and one cycle's detail (only to count its payees). */
export interface ShowcaseSource {
  listCycles(): Promise<CycleSummary[]>;
  getCycle(cycleId: string): Promise<CycleDetail>;
}

/** Cycles that were approved by the threshold and then executed (paid, or waiting for a holder or Grofty). */
const EXECUTED_AFTER_APPROVAL = new Set<CycleSummary['status']>([
  'paid-after-approval',
  'awaiting-acceptance',
  'awaiting-signature',
]);

/**
 * The aggregate numbers of the latest executed cycle that needed and got its approvals, newest
 * first. The result holds the label, the total, the number of payees and the approval counts and
 * nothing else: it is public, so no holder name, party id or per-holder amount may reach it.
 * `null` when no such cycle exists.
 */
export async function buildShowcase(
  source: ShowcaseSource,
  assetSymbol: string,
): Promise<Showcase> {
  const cycles = await source.listCycles();
  const latest = cycles.find(
    (c) =>
      EXECUTED_AFTER_APPROVAL.has(c.status) &&
      c.total !== null &&
      c.approvals !== null &&
      c.approvals.need > 0 &&
      c.approvals.have >= c.approvals.need,
  );
  if (!latest || latest.total === null || latest.approvals === null) return null;
  const detail = await source.getCycle(latest.cycleId);
  return ShowcaseSchema.parse({
    cycleLabel: latest.label,
    total: latest.total,
    assetSymbol,
    payees: detail.proposal?.payouts.length ?? 0,
    approvals: {
      have: latest.approvals.have,
      need: latest.approvals.need,
      // Never fewer than the threshold, even if the proposal lists no approvers.
      approvers: Math.max(detail.proposal?.approvers.length ?? 0, latest.approvals.need),
    },
  });
}

export interface ShowcaseRouteDeps {
  cycles: ShowcaseSource;
  assetSymbol: string;
  /** Replaces the clock (tests). */
  now?: () => number;
  /** How long an answer is reused, so the public route cannot be used to hammer the ledger. */
  cacheMs?: number;
}

/** `GET /api/public/showcase`: no sign-in. The landing page's live seal. */
export function showcaseRoute(app: FastifyInstance, deps: ShowcaseRouteDeps): void {
  const now = deps.now ?? Date.now;
  const cacheMs = deps.cacheMs ?? 15_000;
  let cached: { at: number; value: Showcase } | undefined;
  app.get('/api/public/showcase', async (_request, reply): Promise<Showcase> => {
    void reply.header('cache-control', 'public, max-age=15');
    if (cached && now() - cached.at < cacheMs) return cached.value;
    const value = await buildShowcase(deps.cycles, deps.assetSymbol);
    cached = { at: now(), value };
    return value;
  });
}
