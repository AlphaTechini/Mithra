import { PolicyFieldsSchema, type PartyRef, type PolicyFields } from '@mithra/shared';
import { DecimalString } from '@mithra/shared';
import { Cron } from 'croner';
import { z } from 'zod';
import { formatAmount } from './format';
import type { AgentServices } from './services';
import { knownParties, matchName } from './tools/types';

/** Defaults from userflow section 4 step 2, for what the treasurer's words do not say. */
export const POLICY_DEFAULTS = {
  scheduleTimezone: 'UTC',
  recordDateRule: 'last_day_of_previous_month',
  deviationPct: '50',
  trailingCycles: 3,
  unitChangePct: '100',
  unitChangeWindowDays: 3,
  feeBuffer: '1',
} as const;

export function isValidCron(expression: string): boolean {
  try {
    const job = new Cron(expression, { paused: true });
    job.stop();
    return true;
  } catch {
    return false;
  }
}

export function isValidTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const NonNegativeDecimal = DecimalString.refine((s) => !s.startsWith('-'), 'must not be negative');
const Cron5 = z.string().trim().min(1).refine(isValidCron, 'is not a valid cron expression');
const Timezone = z.string().trim().min(1).refine(isValidTimezone, 'is not a known time zone');
const RecordDateRule = z.enum(['last_day_of_previous_month', 'day_before_payment']);
const ApproverNames = z.array(z.string().trim().min(1).max(80)).max(10);

/** The model's arguments for `draft_policy`: approvers by name, defaults for what is not said. */
export const DraftPolicyArgsSchema = z.strictObject({
  cap: NonNegativeDecimal.describe(
    'Auto-pay cap in CC, e.g. "5000". The most the agent may pay without approvals.',
  ),
  approvalThreshold: z
    .number()
    .int()
    .positive()
    .describe('How many approvers must approve a proposal that needs approval, e.g. 2.'),
  approverNames: ApproverNames.optional().describe(
    'Names of the approvers, only if the treasurer named them. Leave out to use the organization approvers.',
  ),
  scheduleCron: Cron5.describe(
    'Cron expression of the schedule, e.g. "0 9 1 * *" for the 1st at 09:00.',
  ),
  scheduleTimezone: Timezone.default(POLICY_DEFAULTS.scheduleTimezone).describe(
    'IANA time zone. Default UTC.',
  ),
  recordDateRule: RecordDateRule.default(POLICY_DEFAULTS.recordDateRule).describe(
    'Which day decides who is paid. Default last_day_of_previous_month.',
  ),
  fixedAmount: NonNegativeDecimal.nullable()
    .optional()
    .describe('A fixed distribution amount if the treasurer gave one, otherwise null.'),
  deviationPct: NonNegativeDecimal.default(POLICY_DEFAULTS.deviationPct).describe(
    'Flag if the total deviates more than this percent from the trailing average. Default 50.',
  ),
  trailingCycles: z
    .number()
    .int()
    .positive()
    .default(POLICY_DEFAULTS.trailingCycles)
    .describe('How many previous cycles form the average. Default 3.'),
  unitChangePct: NonNegativeDecimal.default(POLICY_DEFAULTS.unitChangePct).describe(
    "Flag if a holder's units changed more than this percent shortly before the record date. Default 100.",
  ),
  unitChangeWindowDays: z
    .number()
    .int()
    .positive()
    .default(POLICY_DEFAULTS.unitChangeWindowDays)
    .describe('Days before the record date in which unit changes count. Default 3.'),
  feeBuffer: NonNegativeDecimal.default(POLICY_DEFAULTS.feeBuffer).describe(
    'CC kept in the treasury on top of the total for fees. Default 1.',
  ),
});
export type DraftPolicyArgs = z.output<typeof DraftPolicyArgsSchema>;

/** The model's arguments for `propose_mandate_change`: only what changes; the rest stays as sealed. */
export const MandateChangeArgsSchema = z.strictObject({
  cap: NonNegativeDecimal.optional().describe('New auto-pay cap in CC, e.g. "3000".'),
  approvalThreshold: z.number().int().positive().optional(),
  approverNames: ApproverNames.optional().describe(
    'The full new list of approver names, only if they change.',
  ),
  scheduleCron: Cron5.optional(),
  scheduleTimezone: Timezone.optional(),
  recordDateRule: RecordDateRule.optional(),
  fixedAmount: NonNegativeDecimal.nullable()
    .optional()
    .describe('New fixed amount, or null to remove it.'),
  deviationPct: NonNegativeDecimal.optional(),
  trailingCycles: z.number().int().positive().optional(),
  unitChangePct: NonNegativeDecimal.optional(),
  unitChangeWindowDays: z.number().int().positive().optional(),
  feeBuffer: NonNegativeDecimal.optional(),
});
export type MandateChangeArgs = z.output<typeof MandateChangeArgsSchema>;

