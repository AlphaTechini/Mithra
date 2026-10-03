import { z } from 'zod';
import type { LedgerClient } from '../client';
import type { ActiveContract } from '../types';
import {
  MITHRA_PAYLOAD_SCHEMAS,
  MITHRA_TEMPLATE_ENTITIES,
  type Contract,
  type MithraPayloads,
  type MithraTemplateIds,
  type MithraTemplateName,
} from './templates';

export interface MithraReaderOptions {
  client: LedgerClient;
  templates: MithraTemplateIds;
  treasuryParty: string;
  /** Parties whose view of the ledger is read; the agent, plus the treasury on LocalNet. */
  readParties: string[];
}

/** Everything role resolution needs, from one ledger query. */
export interface RoleFacts {
  organization: Contract<MithraPayloads['Organization']> | null;
  register: Contract<MithraPayloads['UnitRegister']> | null;
  auditRequests: Contract<MithraPayloads['AuditRequest']>[];
  grants: Contract<MithraPayloads['AccessGrant']>[];
  closed: Contract<MithraPayloads['AccessClosed']>[];
  denied: Contract<MithraPayloads['AccessDenied']>[];
}

const ISO_INSTANT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/;

/**
 * Orders two ISO-8601 instants. The ledger writes microseconds (`…24.254844Z`) but drops trailing
 * zeros of the fraction (`…24.254Z`), so the strings do not sort as instants: compare the whole
 * seconds as dates and the fraction as digits padded to nanoseconds. Unparseable text sorts first.
 */
export function compareInstants(a: string, b: string): number {
  const parse = (iso: string): { seconds: number; fraction: string } | null => {
    const match = ISO_INSTANT.exec(iso);
    if (!match) return null;
    const seconds = Date.parse(`${match[1] ?? ''}Z`);
    return Number.isNaN(seconds) ? null : { seconds, fraction: (match[2] ?? '').padEnd(9, '0') };
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return left ? 1 : right ? -1 : 0;
  if (left.seconds !== right.seconds) return left.seconds < right.seconds ? -1 : 1;
  const l = left.fraction.slice(0, 9);
  const r = right.fraction.slice(0, 9);
  return l < r ? -1 : l > r ? 1 : 0;
}

/**
 * Newest first: by ledger offset when both contracts carry different ones, else by creation
 * instant, with the contract id as the final tiebreak so the order never depends on read order.
 */
export function newestFirst<T>(a: Contract<T>, b: Contract<T>): number {
  if (a.offset !== undefined && b.offset !== undefined && a.offset !== b.offset) {
    return b.offset - a.offset;
  }
  const byInstant = compareInstants(b.createdAt, a.createdAt);
  if (byInstant !== 0) return byInstant;
  return a.contractId < b.contractId ? 1 : a.contractId > b.contractId ? -1 : 0;
}

/**
 * Typed reads of the Mithra templates of one treasury. Reads as the agent (plus the treasury
 * where the ledger user may read as it). `as(parties)` returns a reader for other parties, for
 * example one holder, to see exactly what that party sees on the ledger.
 */
export class MithraReader {
  private readonly options: MithraReaderOptions;

  constructor(options: MithraReaderOptions) {
    this.options = options;
  }

  /** A reader that queries as `parties` instead. */
  as(parties: string[]): MithraReader {
    return new MithraReader({ ...this.options, readParties: parties });
  }

  private async load<K extends MithraTemplateName>(
    names: readonly K[],
  ): Promise<{
    [P in K]: Contract<MithraPayloads[P]>[];
  }> {
    const { client, templates, treasuryParty, readParties } = this.options;
    const active = await client.activeContracts({
      parties: readParties,
      templateIds: names.map((n) => templates[n]),
    });
    const out = {} as { [P in K]: Contract<MithraPayloads[P]>[] };
    for (const name of names) out[name] = [];
    for (const contract of active) {
      const name = names.find((n) => contract.entity === MITHRA_TEMPLATE_ENTITIES[n]);
      if (name === undefined) continue;
      const decoded = decode(name, contract);
      // Every Mithra template of an organization carries its treasury, except the governed actions.
      const treasury = 'treasury' in decoded.payload ? decoded.payload.treasury : undefined;
      const governance =
        'governanceParty' in decoded.payload ? decoded.payload.governanceParty : undefined;
      if ((treasury ?? governance) !== treasuryParty) continue;
      out[name].push(decoded);
    }
    for (const name of names) out[name].sort(newestFirst);
    return out;
  }

  private async list<K extends MithraTemplateName>(
    name: K,
  ): Promise<Contract<MithraPayloads[K]>[]> {
    const loaded = await this.load([name]);
    return loaded[name];
  }

  private async single<K extends MithraTemplateName>(
    name: K,
  ): Promise<Contract<MithraPayloads[K]> | null> {
    return (await this.list(name))[0] ?? null;
  }

  organization() {
    return this.single('Organization');
  }
  charter() {
    return this.single('TreasuryCharter');
  }
  register() {
    return this.single('UnitRegister');
  }
  /** The active Mandate (there is one at a time). */
  mandate() {
    return this.single('Mandate');
  }
  proposals() {
    return this.list('Proposal');
  }
  approvals() {
    return this.list('Approval');
  }
  decisionRecords() {
    return this.list('DecisionRecord');
  }
  outcomes() {
    return this.list('DistributionOutcome');
  }
  payments() {
    return this.list('Payment');
  }
  /** Fund units, all or only those of `holder`. */
  async fundUnits(holder?: string) {
    const units = await this.list('FundUnit');
    return holder === undefined ? units : units.filter((u) => u.payload.holder === holder);
  }
  sealRequests() {
    return this.list('MandateSealRequest');
  }
  auditRequests() {
    return this.list('AuditRequest');
  }
  grants() {
    return this.list('AccessGrant');
  }
  /** Shared records an auditor can see. */
  async sharedRecords(auditor: string) {
    const records = await this.list('SharedRecord');
    return records.filter((r) => r.payload.auditor === auditor);
  }
  closed() {
    return this.list('AccessClosed');
  }
  denied() {
    return this.list('AccessDenied');
  }

  /** The contracts role resolution needs, read with one ledger query. */
  async roleFacts(): Promise<RoleFacts> {
    const l = await this.load([
      'Organization',
      'UnitRegister',
      'AuditRequest',
      'AccessGrant',
      'AccessClosed',
      'AccessDenied',
    ]);
    return {
      organization: l.Organization[0] ?? null,
      register: l.UnitRegister[0] ?? null,
      auditRequests: l.AuditRequest,
      grants: l.AccessGrant,
      closed: l.AccessClosed,
      denied: l.AccessDenied,
    };
  }
}

/** Decodes the payload of an active contract with the schema of its template. */
function decode<K extends MithraTemplateName>(
  name: K,
  contract: ActiveContract,
): Contract<MithraPayloads[K]> {
  const schema: z.ZodType = MITHRA_PAYLOAD_SCHEMAS[name];
  const result = schema.safeParse(contract.payload);
  if (!result.success) {
    throw new Error(
      `Cannot read ${name} ${contract.contractId.slice(0, 12)}: ${result.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  // The schema is looked up by name, so TypeScript cannot relate it to K; the map is exhaustive.
  return {
    contractId: contract.contractId,
    payload: result.data as MithraPayloads[K],
    createdAt: contract.createdAt,
    offset: contract.offset,
  };
}
