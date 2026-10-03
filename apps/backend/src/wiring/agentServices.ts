import {
  PolicyFieldsSchema,
  type PartyRef,
  type PolicyDraft,
  type PolicyFields,
} from '@mithra/shared';
import { isNotNull } from 'drizzle-orm';
import { POLICY_DEFAULTS } from '../agent/policyFields';
import type { AgentServices } from '../agent/services';
import type { Config } from '../config/env';
import type { CycleModule } from '../cycle';
import type { Database } from '../db';
import { invites } from '../db/schema';
import type { HolderAdmin } from '../holders/admin';
import { ApiError } from '../http/errors';
import type { Ledger } from '../ledger';
import type { PartyNames } from '../parties/names';
import { describePolicy } from '../policy/describe';
import { buildMandateView } from '../routes/treasury/org';
import type { AssetAdapter } from '../wallet';

/** The auto-pay cap of the default policy (userflow 4, step 2). */
export const DEFAULT_CAP = '5000';
/** Monthly on the 1st at 09:00 (userflow 4, step 2). */
export const DEFAULT_SCHEDULE_CRON = '0 9 1 * *';
/** Id of the policy draft that is built from the organization and not stored. */
export const ORGANIZATION_DEFAULTS_DRAFT_ID = 'organization-defaults';

/**
 * A complete policy from the defaults of userflow section 4 step 2 and the organization's
 * approvers and threshold, so a prompt that names no approvers still gives a whole policy.
 */
export function defaultPolicyFields(approvers: readonly string[], threshold: number): PolicyFields {
  return PolicyFieldsSchema.parse({
    cap: DEFAULT_CAP,
    approvers: [...approvers],
    approvalThreshold: threshold,
    scheduleCron: DEFAULT_SCHEDULE_CRON,
    scheduleTimezone: POLICY_DEFAULTS.scheduleTimezone,
    recordDateRule: POLICY_DEFAULTS.recordDateRule,
    fixedAmount: null,
    deviationPct: POLICY_DEFAULTS.deviationPct,
    trailingCycles: POLICY_DEFAULTS.trailingCycles,
    unitChangePct: POLICY_DEFAULTS.unitChangePct,
    unitChangeWindowDays: POLICY_DEFAULTS.unitChangeWindowDays,
    feeBuffer: POLICY_DEFAULTS.feeBuffer,
  });
}

export interface AgentServicesDeps {
  config: Config;
  db: Database;
  ledger: Pick<Ledger, 'reader'>;
  cycle: Pick<CycleModule, 'cycles' | 'drafts'>;
  asset: AssetAdapter;
  names: PartyNames;
  /** The holders table, the same reader `GET /api/holders` uses. */
  holders: () => Promise<Awaited<ReturnType<AgentServices['org']['holders']>>>;
  /** Issue units and create invites through the code the REST routes use. */
  holderAdmin: HolderAdmin;
}

/** The real `AgentServices`: the agent's tools run on the same code and data as the screens. */
export function createAgentServices(deps: AgentServicesDeps): AgentServices {
  const { config, db, ledger, cycle, asset, names } = deps;
  const system = new Set([config.parties.treasury, config.parties.agent, config.parties.operator]);

  async function parties(): Promise<PartyRef[]> {
    const found = new Map<string, string>();
    for (const p of config.localnet?.demoParties ?? []) found.set(p.partyId, p.displayName);
    const rows = await db
      .select({ partyId: invites.partyId, displayName: invites.displayName })
      .from(invites)
      .where(isNotNull(invites.partyId));
    for (const row of rows) {
      if (row.partyId && !found.has(row.partyId)) found.set(row.partyId, row.displayName);
    }
    return [...found.entries()]
      .filter(([partyId]) => !system.has(partyId))
      .map(([partyId, displayName]) => ({ partyId, displayName }));
  }

  /** The draft of a fund that has an organization but nothing drafted or sealed yet. */
  async function organizationDefaults(): Promise<PolicyDraft | null> {
    const organization = await ledger.reader.organization();
    if (!organization) return null;
    const { approvers, approvalThreshold } = organization.payload;
    const fields = defaultPolicyFields(approvers, approvalThreshold);
    const nameMap: Record<string, string> = {};
    for (const approver of approvers) nameMap[approver] = await names.name(approver);
    const description = describePolicy(fields, nameMap, config.asset.symbol);
    return {
      draftId: ORGANIZATION_DEFAULTS_DRAFT_ID,
      fields,
      summary: description.summary,
      agentCan: description.agentCan,
      agentCannot: description.agentCannot,
      source: 'agent',
      updatedAt: organization.createdAt,
    };
  }

  return {
    cycles: {
      run: (input) => cycle.cycles.run(input),
      async getCycle(cycleId) {
        try {
          return await cycle.cycles.getCycle(cycleId);
        } catch (error) {
          // A cycle the app does not know yet is "not there", not a failure.
          if (error instanceof ApiError && error.status === 404) return null;
          throw error;
        }
      },
      listCycles: () => cycle.cycles.listCycles(),
    },
    policy: {
      saveDraft: (fields, source, party) => cycle.drafts.savePolicyDraft(fields, source, party),
      async currentDraft(party) {
        return (await cycle.drafts.latest(party)) ?? (await organizationDefaults());
      },
    },
    org: {
      holders: () => deps.holders(),
      issueUnits: (input) =>
        deps.holderAdmin.issueUnits({
          actor: input.actorParty,
          holder: input.holder,
          units: input.units,
        }),
      createInvite: (input) =>
        deps.holderAdmin.createInvite({
          actor: input.actorParty,
          kind: input.kind,
          displayName: input.displayName,
        }),
      balance() {
        return asset.balance(config.parties.treasury).then(
          (balance) => balance,
          () => null,
        );
      },
      async mandate() {
        const mandate = await ledger.reader.mandate();
        return mandate ? buildMandateView(config, mandate, mandate.payload.treasurer, names) : null;
      },
      parties,
    },
    history: {
      async payments(filter) {
        const payments = await ledger.reader.payments();
        const rows = payments.filter((p) => {
          const day = p.payload.executedAt.slice(0, 10);
          return (
            (filter.holder === undefined || p.payload.holder === filter.holder) &&
            (filter.from === undefined || day >= filter.from) &&
            (filter.to === undefined || day <= filter.to)
          );
        });
        return Promise.all(
          rows.map(async (p) => ({
            holder: await names.ref(p.payload.holder),
            cycleLabel: p.payload.cycleLabel,
            amount: p.payload.amount,
            at: p.payload.executedAt,
            status: p.payload.status === 'Paid' ? 'paid' : 'awaiting-acceptance',
          })),
        );
      },
    },
  };
}
