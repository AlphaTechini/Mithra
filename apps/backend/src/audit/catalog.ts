import type { AuditRecordKind } from '@mithra/shared';
import { cycleLabel } from '../cycle/format';
import type { DecisionRecord, DistributionOutcome, Ledger } from '../ledger';
import type { PartyNames } from '../parties/names';
import type { CatalogEntry } from './scope';

export type { CatalogEntry } from './scope';

/** The kind of a record id (`decision/<cycleId>/<n>` or `outcome/<cycleId>/<n>`), or null. */
export function kindOfRecordId(recordId: string): AuditRecordKind | null {
  if (recordId.startsWith('decision/')) return 'decision';
  if (recordId.startsWith('outcome/')) return 'outcome';
  return null;
}

/** Cycle id and attempt of a record id; null when the id does not have the usual shape. */
export function parseRecordId(
  recordId: string,
): { kind: AuditRecordKind; cycleId: string; attempt: number } | null {
  const [head, cycleId, attemptText] = recordId.split('/');
  const kind = head === 'decision' || head === 'outcome' ? head : null;
  if (!kind || !cycleId) return null;
  const attempt = Number.parseInt(attemptText ?? '1', 10);
  return { kind, cycleId, attempt: Number.isFinite(attempt) ? attempt : 1 };
}

/**
 * The label of a record, from its id alone: "Decision record, September 2026" or
 * "Outcome, September 2026". A later attempt of the same cycle (after a cancel or reject) says so.
 */
export function labelForRecordId(recordId: string): string {
  const parsed = parseRecordId(recordId);
  if (!parsed) return recordId;
  const base = parsed.kind === 'decision' ? 'Decision record' : 'Outcome';
  const attempt = parsed.attempt > 1 ? ` (attempt ${parsed.attempt})` : '';
  return `${base}, ${cycleLabel(parsed.cycleId)}${attempt}`;
}

/** Orders record ids by cycle, then decision before outcome, then attempt. */
export function compareRecordIds(a: string, b: string): number {
  const pa = parseRecordId(a);
  const pb = parseRecordId(b);
  if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
  if (pa.cycleId !== pb.cycleId) return pa.cycleId < pb.cycleId ? -1 : 1;
  if (pa.kind !== pb.kind) return pa.kind === 'decision' ? -1 : 1;
  return pa.attempt - pb.attempt;
}

/**
 * A decision is flagged when it needed approval or any blocking check failed (the same rule the
 * ledger uses for the verdict, plus the checks, so an old record without a verdict still reads right).
 */
export function isFlagged(record: Pick<DecisionRecord, 'verdict' | 'checks'>): boolean {
  return record.verdict === 'NeedsApproval' || record.checks.some((c) => c.blocking && !c.passed);
}

/**
 * Catalog entries from the treasury's decision records and outcomes. An outcome is flagged when
 * its decision was; `executedAt` is the time of the executed outcome (also on the decision), else null.
 */
export function buildCatalog(
  records: readonly { payload: DecisionRecord }[],
  outcomes: readonly { payload: DistributionOutcome }[],
): CatalogEntry[] {
  const decisions = new Map(records.map((r) => [r.payload.recordId, r.payload]));
  const executedAt = new Map<string, string>();
  for (const o of outcomes) {
    if (o.payload.kind === 'Executed') executedAt.set(o.payload.decisionRecordId, o.payload.at);
  }
  const entries: CatalogEntry[] = [];
  for (const { payload: d } of records) {
    entries.push({
      recordId: d.recordId,
      kind: 'decision',
      cycleId: d.cycleId,
      cycleLabel: d.cycleLabel || cycleLabel(d.cycleId),
      flagged: isFlagged(d),
      executedAt: executedAt.get(d.recordId) ?? null,
    });
  }
  for (const { payload: o } of outcomes) {
    const decision = decisions.get(o.decisionRecordId);
    entries.push({
      recordId: o.recordId,
      kind: 'outcome',
      cycleId: o.cycleId,
      cycleLabel: o.cycleLabel || cycleLabel(o.cycleId),
      flagged: decision ? isFlagged(decision) : false,
      executedAt: o.kind === 'Executed' ? o.at : null,
    });
  }
  return entries.sort((a, b) => compareRecordIds(a.recordId, b.recordId));
}

/** The catalog function the scope drafter takes, with the record labeller attached. */
export type AuditCatalog = (() => Promise<CatalogEntry[]>) & {
  labelFor(recordId: string): string;
};

/**
 * The real audit catalog (A8): every decision record and outcome of the treasury, read as the
 * agent. The scope drafter proposes record ids from it, and requests are checked against it.
 */
export function createAuditCatalog(deps: {
  ledger: Pick<Ledger, 'reader'>;
  /** Not needed to build entries (cycle labels come from the records); kept for symmetry with the module. */
  names?: Pick<PartyNames, 'name'>;
}): AuditCatalog {
  const catalog = async (): Promise<CatalogEntry[]> => {
    const [records, outcomes] = await Promise.all([
      deps.ledger.reader.decisionRecords(),
      deps.ledger.reader.outcomes(),
    ]);
    return buildCatalog(records, outcomes);
  };
  return Object.assign(catalog, { labelFor: labelForRecordId });
}
