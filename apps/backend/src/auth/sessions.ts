import { and, eq, gt, lt } from 'drizzle-orm';
import type { Database } from '../db';
import { sessions } from '../db/schema';

export const SESSION_COOKIE = 'mithra_session';
/** Sessions last 12 hours from sign-in. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** `last_seen_at` is refreshed at most this often. */
const TOUCH_INTERVAL_MS = 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a request knows about its session. */
export interface SessionData {
  id: string;
  partyId: string | null;
}

export interface CreatedSession extends SessionData {
  expiresAt: Date;
}

/** Session rows in PostgreSQL. */
export class SessionService {
  private readonly db: Database;
  private readonly now: () => Date;

  constructor(db: Database, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  async create(partyId: string | null = null): Promise<CreatedSession> {
    const now = this.now();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    const [row] = await this.db
      .insert(sessions)
      .values({ partyId, createdAt: now, lastSeenAt: now, expiresAt })
      .returning({ id: sessions.id });
    if (!row) throw new Error('Could not create a session');
    return { id: row.id, partyId, expiresAt };
  }

  /** The live session with this id, or null when unknown or expired. */
  async find(id: string): Promise<SessionData | null> {
    if (!UUID.test(id)) return null;
    const now = this.now();
    const [row] = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, id), gt(sessions.expiresAt, now)))
      .limit(1);
    if (!row) return null;
    if (now.getTime() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, id));
    }
    return { id: row.id, partyId: row.partyId };
  }

  /** The expiry of a live session. */
  async expiresAt(id: string): Promise<Date | null> {
    if (!UUID.test(id)) return null;
    const [row] = await this.db
      .select({ expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(eq(sessions.id, id))
      .limit(1);
    return row?.expiresAt ?? null;
  }

  async setParty(id: string, partyId: string | null): Promise<void> {
    await this.db.update(sessions).set({ partyId }).where(eq(sessions.id, id));
  }

  async destroy(id: string): Promise<void> {
    if (!UUID.test(id)) return;
    await this.db.delete(sessions).where(eq(sessions.id, id));
  }

  /** Deletes expired sessions; returns how many. */
  async purgeExpired(): Promise<number> {
    const rows = await this.db
      .delete(sessions)
      .where(lt(sessions.expiresAt, this.now()))
      .returning({ id: sessions.id });
    return rows.length;
  }
}
