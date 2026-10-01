import type { SealStatus } from '@mithra/shared';
import type { ActivityLog } from '../activity/log';
import type { Config, LocalnetConfig, LocalnetNode } from '../config/env';
import { formatAmount } from '../cycle/format';
import { TREASURY_TEAM, type EventBus } from '../events/bus';
import { ApiError } from '../http/errors';
import { createdIn, type Ledger } from '../ledger';
import type { SealRequestRow } from '../db/schema';
import {
  emptyProgress,
  newSealId,
  prepareSeal,
  progressOf,
  sealStatusOf,
  type MandateSealer,
  type SealPrepareDeps,
  type SealProgress,
  type SealStore,
} from './sealer';

/** The action label the Mithra governed action reports (`actionLabel` in Mithra.Governance). */
export const SEAL_ACTION_LABEL = 'MithraSealMandate';

/** A DecMan call that failed; `status` 0 means no answer. */
export class DecmanError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DecmanError';
  }
}

export interface DecmanSealerDeps extends SealPrepareDeps {
  config: Config;
  ledger: Pick<Ledger, 'client' | 'reader' | 'commands'>;
  store: SealStore;
  activity?: ActivityLog;
  bus?: EventBus;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Per request timeout for DecMan. Default 10 s. */
  timeoutMs?: number;
  /** A governed action that did not seal this long after execution is reported as failed. Default 10 minutes. */
  executeTimeoutMs?: number;
}

/** What `GET /governance/confirmations` says about one governed action. */
export interface ParsedConfirmations {
  cids: string[];
  /** Parties (node members) that confirmed, when DecMan names them. */
  confirmers: string[];
  canExecute: boolean;
}

const CID_KEYS = ['contract_id', 'confirmation_cid', 'cid', 'id', 'contractId'] as const;
const CONFIRMER_KEYS = [
  'confirmer',
  'confirmer_party',
  'member_party',
  'party',
  'party_id',
  'participant_party',
] as const;

function firstString(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const found = value[key];
    if (typeof found === 'string' && found !== '') return found;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads DecMan's confirmations for the governed action whose proposal is `proposalCid`. Tolerant of
 * the exact nesting (the same approach as scripts/lib/common.sh): any object with a `confirmations`
 * array that mentions the proposal contract id counts; each confirmation is a contract id string or
 * an object with a contract id and, when DecMan names it, the confirming member party.
 */
export function parseConfirmations(json: unknown, proposalCid: string): ParsedConfirmations {
  const cids = new Set<string>();
  const confirmers = new Set<string>();
  let canExecute = false;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;
    if (Array.isArray(value['confirmations']) && JSON.stringify(value).includes(proposalCid)) {
      if (value['can_execute'] === true || value['canExecute'] === true) canExecute = true;
      for (const entry of value['confirmations']) {
        if (typeof entry === 'string') cids.add(entry);
        else if (isRecord(entry)) {
          const cid = firstString(entry, CID_KEYS);
          if (cid) cids.add(cid);
          const confirmer = firstString(entry, CONFIRMER_KEYS);
          if (confirmer) confirmers.add(confirmer);
        }
      }
      return;
    }
    Object.values(value).forEach(visit);
  };
  visit(json);
  return { cids: [...cids], confirmers: [...confirmers], canExecute };
}

/**
 * The LocalNet sealer. Steps, all server-side (N3):
 * 1. the treasurer signs a `MandateSealRequest` from the draft (L6);
 * 2. the operator creates a `MandateChangeProposal` (a governed action, treasury = governance party);
 * 3. the backend confirms it on every DecMan node with `autoConfirm` (other nodes confirm in their
 *    own DecMan UI);
 * 4. once the confirmations reach the governance threshold the action is executed, which runs
 *    `Org_ApplySeal` with the treasury's authority and creates the Mandate (N8).
 *
 * DecMan responses assumed (see `parseConfirmations`): `POST /governance/confirm` and
 * `POST /governance/execute` answer 2xx on success; `GET /governance/confirmations?party_id=`
 * lists `domain_actions[]` with `proposal_cid`, `confirmations[]` and optionally `can_execute`.
 */
