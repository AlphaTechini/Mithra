import { desc } from 'drizzle-orm';
import type { ActivityEntry } from '@mithra/shared';
import type { Database } from '../db';
import { activityLog } from '../db/schema';
import { type Audience, type EventBus, TREASURY_TEAM } from '../events/bus';
import type { PartyNames } from '../parties/names';

export interface ActivityInput {
  /** Party that acted; the agent's or operator's party for system actions. */
  actorParty: string;
  /** e.g. "mandate.sealed", "cycle.proposed", "proposal.approved", "payment.paid", "grant.closed" */
  kind: string;
  /** What it is about, e.g. a cycle id, grant id or contract id. */
  subject: string;
  /** One plain-English line for the log. */
  text: string;
  /** In-app path, e.g. "/app/cycles/2026-09". */
  link?: string | null;
  seeded?: boolean;
  /** Extra structured detail kept with the entry. */
  detail?: Record<string, unknown>;
  /** Who receives the live update. Default: the treasury team. */
  audience?: Audience;
}

interface StoredDetail {
  text?: unknown;
  link?: unknown;
  seeded?: unknown;
}

/** The activity log the treasurer reads (details.md section 6): every request, approval, execution, grant and expiry. */
export class ActivityLog {
  constructor(
    private readonly db: Database,
    private readonly bus: EventBus,
    private readonly names: PartyNames,
  ) {}

  async record(input: ActivityInput): Promise<ActivityEntry> {
    const detail = {
      ...input.detail,
      text: input.text,
      link: input.link ?? null,
      seeded: input.seeded ?? false,
    };
    const [row] = await this.db
      .insert(activityLog)
      .values({ actorParty: input.actorParty, kind: input.kind, subject: input.subject, detail })
      .returning();
    if (!row) throw new Error('activity_log insert returned no row');
    const entry = await this.toEntry(row);
    this.bus.publish({ type: 'activity', entry }, input.audience ?? TREASURY_TEAM);
    return entry;
  }

  async list(limit = 50): Promise<ActivityEntry[]> {
    const rows = await this.db
      .select()
      .from(activityLog)
      .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
      .limit(Math.min(Math.max(limit, 1), 500));
    return Promise.all(rows.map((r) => this.toEntry(r)));
  }

  private async toEntry(row: typeof activityLog.$inferSelect): Promise<ActivityEntry> {
    const d = row.detail as StoredDetail;
    return {
      id: String(row.id),
      at: row.createdAt.toISOString(),
      actor: await this.names.ref(row.actorParty),
      kind: row.kind,
      text: typeof d.text === 'string' ? d.text : row.kind,
      link: typeof d.link === 'string' ? d.link : null,
      seeded: d.seeded === true,
    };
  }
}
