import type {
  CycleDetail,
  CycleSummary,
  HoldersResponse,
  Invite,
  MandateView,
  PartyRef,
  PolicyDraft,
  PolicyFields,
} from '@mithra/shared';
import type { Fingerprint } from '../ledger/mithra/templates';

/**
 * Everything the agent needs from the rest of the application. The agent depends on this
 * interface only; the application wires the real cycle engine, policy, holder and funding
 * services behind it. Tests use in-memory fakes.
 */
export interface AgentServices {
  cycles: {
    run(input: {
      trigger: 'schedule' | 'prompt' | 'manual';
      triggerDetail: string;
      cycleId?: string;
      total?: string;
      recordDate?: string;
      promptText?: string;
      modelFingerprints?: Fingerprint[];
      actorParty: string;
    }): Promise<{ cycleId: string }>;
    getCycle(cycleId: string): Promise<CycleDetail | null>;
    listCycles(): Promise<CycleSummary[]>;
  };
  policy: {
    saveDraft(fields: PolicyFields, source: 'agent', party: string): Promise<PolicyDraft>;
    currentDraft(party: string): Promise<PolicyDraft | null>;
  };
  org: {
    holders(): Promise<HoldersResponse>;
    issueUnits(input: { holder: string; units: number; actorParty: string }): Promise<void>;
    createInvite(input: {
      kind: 'holder' | 'auditor';
      displayName: string;
      actorParty: string;
    }): Promise<Invite>;
    balance(): Promise<string | null>;
    mandate(): Promise<MandateView | null>;
    /** Demo or invited parties the agent may refer to by name. */
    parties(): Promise<PartyRef[]>;
  };
  history: {
    payments(filter: { holder?: string; from?: string; to?: string }): Promise<
      {
        holder: PartyRef;
        cycleLabel: string;
        amount: string;
        at: string;
        status: string;
      }[]
    >;
  };
}
