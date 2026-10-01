import { z } from 'zod';
import { NetworkSchema } from '../network';

/** What a signed-in party is to the organization. A party can hold more than one role. */
export const RoleSchema = z.enum(['treasurer', 'approver', 'holder', 'auditor']);
export type Role = z.infer<typeof RoleSchema>;

export const SessionPartySchema = z.object({
  partyId: z.string(),
  /** Human name, e.g. "Treasurer" or "Holder A". Never another holder's name. */
  displayName: z.string(),
  roles: z.array(RoleSchema),
  /** Role the UI routes to first: treasurer > approver > auditor > holder. Null for an unknown party. */
  primaryRole: RoleSchema.nullable(),
});
export type SessionParty = z.infer<typeof SessionPartySchema>;

/** GET /api/session, and the body returned by sign-in and switch. */
export const SessionResponseSchema = z.object({
  network: NetworkSchema,
  /** True on LocalNet: the UI shows the "LocalNet test mode" badge and the role switcher. */
  testMode: z.boolean(),
  signedIn: z.boolean(),
  party: SessionPartySchema.nullable(),
});
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

/** One entry of the LocalNet role switcher. */
export const DemoPartySchema = z.object({
  partyId: z.string(),
  displayName: z.string(),
  roles: z.array(RoleSchema),
});
export type DemoParty = z.infer<typeof DemoPartySchema>;

/** GET /api/session/demo-parties (LocalNet only). */
export const DemoPartiesResponseSchema = z.object({ parties: z.array(DemoPartySchema) });
export type DemoPartiesResponse = z.infer<typeof DemoPartiesResponseSchema>;

/** POST /api/session/localnet/sign-in */
export const LocalnetSignInRequestSchema = z.object({ password: z.string().min(1) });
export type LocalnetSignInRequest = z.infer<typeof LocalnetSignInRequestSchema>;

/** POST /api/session/switch (LocalNet only) */
export const SwitchPartyRequestSchema = z.object({ partyId: z.string().min(1) });
export type SwitchPartyRequest = z.infer<typeof SwitchPartyRequestSchema>;
