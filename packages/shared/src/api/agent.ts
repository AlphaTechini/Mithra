import { z } from 'zod';
import {
  CycleStatusSchema,
  TimelineStepSchema,
  ActivityEntrySchema,
  SealStatusSchema,
} from './treasury';

/** One tool call shown as an action card (A10, userflow 8). */
export const ActionCardViewSchema = z.object({
  id: z.string(),
  /** Tool name, e.g. "create_cycle". */
  tool: z.string(),
  /** One line, e.g. "Created proposal for September, 4 payees, 1,200 CC". */
  title: z.string(),
  status: z.enum(['done', 'failed', 'needs-you']),
  summary: z.string().nullable(),
  details: z.array(z.object({ label: z.string(), value: z.string() })),
  /** In-app path to what the action touched, e.g. "/app/cycles/2026-09". */
  link: z.string().nullable(),
});
export type ActionCardView = z.infer<typeof ActionCardViewSchema>;

export const AgentMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  actions: z.array(ActionCardViewSchema),
  at: z.string(),
  /** Set when the agent could not use the language model (A11); the text says what still happened. */
  degraded: z.boolean(),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

/** GET /api/agent/messages → conversation of the signed-in treasurer or approver. */
export const AgentConversationSchema = z.object({
  messages: z.array(AgentMessageSchema),
  suggestions: z.array(z.string()),
});
export type AgentConversation = z.infer<typeof AgentConversationSchema>;

/** POST /api/agent/messages { text } → the new user message and the agent's reply. */
export const SendAgentMessageRequestSchema = z.object({ text: z.string().trim().min(1).max(2000) });
export type SendAgentMessageRequest = z.infer<typeof SendAgentMessageRequestSchema>;
export const SendAgentMessageResponseSchema = z.object({
  user: AgentMessageSchema,
  reply: AgentMessageSchema,
});
export type SendAgentMessageResponse = z.infer<typeof SendAgentMessageResponseSchema>;

/**
 * GET /api/events: Server-Sent Events. Each event's `event:` field is the `type` below and its
 * `data:` is the JSON of the matching object. Clients refetch the affected resource on receipt;
 * events never carry data the viewer could not fetch.
 */
export const LiveEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('timeline'), cycleId: z.string(), step: TimelineStepSchema }),
  z.object({ type: z.literal('cycle'), cycleId: z.string(), status: CycleStatusSchema }),
  z.object({ type: z.literal('seal'), seal: SealStatusSchema }),
  z.object({ type: z.literal('activity'), entry: ActivityEntrySchema }),
  z.object({
    type: z.literal('agent'),
    messageId: z.string(),
    action: z.lazy(() => ActionCardViewSchema),
  }),
  z.object({ type: z.literal('holder'), change: z.enum(['units', 'payments', 'auto-receive']) }),
  z.object({ type: z.literal('audit'), requestId: z.string() }),
]);
export type LiveEvent = z.infer<typeof LiveEventSchema>;
