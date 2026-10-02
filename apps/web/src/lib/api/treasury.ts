/**
 * Typed calls for the treasurer and approver screens. Every response is parsed with the shared
 * Zod schema, so a backend that drifts from the contract fails loudly instead of rendering wrong
 * numbers. Paths are relative to `/api`.
 */
import {
  ActivityResponseSchema,
  AgentConversationSchema,
  CycleDetailSchema,
  CyclesResponseSchema,
  DecisionRecordViewSchema,
  DemoPartiesResponseSchema,
  HoldersResponseSchema,
  InfrastructureResponseSchema,
  InviteSchema,
  MandateViewSchema,
  OrgResponseSchema,
  OverviewResponseSchema,
  PolicyDraftSchema,
  RunCycleResponseSchema,
  SealStatusSchema,
  SendAgentMessageResponseSchema,
  type ActivityResponse,
  type AgentConversation,
  type CreateInviteRequest,
  type CreateOrgRequest,
  type CycleDetail,
  type CyclesResponse,
  type DecisionRecordView,
  type DemoParty,
  type HoldersResponse,
  type InfrastructureResponse,
  type Invite,
  type IssueUnitsRequest,
  type MandateView,
  type OrgResponse,
  type OverviewResponse,
  type PolicyDraft,
  type PolicyFields,
  type RunCycleRequest,
  type RunCycleResponse,
  type SealStatus,
  type SendAgentMessageResponse,
} from '@mithra/shared';
import { ApiError, apiGet, apiPost, apiPut } from './client';

// Organization and setup

export const getOrg = (): Promise<OrgResponse> => apiGet('/org', OrgResponseSchema);

export const createOrg = (request: CreateOrgRequest): Promise<void> =>
  apiPost('/org', null, request);

/** The LocalNet demo parties, for approver and holder pickers. Empty list when none. */
export async function getDemoParties(): Promise<DemoParty[]> {
  const response = await apiGet('/session/demo-parties', DemoPartiesResponseSchema);
  return response.parties;
}

/** The current policy draft, or null when there is none yet (404 `no_draft`). */
export async function getPolicyDraft(): Promise<PolicyDraft | null> {
  try {
    return await apiGet('/policy/draft', PolicyDraftSchema);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** Asks the agent to draft a policy from plain English. 503 `llm_unavailable` carries a message. */
export const draftPolicy = (prompt: string): Promise<PolicyDraft> =>
  apiPost('/policy/draft', PolicyDraftSchema, { prompt });

/** Replaces the draft's fields; the server recomputes the summary and the can/cannot lists. */
export const updatePolicyDraft = (fields: PolicyFields): Promise<PolicyDraft> =>
  apiPut('/policy/draft', PolicyDraftSchema, { fields });

export const sealMandate = (draftId: string): Promise<SealStatus> =>
  apiPost('/mandate/seal', SealStatusSchema, { draftId });

export const getSealStatus = (sealId: string): Promise<SealStatus> =>
  apiGet(`/mandate/seal/${encodeURIComponent(sealId)}`, SealStatusSchema);

export const getMandate = (): Promise<MandateView> => apiGet('/mandate', MandateViewSchema);

// Overview, treasury

export const getOverview = (): Promise<OverviewResponse> =>
  apiGet('/overview', OverviewResponseSchema);

/** LocalNet "Add funds". The new balance comes back with the next overview. */
export const fundTreasury = (amount: string): Promise<void> =>
  apiPost('/treasury/fund', null, { amount });

// Holders and invites

export const getHolders = (): Promise<HoldersResponse> => apiGet('/holders', HoldersResponseSchema);

export const issueUnits = (request: IssueUnitsRequest): Promise<void> =>
  apiPost('/holders/issue', null, request);

export const createInvite = (request: CreateInviteRequest): Promise<Invite> =>
  apiPost('/invites', InviteSchema, request);

// Cycles

export const getCycles = (): Promise<CyclesResponse> => apiGet('/cycles', CyclesResponseSchema);

export const runCycle = (request: RunCycleRequest): Promise<RunCycleResponse> =>
  apiPost('/cycles/run', RunCycleResponseSchema, request);

export const getCycle = (cycleId: string): Promise<CycleDetail> =>
  apiGet(`/cycles/${encodeURIComponent(cycleId)}`, CycleDetailSchema);

export const holdCycle = (cycleId: string): Promise<void> =>
  apiPost(`/cycles/${encodeURIComponent(cycleId)}/hold`, null, {});

export const releaseCycle = (cycleId: string): Promise<void> =>
  apiPost(`/cycles/${encodeURIComponent(cycleId)}/release`, null, {});

export const cancelCycle = (cycleId: string): Promise<void> =>
  apiPost(`/cycles/${encodeURIComponent(cycleId)}/cancel`, null, {});

/** Approve a proposal as the signed-in approver. Answers with the updated cycle (the ledger's count). */
export const approveProposal = (proposalId: string, note: string): Promise<CycleDetail> =>
  apiPost(`/proposals/${encodeURIComponent(proposalId)}/approve`, CycleDetailSchema, { note });

export const rejectProposal = (proposalId: string, reason: string): Promise<CycleDetail> =>
  apiPost(`/proposals/${encodeURIComponent(proposalId)}/reject`, CycleDetailSchema, { reason });

export const getDecisionRecord = (recordId: string): Promise<DecisionRecordView> =>
  apiGet(`/decision-records/${encodeURIComponent(recordId)}`, DecisionRecordViewSchema);

// Activity, infrastructure

export const getActivity = (limit = 100): Promise<ActivityResponse> =>
  apiGet(`/activity?limit=${limit}`, ActivityResponseSchema);

export const getInfrastructure = (): Promise<InfrastructureResponse> =>
  apiGet('/infrastructure', InfrastructureResponseSchema);

// Agent

export const getAgentConversation = (): Promise<AgentConversation> =>
  apiGet('/agent/messages', AgentConversationSchema);

export const sendAgentMessage = (text: string): Promise<SendAgentMessageResponse> =>
  apiPost('/agent/messages', SendAgentMessageResponseSchema, { text });