export function createDecmanSealer(deps: DecmanSealerDeps): MandateSealer {
  const { config, ledger, store } = deps;
  const configured = config.localnet;
  if (config.network !== 'localnet' || !configured) {
    throw new Error('The DecMan sealer is for LocalNet; MainNet signs in Grofty');
  }
  const local: LocalnetConfig = configured;
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const executeTimeoutMs = deps.executeTimeoutMs ?? 10 * 60 * 1000;
  const treasury = config.parties.treasury;
  const rulesCid = local.decmanGovernanceRulesCid;
  const confirming = local.nodes.filter((n) => n.autoConfirm);

  async function decman(
    node: LocalnetNode,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const url = `${node.decmanUrl.replace(/\/+$/, '')}${path}`;
    let response: Response;
    try {
      response = await doFetch(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new DecmanError(
        `The Decentralization Manager of ${node.name} did not answer at ${node.decmanUrl}. Check that the node is running.`,
        0,
      );
    }
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      throw new DecmanError(
        `The Decentralization Manager of ${node.name} answered HTTP ${response.status} for ${path}${text ? `: ${text.slice(0, 200)}` : ''}`,
        response.status,
      );
    }
    if (text === '') return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  const actionBody = (proposalCid: string): Record<string, unknown> => ({
    party_id: treasury,
    rules_contract_id: rulesCid,
    action: { type: 'generic_vote', description: SEAL_ACTION_LABEL },
    governance_type: 'core_domain',
    proposal_cid: proposalCid,
  });

  async function confirmOn(node: LocalnetNode, proposalCid: string): Promise<void> {
    await decman(node, 'POST', '/governance/confirm', actionBody(proposalCid));
  }

  function publish(row: SealRequestRow): SealStatus {
    const status = sealStatusOf(row, config);
    deps.bus?.publish({ type: 'seal', seal: status }, TREASURY_TEAM);
    return status;
  }

  async function sealed(row: SealRequestRow, version: number): Promise<SealRequestRow> {
    const done = await store.update(row.sealId, {
      state: 'sealed',
      mandateVersion: version,
      error: null,
    });
    const mandate = await ledger.reader.mandate();
    if (deps.activity && mandate) {
      const t = mandate.payload.terms;
      await deps.activity
        .record({
          actorParty: row.treasurer,
          kind: 'mandate.sealed',
          subject: row.sealId,
          text: `Mandate v${mandate.payload.version} sealed: cap ${formatAmount(t.cap, config.asset.symbol)}, ${t.approvalThreshold} of ${t.approvers.length} approvals`,
          link: '/app/settings',
        })
        .catch(() => undefined);
    }
    return done;
  }

  async function pollConfirmations(
    row: SealRequestRow,
  ): Promise<{ parsed: ParsedConfirmations; errors: string[] }> {
    const errors: string[] = [];
    const order = [...confirming, ...local.nodes.filter((n) => !n.autoConfirm)];
    for (const node of order) {
      try {
        const json = await decman(
          node,
          'GET',
          `/governance/confirmations?party_id=${encodeURIComponent(treasury)}`,
        );
        return { parsed: parseConfirmations(json, row.governanceProposalCid ?? ''), errors };
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    return { parsed: { cids: [], confirmers: [], canExecute: false }, errors };
  }

  const sealer: MandateSealer = {
    async start(draftId, treasurer) {
      const prepared = await prepareSeal(deps, draftId, treasurer);
      const agent = config.parties.agent;
      // 1. The treasurer signs the request (L6).
      const requestTx = await ledger.client.submit({
        actAs: [treasurer],
        commands: [
          ledger.commands.createMandateSealRequest({
            treasury,
            treasurer,
            agent,
            terms: prepared.terms,
            agentExecutes: true,
            summary: prepared.summary,
            summaryFingerprint: prepared.summaryFingerprint,
            requestedAt: now(),
          }),
        ],
        shape: 'LEDGER_EFFECTS',
      });
      const sealRequestCid = createdIn(requestTx, 'Mithra.Mandate:MandateSealRequest')[0]
        ?.contractId;
      if (!sealRequestCid) throw new Error('The ledger did not return the seal request');

      const base = {
        sealId: newSealId(),
        draftId,
        treasurer,
        sealRequestCid,
        baseVersion: prepared.organization.payload.mandateVersion,
        mandateVersion: null,
      };
      // 2. The operator files the governed action.
      let proposalCid: string | undefined;
      try {
        const proposalTx = await ledger.client.submit({
          actAs: [config.parties.operator],
          commands: [
            ledger.commands.createMandateChangeProposal({
              governanceParty: treasury,
              proposer: config.parties.operator,
              orgCid: prepared.organization.contractId,
              sealRequestCid,
              currentMandateCid: prepared.currentMandate?.contractId ?? null,
              description: prepared.description,
            }),
          ],
          shape: 'LEDGER_EFFECTS',
        });
        proposalCid = createdIn(proposalTx, 'Mithra.Governance:MandateChangeProposal')[0]
          ?.contractId;
        if (!proposalCid) throw new Error('The ledger did not return the governed action');
      } catch (error) {
        // Do not leave a signed request hanging that nothing will ever execute.
        await ledger.client
          .submit({
            actAs: [treasurer],
            commands: [ledger.commands.sealRequestWithdraw(sealRequestCid)],
          })
          .catch(() => undefined);
        const message = error instanceof Error ? error.message : String(error);
        const failed = await store.insert({
          ...base,
          governanceProposalCid: null,
          state: 'failed',
          confirmations: { ...emptyProgress(), lastError: message },
          error: `The governed action could not be filed: ${message}`,
        });
        return publish(failed);
      }

      // 3. Confirm on the nodes whose operators turned on auto-confirm.
      const progress: SealProgress = emptyProgress();
      const errors: string[] = [];
      for (const node of confirming) {
        try {
          await confirmOn(node, proposalCid);
          progress.confirmedNodes.push(node.id);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      progress.count = progress.confirmedNodes.length;
      progress.lastError = errors[0] ?? null;
      const row = await store.insert({
        ...base,
        governanceProposalCid: proposalCid,
        state: 'awaiting-nodes',
        confirmations: progress,
        error: null,
      });
      await deps.activity
        ?.record({
          actorParty: treasurer,
          kind: 'mandate.seal-requested',
          subject: row.sealId,
          text: `Signed the request: ${prepared.description}`,
          link: '/app/settings',
        })
        .catch(() => undefined);
      return publish(row);
    },

    async status(sealId) {
      const row = await store.get(sealId);
      if (!row) throw new ApiError(404, 'seal_not_found', `There is no seal request ${sealId}.`);
      return sealStatusOf(row, config);
    },

    async advance(sealId) {
      let row = await store.get(sealId);
      if (!row) throw new ApiError(404, 'seal_not_found', `There is no seal request ${sealId}.`);
      if (row.state !== 'awaiting-nodes' || !row.governanceProposalCid) {
        return sealStatusOf(row, config);
      }
      const before = JSON.stringify(sealStatusOf(row, config));
      const proposalCid = row.governanceProposalCid;
      const progress = progressOf(row);

      // Sealed? The organization's version moves when Org_ApplySeal has run.
      const organization = await ledger.reader.organization();
      if (organization && organization.payload.mandateVersion > row.baseVersion) {
        row = await sealed(row, organization.payload.mandateVersion);
        return publish(row);
      }

      // A node that was offline when we confirmed gets another try.
      for (const node of confirming) {
        if (progress.confirmedNodes.includes(node.id)) continue;
        try {
          await confirmOn(node, proposalCid);
          progress.confirmedNodes.push(node.id);
        } catch {
          // Still offline or already confirmed in its own UI; the poll below tells which.
        }
      }

      const { parsed, errors } = await pollConfirmations(row);
      progress.confirmationCids = parsed.cids;
      progress.count = Math.max(parsed.cids.length, progress.confirmedNodes.length);
      progress.attributedNodes = Object.entries(local.decmanMemberParties)
        .filter(([, party]) => parsed.confirmers.includes(party))
        .map(([nodeId]) => nodeId);
      progress.lastError =
        errors.length > 0 && parsed.cids.length === 0 ? (errors[0] ?? null) : null;

      let error: string | null = row.error;
      let state: SealRequestRow['state'] = row.state;
      const reached = parsed.cids.length >= local.decmanGovernanceThreshold || parsed.canExecute;
      if (reached && progress.executedAt === null) {
        const target =
          local.nodes.find((n) => progress.confirmedNodes.includes(n.id)) ??
          confirming[0] ??
          local.nodes[0];
        if (target) {
          try {
            await decman(target, 'POST', '/governance/execute', {
              ...actionBody(proposalCid),
              confirmation_cids: parsed.cids,
              disclosed_contracts: [],
            });
            progress.executedAt = now().toISOString();
            progress.lastError = null;
          } catch (executeError) {
            const message =
              executeError instanceof Error ? executeError.message : String(executeError);
            progress.lastError = message;
            if (
              executeError instanceof DecmanError &&
              executeError.status >= 400 &&
              executeError.status < 500
            ) {
              state = 'failed';
              error = `The governed action could not be executed: ${message}`;
            }
          }
        }
      }
      if (
        state === 'awaiting-nodes' &&
        progress.executedAt !== null &&
        now().getTime() - new Date(progress.executedAt).getTime() > executeTimeoutMs
      ) {
        state = 'failed';
        error =
          'The nodes confirmed and the action was executed, but the Mandate did not appear. Check the Decentralization Manager logs, then seal again.';
      }
      row = await store.update(sealId, { state, error, confirmations: progress });
      const after = JSON.stringify(sealStatusOf(row, config));
      return after === before ? sealStatusOf(row, config) : publish(row);
    },

    pending: () => store.pendingIds(),
  };
  return sealer;
}