export type PolicyResolution =
  { ok: true; fields: PolicyFields; approvers: PartyRef[] } | { ok: false; message: string };

const PICK_ON_FORM = 'Pick the approvers on the policy form; nothing was changed.';

async function resolveApprovers(
  names: readonly string[] | undefined,
  fallback: PartyRef[],
  services: AgentServices,
): Promise<{ ok: true; approvers: PartyRef[] } | { ok: false; message: string }> {
  if (names === undefined || names.length === 0) {
    return fallback.length > 0
      ? { ok: true, approvers: fallback }
      : {
          ok: false,
          message: `I need to know who the approvers are, and I could not find them. ${PICK_ON_FORM}`,
        };
  }
  const parties = await knownParties(services);
  const approvers: PartyRef[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    const match = matchName(name, parties);
    if (match.ok) {
      if (!approvers.some((a) => a.partyId === match.party.partyId)) approvers.push(match.party);
    } else {
      unknown.push(name);
    }
  }
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `I could not match ${unknown.map((n) => `"${n}"`).join(', ')} to a known person. ${PICK_ON_FORM}`,
    };
  }
  return { ok: true, approvers };
}

/** Approvers to use when the treasurer named none: the draft in progress, then the sealed Mandate. */
async function fallbackApprovers(services: AgentServices, party: string): Promise<PartyRef[]> {
  const draft = await services.policy.currentDraft(party);
  const mandate = await services.org.mandate();
  const ids = draft?.fields.approvers ?? [];
  if (ids.length > 0) {
    const known = await knownParties(services);
    const byId = new Map<string, PartyRef>(known.map((p) => [p.partyId, p]));
    for (const a of mandate?.terms.approvers ?? []) byId.set(a.partyId, a);
    return ids.map((id) => byId.get(id) ?? { partyId: id, displayName: id });
  }
  return mandate?.terms.approvers ?? [];
}

function finish(fields: Omit<PolicyFields, 'approvers'>, approvers: PartyRef[]): PolicyResolution {
  if (fields.approvalThreshold > approvers.length) {
    return {
      ok: false,
      message: `A threshold of ${fields.approvalThreshold} needs at least ${fields.approvalThreshold} approvers, and there ${approvers.length === 1 ? 'is' : 'are'} ${approvers.length}. ${PICK_ON_FORM}`,
    };
  }
  const candidate = { ...fields, approvers: approvers.map((a) => a.partyId) };
  const parsed = PolicyFieldsSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      message: `The drafted policy is not valid (${issue?.path.join('.') ?? 'policy'}: ${issue?.message ?? 'invalid'}). Fix it on the policy form; nothing was changed.`,
    };
  }
  return { ok: true, fields: parsed.data, approvers };
}

/** A new policy from `draft_policy` arguments; approver names are resolved here, not by the model. */
export async function resolveDraftPolicy(
  args: DraftPolicyArgs,
  services: AgentServices,
  party: string,
): Promise<PolicyResolution> {
  const approvers = await resolveApprovers(
    args.approverNames,
    await fallbackApprovers(services, party),
    services,
  );
  if (!approvers.ok) return approvers;
  const { approverNames: _names, ...rest } = args;
  void _names;
  return finish({ ...rest, fixedAmount: rest.fixedAmount ?? null }, approvers.approvers);
}

/** The sealed Mandate's terms as editable policy fields. */
export function fieldsOfMandate(terms: {
  cap: string;
  approvers: PartyRef[];
  approvalThreshold: number;
  scheduleCron: string;
  scheduleTimezone: string;
  recordDateRule: string;
  fixedAmount: string | null;
  deviationPct: string;
  trailingCycles: number;
  unitChangePct: string;
  unitChangeWindowDays: number;
  feeBuffer: string;
}): Omit<PolicyFields, 'approvers'> & { approvers: PartyRef[] } {
  return {
    cap: terms.cap,
    approvers: terms.approvers,
    approvalThreshold: terms.approvalThreshold,
    scheduleCron: terms.scheduleCron,
    scheduleTimezone: terms.scheduleTimezone,
    recordDateRule:
      terms.recordDateRule === 'day_before_payment'
        ? 'day_before_payment'
        : 'last_day_of_previous_month',
    fixedAmount: terms.fixedAmount,
    deviationPct: terms.deviationPct,
    trailingCycles: terms.trailingCycles,
    unitChangePct: terms.unitChangePct,
    unitChangeWindowDays: terms.unitChangeWindowDays,
    feeBuffer: terms.feeBuffer,
  };
}

