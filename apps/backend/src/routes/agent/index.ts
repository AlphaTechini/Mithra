import {
  DraftPolicyRequestSchema,
  ScopeDraftSchema,
  SendAgentMessageRequestSchema,
  type AgentConversation,
  type PolicyDraft,
  type ScopeDraft,
  type SendAgentMessageResponse,
} from '@mithra/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Agent } from '../../agent/agent';
import type { PolicyDrafter } from '../../agent/policyDrafter';
import { labelForRecordId } from '../../audit/catalog';
import type { AuditScopeResult, ScopeDrafter } from '../../audit/scope';
import { requireRole, requireRoleOrNone, rolesOfRequest } from '../../auth/roles';
import { ApiError, parse } from '../../http/errors';
import { RateLimiter } from '../../http/rateLimit';

export interface AgentRouteOptions {
  agent: Pick<Agent, 'respond' | 'conversation'>;
  drafter: PolicyDrafter;
  scope: ScopeDrafter;
  /** Messages per party per window. Default 20 per minute. */
  messageLimit?: { limit: number; windowMs: number; now?: () => number };
}

/** Shown with a scope the rules drafted because the model could not (A11). */
export const RULES_SCOPE_NOTICE =
  'The agent could not use its language model, so the rules drafted this scope.';

/**
 * The scope as the API contract has it (`ScopeDraftSchema`): every item with its label, and a
 * notice when the rules, not the model, drafted it. The auditor's screen reads exactly this.
 */
export function scopeDraftView(result: AuditScopeResult): ScopeDraft {
  return ScopeDraftSchema.parse({
    items: result.items.map((item) => ({
      recordId: item.recordId,
      kind: item.kind,
      label: labelForRecordId(item.recordId),
      reason: item.reason,
    })),
    excluded: result.excluded,
    source: result.source,
    notice: result.source === 'rules' ? RULES_SCOPE_NOTICE : null,
  });
}

export const AuditScopeDraftRequestSchema = z.object({
  question: z.string().trim().min(1).max(1000),
});

function partyOf(request: FastifyRequest): string {
  const partyId = request.session?.partyId;
  if (!partyId) throw new ApiError(401, 'not_signed_in', 'Sign in and pick a party first.');
  return partyId;
}

export function agentRoutes(app: FastifyInstance, options: AgentRouteOptions): void {
  const limiter = new RateLimiter(options.messageLimit ?? { limit: 20, windowMs: 60_000 });

  app.get(
    '/api/agent/messages',
    { preHandler: requireRole('treasurer', 'approver') },
    async (request, reply): Promise<AgentConversation> => {
      void reply.header('cache-control', 'no-store');
      const { roles } = await rolesOfRequest(request);
      return options.agent.conversation({ partyId: partyOf(request), roles });
    },
  );

  app.post(
    '/api/agent/messages',
    { preHandler: requireRole('treasurer', 'approver') },
    async (request): Promise<SendAgentMessageResponse> => {
      const partyId = partyOf(request);
      const body = parse(SendAgentMessageRequestSchema, request.body);
      if (!limiter.allow(partyId)) {
        throw new ApiError(
          429,
          'too_many_requests',
          'You are sending messages too fast. Wait a moment, then try again.',
        );
      }
      const { roles } = await rolesOfRequest(request);
      return options.agent.respond({ partyId, roles, text: body.text });
    },
  );

  app.post(
    '/api/policy/draft',
    { preHandler: requireRole('treasurer') },
    async (request): Promise<PolicyDraft> => {
      const body = parse(DraftPolicyRequestSchema, request.body);
      return options.drafter.draftPolicy(body.prompt, partyOf(request));
    },
  );

  app.post(
    '/api/audit/scope/draft',
    { preHandler: requireRoleOrNone('auditor', 'treasurer') },
    async (request): Promise<ScopeDraft> => {
      const body = parse(AuditScopeDraftRequestSchema, request.body);
      return scopeDraftView(await options.scope.draft(body.question));
    },
  );
}
