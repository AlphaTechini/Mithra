import type { ActivityLog } from '../activity/log';
import type { EventBus } from '../events/bus';
import type { Ledger } from '../ledger';
import type { PartyNames } from '../parties/names';

export interface GrantExpiryDeps {
  /** Reads grants and submits `AccessGrant_CloseExpired` as the agent. */
  ledger: Pick<Ledger, 'reader' | 'client' | 'commands'>;
  activity: Pick<ActivityLog, 'record'>;
  bus: EventBus;
  names: Pick<PartyNames, 'name'>;
  /** How often to look for expired grants. Default 60 s, so grants close well within 5 minutes (A9). */
  intervalMs?: number;
  /** Extra parties to read as when submitting (LocalNet: the treasury party). */
  readAs?: string[];
  now?: () => Date;
  log?: {
    warn(object: unknown, message?: string): void;
    info?(object: unknown, message?: string): void;
  };
}

export interface ExpiryRun {
  closed: number;
  failed: number;
  /** Ids of the grants closed by this run. */
  grants: string[];
}

export interface GrantExpiry {
  /** Closes every expired grant now. Safe to call while the timer runs. */
  closeExpiredNow(): Promise<ExpiryRun>;
  stop(): void;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Closes every `AccessGrant` whose `expiresAt` has passed, as the agent (L9, A9). The agent is the
 * grant's own `agent` party, so it needs no other rights; the ledger refuses an early close.
 */
export function startGrantExpiry(deps: GrantExpiryDeps): GrantExpiry {
  const intervalMs = deps.intervalMs ?? 60_000;
  const now = deps.now ?? ((): Date => new Date());
  let running: Promise<ExpiryRun> | null = null;
  let stopped = false;

  async function closeAll(): Promise<ExpiryRun> {
    const result: ExpiryRun = { closed: 0, failed: 0, grants: [] };
    const grants = await deps.ledger.reader.grants();
    const due = grants.filter((g) => Date.parse(g.payload.expiresAt) <= now().getTime());
    for (const grant of due) {
      const { agent, treasurer, auditor, grantId } = grant.payload;
      try {
        await deps.ledger.client.submit({
          actAs: [agent],
          ...(deps.readAs && deps.readAs.length > 0 ? { readAs: deps.readAs } : {}),
          commands: [
            deps.ledger.commands.accessGrantCloseExpired(grant.contractId, { closer: agent }),
          ],
          shape: 'LEDGER_EFFECTS',
        });
      } catch (error) {
        // Already closed by someone else, or the ledger is down: the next run looks again.
        result.failed += 1;
        deps.log?.warn({ err: error, grantId }, 'could not close an expired access grant');
        continue;
      }
      result.closed += 1;
      result.grants.push(grantId);
      try {
        const auditorName = await deps.names.name(auditor);
        await deps.activity.record({
          actorParty: agent,
          kind: 'grant.closed',
          subject: grantId,
          text: `Access for ${auditorName} ended ${isoDay(now())} (expired)`,
          link: '/app/audit',
          detail: { auditor, requestId: grant.payload.requestId, reason: 'expired' },
        });
        deps.bus.publish(
          { type: 'audit', requestId: grant.payload.requestId },
          { parties: [treasurer, auditor] },
        );
      } catch (error) {
        deps.log?.warn({ err: error, grantId }, 'closed a grant but could not log it');
      }
    }
    return result;
  }

  function closeExpiredNow(): Promise<ExpiryRun> {
    running ??= closeAll().finally(() => {
      running = null;
    });
    return running;
  }

  const timer = setInterval(() => {
    if (stopped) return;
    closeExpiredNow().catch((error: unknown) => {
      deps.log?.warn({ err: error }, 'grant expiry check failed');
    });
  }, intervalMs);
  timer.unref();
  // Look once right away, so a restart after a long stop catches up at once.
  closeExpiredNow().catch((error: unknown) => {
    deps.log?.warn({ err: error }, 'grant expiry check failed');
  });

  return {
    closeExpiredNow,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