export type ChangeResolution =
  | { ok: true; fields: PolicyFields; changes: { label: string; from: string; to: string }[] }
  | { ok: false; message: string };

const LABELS: Record<keyof Omit<PolicyFields, 'approvers'> | 'approvers', string> = {
  cap: 'Auto-pay cap',
  approvers: 'Approvers',
  approvalThreshold: 'Approval threshold',
  scheduleCron: 'Schedule (cron)',
  scheduleTimezone: 'Time zone',
  recordDateRule: 'Record date rule',
  fixedAmount: 'Fixed amount',
  deviationPct: 'Deviation flag (%)',
  trailingCycles: 'Trailing cycles',
  unitChangePct: 'Unit change flag (%)',
  unitChangeWindowDays: 'Unit change window (days)',
  feeBuffer: 'Fee buffer',
};

function show(key: keyof typeof LABELS, value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'string') {
    return key === 'cap' || key === 'fixedAmount' || key === 'feeBuffer'
      ? `${formatAmount(value)} CC`
      : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(String).join(', ');
  return JSON.stringify(value);
}

/** Applies a change on top of the sealed Mandate. Nothing is taken from the model but what it names. */
export async function resolveMandateChange(
  args: MandateChangeArgs,
  services: AgentServices,
): Promise<ChangeResolution> {
  const mandate = await services.org.mandate();
  if (!mandate) {
    return {
      ok: false,
      message:
        'There is no sealed Mandate yet, so there is nothing to change. Draft a policy first, then seal it.',
    };
  }
  const base = fieldsOfMandate(mandate.terms);
  const { approverNames, ...overrides } = args;
  let approvers = base.approvers;
  if (approverNames !== undefined && approverNames.length > 0) {
    const resolved = await resolveApprovers(approverNames, [], services);
    if (!resolved.ok) return resolved;
    approvers = resolved.approvers;
  }
  const { approvers: _sealedApprovers, ...sealed } = base;
  void _sealedApprovers;
  const next: Omit<PolicyFields, 'approvers'> = { ...sealed };
  const changes: { label: string; from: string; to: string }[] = [];
  const target: Record<string, unknown> = next;
  const before: Record<string, unknown> = { ...sealed };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    const k = key as keyof typeof LABELS;
    if (JSON.stringify(before[key]) !== JSON.stringify(value)) {
      changes.push({ label: LABELS[k], from: show(k, before[key]), to: show(k, value) });
    }
    target[key] = value;
  }
  if (approverNames !== undefined && approverNames.length > 0) {
    const from = base.approvers.map((p) => p.partyId).join();
    const to = approvers.map((p) => p.partyId).join();
    if (from !== to) {
      changes.push({
        label: LABELS.approvers,
        from: base.approvers.map((p) => p.displayName).join(', '),
        to: approvers.map((p) => p.displayName).join(', '),
      });
    }
  }
  if (changes.length === 0) {
    return {
      ok: false,
      message: 'That already matches the sealed Mandate, so there is no change to propose.',
    };
  }
  const result = finish(next, approvers);
  if (!result.ok) return result;
  return { ok: true, fields: result.fields, changes };
}

/** Short lines for an action card about a policy. */
export function policyDetails(
  fields: PolicyFields,
  approvers: PartyRef[],
): { label: string; value: string }[] {
  return [
    { label: 'Schedule', value: `${fields.scheduleCron} (${fields.scheduleTimezone})` },
    { label: 'Auto-pay cap', value: `${formatAmount(fields.cap)} CC` },
    {
      label: 'Approvals',
      value: `${fields.approvalThreshold} of ${approvers.length}: ${approvers.map((a) => a.displayName).join(', ')}`,
    },
    {
      label: 'Record date',
      value:
        fields.recordDateRule === 'last_day_of_previous_month'
          ? 'Last day of the previous month'
          : 'Day before payment',
    },
    {
      label: 'Fixed amount',
      value: fields.fixedAmount === null ? 'None' : `${formatAmount(fields.fixedAmount)} CC`,
    },
    {
      label: 'Flag if total deviates',
      value: `more than ${fields.deviationPct}% from the ${fields.trailingCycles}-cycle average`,
    },
    {
      label: 'Flag if units change',
      value: `more than ${fields.unitChangePct}% in ${fields.unitChangeWindowDays} days before the record date`,
    },
    { label: 'Fee buffer', value: `${formatAmount(fields.feeBuffer)} CC` },
  ];
}
