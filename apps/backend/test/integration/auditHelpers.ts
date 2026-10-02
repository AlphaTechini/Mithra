import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { ActivityLog } from '../../src/activity/log';
import { createAuditModule, type AuditModule, type ExpiresIn } from '../../src/audit/service';
import { sessionPlugin } from '../../src/auth/plugin';
import { createRoleResolver } from '../../src/auth/roles';
import { SESSION_COOKIE, SessionService } from '../../src/auth/sessions';
import type { Config } from '../../src/config/env';
import type { DatabaseHandle } from '../../src/db';
import { invites } from '../../src/db/schema';
import { EventBus, type Published } from '../../src/events/bus';
import { PartyNames } from '../../src/parties/names';
import type { CycleWorld } from './cycleHelpers';

export const DATABASE_URL_M9 =
  process.env['DATABASE_URL_TEST_M9'] ?? 'postgres://mithra:mithra@localhost:5432/mithra_test_m9';

export interface AuditApp {
  app: FastifyInstance;
  module: AuditModule;
  names: PartyNames;
  activity: ActivityLog;
  /** Every event published on this app's bus, in order. */
  published: Published[];
  /** `cookie` header for a request signed in as `partyId`. */
  cookieFor(partyId: string): Promise<{ cookie: string }>;
}

export interface AuditAppOptions {
  /** Replaces the config (for example a MainNet one). */
  config?: Config;
  /** Replaces the grant durations (a few seconds, to see an expiry). */
  durationsMs?: Record<ExpiresIn, number>;
}

/** A test app: cookie, session and role plumbing of the real app, and the audit routes under test. */
export async function buildAuditApp(
  world: CycleWorld,
  database: DatabaseHandle,
  options: AuditAppOptions = {},
): Promise<AuditApp> {
  const config = options.config ?? world.config;
  const app = Fastify({ logger: false });
  void app.register(fastifyCookie, { secret: config.sessionSecret });
  void app.register(sessionPlugin, {
    sessions: new SessionService(database.db),
    roleResolver: createRoleResolver({ reader: world.ledger.reader, db: database.db }),
  });
  const bus = new EventBus();
  const published: Published[] = [];
  bus.subscribe((p) => published.push(p));
  const names = new PartyNames(config, database.db, 0);
  const activity = new ActivityLog(database.db, bus, names);
  const module = createAuditModule({
    config,
    db: database.db,
    ledger: world.ledger,
    names,
    activity,
    bus,
    ...(options.durationsMs ? { options: { durationsMs: options.durationsMs } } : {}),
  });
  void app.register(module.routes);
  await app.ready();
  return {
    app,
    module,
    names,
    activity,
    published,
    async cookieFor(partyId) {
      const session = await app.sessions.create(partyId);
      return { cookie: `${SESSION_COOKIE}=${app.signCookie(session.id)}` };
    },
  };
}

/** An unused auditor invite makes the party an auditor for the role check, as the invite flow does. */
export async function inviteAuditor(
  database: DatabaseHandle,
  partyId: string,
  displayName: string,
): Promise<void> {
  await database.db.insert(invites).values({
    code: `AUD-${displayName.replace(/\W+/g, '').toUpperCase()}-${partyId.slice(-6)}`,
    kind: 'auditor',
    partyId,
    displayName,
    createdBy: 'integration-test',
  });
}
