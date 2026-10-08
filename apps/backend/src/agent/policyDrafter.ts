import type { PartyRef, PolicyDraft } from '@mithra/shared';
import { ApiError } from '../http/errors';
import { LlmInvalidOutputError, LlmUnavailableError, type Llm, type LlmTool } from '../llm/client';
import { DraftPolicyArgsSchema, POLICY_DEFAULTS, resolveDraftPolicy } from './policyFields';
import type { AgentServices } from './services';
import type { AgentStore } from './store';
import { jsonSchemaOf } from './tools';
import { draftPolicyTool } from './tools/draftPolicy';
import { parseArguments } from './tools/types';

export interface PolicyDrafter {
  /** Drafts a policy from plain English and saves it as an agent draft. Never seals anything. */
  draftPolicy(prompt: string, party: string): Promise<PolicyDraft>;
}

const SYSTEM_PROMPT = [
  "You turn a treasurer's plain-English description of a distribution policy into structured fields. Answer by calling draft_policy.",
  'Use only what the treasurer said. Where they say nothing, leave the field out: the defaults are applied by code.',
  `Defaults: time zone ${POLICY_DEFAULTS.scheduleTimezone}, record date ${POLICY_DEFAULTS.recordDateRule}, deviation flag ${POLICY_DEFAULTS.deviationPct}% over ${POLICY_DEFAULTS.trailingCycles} cycles, unit change flag ${POLICY_DEFAULTS.unitChangePct}% over ${POLICY_DEFAULTS.unitChangeWindowDays} days, fee buffer ${POLICY_DEFAULTS.feeBuffer}.`,
  '"Monthly on the 1st" is the cron expression 0 9 1 * * (09:00). "Otherwise 2 of 3 approvals" means approvalThreshold 2.',
  'Name approvers (approverNames) only if the treasurer named them; otherwise leave it out and the organization approvers are used.',
  'You only draft. Nothing is applied until the treasurer seals it. You cannot seal or sign anything.',
].join('\n');

function toolFor(strict: boolean): LlmTool {
  return {
    name: draftPolicyTool.name,
    description: draftPolicyTool.description,
    parameters: jsonSchemaOf(draftPolicyTool, strict),
  };
}

const FORM_HINT = 'Fill in the policy form yourself; nothing was changed.';

export function createPolicyDrafter(deps: {
  llm: Llm;
  services: AgentServices;
  /** For `llm_unavailable` / `llm_invalid_output` events (A11). */
  store?: Pick<AgentStore, 'recordEvent'>;
  /** Must match what the LLM client sends (`LLM_STRICT_TOOLS`): strict tools need strict schemas. */
  strictTools?: boolean;
}): PolicyDrafter {
  const strict = deps.strictTools ?? false;
  async function recordEvent(kind: string, payload: Record<string, unknown>): Promise<void> {
    if (!deps.store) return;
    try {
      await deps.store.recordEvent(kind, payload);
    } catch {
      // The event is a diagnostic; the caller still gets its answer.
    }
  }

  return {
    async draftPolicy(prompt, party) {
      const parties = await deps.services.org.parties().catch((): PartyRef[] => []);
      const system =
        parties.length > 0
          ? `${SYSTEM_PROMPT}\nPeople known by name: ${parties.map((p) => p.displayName).join(', ')}.`
          : SYSTEM_PROMPT;
      let turn;
      try {
        turn = await deps.llm.chat({
          purpose: 'policy.draft',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
          tools: [toolFor(strict)],
          toolChoice: { name: draftPolicyTool.name },
        });
      } catch (error) {
        if (error instanceof LlmUnavailableError) {
          await recordEvent('llm_unavailable', {
            party,
            purpose: 'policy.draft',
            reason: error.reason,
          });
          throw new ApiError(
            503,
            'llm_unavailable',
            `The agent can't draft right now (${error.reason}). ${FORM_HINT}`,
          );
        }
        if (error instanceof LlmInvalidOutputError) {
          await recordEvent('llm_invalid_output', {
            party,
            purpose: 'policy.draft',
            why: error.message,
          });
          throw new ApiError(
            422,
            'llm_invalid_output',
            `The agent's draft was not usable (the model answered in a form I could not use). ${FORM_HINT}`,
          );
        }
        throw error;
      }

      const invalid = async (why: string): Promise<never> => {
        await recordEvent('llm_invalid_output', { party, purpose: 'policy.draft', why });
        throw new ApiError(
          422,
          'llm_invalid_output',
          `The agent's draft was not usable (${why}). ${FORM_HINT}`,
        );
      };

      const call = turn.toolCalls.find((c) => c.name === draftPolicyTool.name);
      if (!call) return invalid('it did not produce a policy');
      const parsed = parseArguments(DraftPolicyArgsSchema, call.arguments);
      if (!parsed.ok) return invalid(parsed.reason);
      const resolved = await resolveDraftPolicy(parsed.data, deps.services, party);
      if (!resolved.ok) {
        throw new ApiError(422, 'policy_incomplete', resolved.message);
      }
      return deps.services.policy.saveDraft(resolved.fields, 'agent', party);
    },
  };
}
