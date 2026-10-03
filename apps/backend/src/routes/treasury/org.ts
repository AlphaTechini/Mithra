import type { MandateView, OrgResponse, PartyRef, SetupStep } from '@mithra/shared';
import type { Config } from '../../config/env';
import type { Contract, MithraPayloads } from '../../ledger';
import type { PartyNames } from '../../parties/names';
import { describeRecordDate, describeSchedule } from './format';

type Organization = Contract<MithraPayloads['Organization']>;
type Mandate = Contract<MithraPayloads['Mandate']>;
type Charter = Contract<MithraPayloads['TreasuryCharter']>;

/** The symbol shown for an instrument: the configured one when it is the configured asset. */
export function assetSymbolOf(config: Config, asset: { admin: string; id: string }): string {
  return asset.admin === config.asset.adminParty && asset.id === config.asset.id
    ? config.asset.symbol
    : asset.id;
}

/**
 * Where first-time setup stands, from what the ledger shows (userflow 4):
 * `charter` when neither a charter nor an organization exists, `organization` when only the
 * charter does, `policy` while the organization has no Mandate (drafts live off-ledger, so the
 * frontend moves between policy and mandate itself), `done` once a Mandate exists.
 */
export function setupStepOf(state: {
  charter: Charter | null;
  organization: Organization | null;
  mandate: Mandate | null;
}): SetupStep {
  if (state.mandate) return 'done';
  if (state.organization) return 'policy';
  if (state.charter) return 'organization';
  return 'charter';
}

export async function buildMandateView(
  config: Config,
  mandate: Mandate,
  treasurer: string,
  names: PartyNames,
): Promise<MandateView> {
  const t = mandate.payload.terms;
  return {
    version: mandate.payload.version,
    terms: {
      cap: t.cap,
      approvers: await names.refs(t.approvers),
      approvalThreshold: t.approvalThreshold,
      assetSymbol: assetSymbolOf(config, t.asset),
      scheduleCron: t.scheduleCron,
      scheduleTimezone: t.scheduleTimezone,
      scheduleText: describeSchedule(t.scheduleCron, t.scheduleTimezone),
      recordDateRule: t.recordDateRule,
      recordDateText: describeRecordDate(t.recordDateRule),
      fixedAmount: t.fixedAmount,
      deviationPct: t.deviationPct,
      trailingCycles: t.trailingCycles,
      unitChangePct: t.unitChangePct,
      unitChangeWindowDays: t.unitChangeWindowDays,
      feeBuffer: t.feeBuffer,
    },
    agentExecutes: mandate.payload.agentExecutes,
    sealedAt: mandate.payload.sealedAt,
    sealedBy: await names.ref(treasurer),
    executedCycles: mandate.payload.executedCycles,
    // A Mandate exists only when the treasurer's signed request was applied: 1 of 1 (U3).
    seal: { required: 1, signed: 1 },
  };
}

export interface OrgState {
  charter: Contract<MithraPayloads['TreasuryCharter']> | null;
  organization: Organization | null;
  mandate: Mandate | null;
}

/** GET /api/org. `detail` false hides the organization for a party that has no role in it yet. */
export async function buildOrgResponse(
  config: Config,
  state: OrgState,
  names: PartyNames,
  options: { detail: boolean },
): Promise<OrgResponse> {
  const setupStep = setupStepOf(state);
  const org = state.organization;
  if (!org || !options.detail) return { setupStep, organization: null, mandate: null };
  const p = org.payload;
  const treasurer: PartyRef = await names.ref(p.treasurer);
  return {
    setupStep,
    organization: {
      name: p.name,
      treasury: await names.ref(p.treasury),
      treasurer,
      approvers: await names.refs(p.approvers),
      approvalThreshold: p.approvalThreshold,
      assetSymbol: assetSymbolOf(config, p.asset),
    },
    mandate: state.mandate
      ? await buildMandateView(config, state.mandate, p.treasurer, names)
      : null,
  };
}
