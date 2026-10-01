import { randomInt } from 'node:crypto';
import {
  AuditRecordKindSchema,
  type AuditRecordKind,
  type AuditRequestDetail,
  type AuditRequestStatus,
  type AuditRequestView,
  type AuditRequestsResponse,
  type CreateAuditRequest,
  type DenyAccessRequest,
  type EvidenceRoom,
  type GrantAccessRequest,
  type GrantView,
  type RecordPreview,
  type ScopeItemView,
} from '@mithra/shared';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ActivityLog } from '../activity/log';
import type { Config } from '../config/env';
import { plural } from '../cycle/format';
import type { Database } from '../db';
import { activityLog, txRefs } from '../db/schema';
import type { Audience, EventBus } from '../events/bus';
import { ApiError } from '../http/errors';
import {
  AccessGrantSchema,
  choiceResults,
  createdIn,
  type AccessClosed,
  type AccessDenied,
  type AccessGrant,
  type AuditRequest,
  type Contract,
  type EvidenceRef,
  type Ledger,
} from '../ledger';
import { shortPartyId, type PartyNames } from '../parties/names';
import { createAuditRoutesPlugin } from '../routes/audit';
import { createAuditCatalog, kindOfRecordId, type AuditCatalog } from './catalog';
import {
  auditorTxLink,
  createRedactor,
  evidenceMarkdown,
  holderLabelsFor,
  paymentCidsOf,
  previewDecision,
  previewOutcome,
  previewUnavailable,
  toEvidenceRecords,
  approversOf,
  type EvidenceContext,
} from './evidence';

/**
 * The audit flow (userflow section 11; specs L8, L9, A8, A9). The auditor's request, the treasurer's
 * grant, denial or revocation, the evidence room and the working-paper export. The ledger is the
 * source of truth for who may see what: the evidence room is built only from the auditor's own
 * `SharedRecord` contracts, read as the auditor.
 */

export type ExpiresIn = GrantAccessRequest['expiresIn'];

/** How long each choice of the treasurer's grant lasts. */
export const GRANT_DURATIONS_MS: Readonly<Record<ExpiresIn, number>> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/** The expiry of a grant made at `now`. */
export function expiresAtFor(
  expiresIn: ExpiresIn,
  now: Date,
  durations: Readonly<Record<ExpiresIn, number>> = GRANT_DURATIONS_MS,
): Date {
  return new Date(now.getTime() + durations[expiresIn]);
}

/** `audit-<yyyymmdd>-<6 characters>`, the id of a request. */
export const REQUEST_ID_PATTERN = /^audit-\d{8}-[a-z0-9]{6}$/;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function newRequestId(now: Date, pick: (n: number) => number = randomInt): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  let suffix = '';
  for (let i = 0; i < 6; i += 1) suffix += ID_ALPHABET.charAt(pick(ID_ALPHABET.length));
  return `audit-${day}-${suffix}`;
}

/** The ledger's grant id of a request (`Org_GrantAccess` makes it `grant/<requestId>`). */
export function grantIdOf(requestId: string): string {
  return `grant/${requestId}`;
}

/** Accepts the grant id with or without its `grant/` prefix (a path segment may lose the slash). */
export function normalizeGrantId(id: string): string {
  return id.startsWith('grant/') ? id : grantIdOf(id);
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** `2026-10-08T12:00:00Z` -> `8 October 2026` (UTC). */
export function longDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()] ?? ''} ${date.getUTCFullYear()}`;
}

/** What the ledger says about one request, for `deriveStatus`. */
export interface StatusFacts {
  /** The `AuditRequest` is still active. */
  requestActive: boolean;
  /** The active `AccessGrant`, if any. */
  grant: { expiresAt: string } | null;
  /** An `AccessClosed` exists. */
  closed: boolean;
  /** An `AccessDenied` exists. */
  denied: boolean;
}

/**
 * pending (active request), granted (active grant), ended (closed, or past its expiry before the
 * agent has closed it: the auditor already lost access), denied, else withdrawn.
 */
export function deriveStatus(facts: StatusFacts, now: Date): AuditRequestStatus {
  if (facts.requestActive) return 'pending';
  if (facts.grant) {
    return Date.parse(facts.grant.expiresAt) <= now.getTime() ? 'ended' : 'granted';
  }
  if (facts.closed) return 'ended';
  if (facts.denied) return 'denied';
  return 'withdrawn';
}

// Activity entries that keep what the ledger no longer holds ---------------------------------------

const KIND_REQUESTED = 'audit.requested';
const KIND_SCOPE = 'audit.scope';
const KIND_GRANTED = 'audit.granted';
const KIND_DENIED = 'audit.denied';
const KIND_REVOKED = 'audit.revoked';
const KIND_WITHDRAWN = 'audit.withdrawn';
const KIND_VIEWED = 'audit.viewed';

/** The request as the auditor made it. The ledger drops it when the treasurer answers. */
const RequestSnapshotSchema = z.object({
  requestId: z.string(),
  auditor: z.string(),
  question: z.string(),
  scope: z.array(z.object({ recordId: z.string(), kind: z.string(), reason: z.string() })),
  excluded: z.string(),
  requestedAt: z.string(),
});
type RequestSnapshot = z.infer<typeof RequestSnapshotSchema>;

/** The grant as made. The ledger drops it (keeping only `AccessClosed`) when it closes. */
const GrantSnapshotSchema = z.object({
  grantId: z.string(),
  requestId: z.string(),
  grantedAt: z.string(),
  expiresAt: z.string(),
  recordIds: z.array(z.string()),
});
type GrantSnapshot = z.infer<typeof GrantSnapshotSchema>;

/** Only the treasurer reads the audit entries of the activity log. */
const TREASURER_ONLY: Audience = { roles: ['treasurer'] };

/** Message of the 409 a user-signed write returns on MainNet, until Grofty signing (M10) replaces it. */
export const SIGN_IN_WALLET_MESSAGE =
  'On MainNet this is signed in Grofty Wallet. Open it from the button on this page.';

/** Time window in which several views of one grant by one auditor count as one view session. */
export const VIEW_SESSION_MS = 10 * 60 * 1000;

export interface AuditServiceOptions {
  now?: () => Date;
  /** Replaces the grant durations (tests use a few seconds). */
  durationsMs?: Readonly<Record<ExpiresIn, number>>;
  /** Replaces `VIEW_SESSION_MS`. */
  viewSessionMs?: number;
}

export interface AuditModuleDeps {
  config: Config;
  db: Database;
  ledger: Pick<Ledger, 'client' | 'reader' | 'commands'>;
  names: PartyNames;
  activity: ActivityLog;
  bus: EventBus;
  options?: AuditServiceOptions;
}

export interface Viewer {
  partyId: string;
  /** The treasurer sees every request; an auditor only their own. */
  isTreasurer: boolean;
}

export interface AuditService {
  createRequest(auditor: string, body: CreateAuditRequest): Promise<AuditRequestDetail>;
  list(viewer: Viewer): Promise<AuditRequestsResponse>;
  detail(requestId: string, viewer: Viewer): Promise<AuditRequestDetail>;
  grant(
    requestId: string,
    treasurer: string,
    body: GrantAccessRequest,
  ): Promise<AuditRequestDetail>;
  deny(requestId: string, treasurer: string, body: DenyAccessRequest): Promise<AuditRequestDetail>;
  revoke(grantId: string, treasurer: string): Promise<AuditRequestDetail>;
  withdraw(requestId: string, auditor: string): Promise<AuditRequestDetail>;
  evidence(grantId: string, auditor: string): Promise<EvidenceRoom>;
  exportMarkdown(grantId: string, auditor: string): Promise<{ filename: string; markdown: string }>;
  /** Throws the 409 `sign_in_wallet` on MainNet, where these writes are signed in Grofty. */
  assertServerSigns(): void;
}

export interface AuditModule {
  /** A Fastify plugin: `app.register(module.routes)` after the session plugin. */
  routes: FastifyPluginAsync;
  /** Decision records and outcomes for the scope drafter (A8). */
  catalog: AuditCatalog;
  service: AuditService;
}

interface State {
  requests: Contract<AuditRequest>[];
  grants: Contract<AccessGrant>[];
  closed: Contract<AccessClosed>[];
  denied: Contract<AccessDenied>[];
  requested: Map<string, RequestSnapshot>;
  granted: Map<string, GrantSnapshot>;
  withdrawn: Set<string>;
}

function scopeKind(kind: string, recordId: string): AuditRecordKind {
  const parsed = AuditRecordKindSchema.safeParse(kind);
  return parsed.success ? parsed.data : (kindOfRecordId(recordId) ?? 'decision');
}

function notFound(): ApiError {
  return new ApiError(
    404,
    'not_found',
    'There is no such audit request. Check the link, or open the audit page from the menu.',
  );
}

function accessEnded(iso: string): ApiError {
  return new ApiError(
    410,
    'access_ended',
    `Access ended ${longDate(iso)}. Ask the fund for a new grant if you need these records again.`,
  );
}

/** Builds the audit service. */
export function createAuditService(deps: AuditModuleDeps, catalog: AuditCatalog): AuditService {
  const { config, db, ledger, names, activity, bus } = deps;
  const { reader, client, commands } = ledger;
  const now = deps.options?.now ?? ((): Date => new Date());
  const durations = deps.options?.durationsMs ?? GRANT_DURATIONS_MS;
  const viewSessionMs = deps.options?.viewSessionMs ?? VIEW_SESSION_MS;
  const symbol = config.asset.symbol;
  /** Last view session logged by this process, per auditor and grant (the log is the durable check). */
  const recentViews = new Map<string, number>();

  function assertServerSigns(): void {
    if (config.network === 'mainnet') {
      throw new ApiError(409, 'sign_in_wallet', SIGN_IN_WALLET_MESSAGE);
    }
  }

  async function logActivity(input: {
    actor: string;
    kind: string;
    subject: string;
    text: string;
    link: string;
    detail?: Record<string, unknown>;
  }): Promise<void> {
    await activity.record({
      actorParty: input.actor,
      kind: input.kind,
      subject: input.subject,
      text: input.text,
      link: input.link,
      ...(input.detail ? { detail: input.detail } : {}),
      audience: TREASURER_ONLY,
    });
  }

  function publish(requestId: string, treasurer: string, auditor: string): void {
    bus.publish({ type: 'audit', requestId }, { parties: [treasurer, auditor] });
  }

  async function loadState(): Promise<State> {
    const [requests, grants, closed, denied, rows] = await Promise.all([
      reader.auditRequests(),
      reader.grants(),
      reader.closed(),
      reader.denied(),
      db
        .select()
        .from(activityLog)
        .where(inArray(activityLog.kind, [KIND_REQUESTED, KIND_GRANTED, KIND_WITHDRAWN]))
        .orderBy(asc(activityLog.id)),
    ]);
    const requested = new Map<string, RequestSnapshot>();
    const granted = new Map<string, GrantSnapshot>();
    const withdrawn = new Set<string>();
    for (const row of rows) {
      if (row.kind === KIND_REQUESTED) {
        const parsed = RequestSnapshotSchema.safeParse(row.detail);
        if (parsed.success) requested.set(parsed.data.requestId, parsed.data);
      } else if (row.kind === KIND_GRANTED) {
        const parsed = GrantSnapshotSchema.safeParse(row.detail);
        if (parsed.success) granted.set(parsed.data.grantId, parsed.data);
      } else {
        withdrawn.add(row.subject);
      }
    }
    return { requests, grants, closed, denied, requested, granted, withdrawn };
  }

  function requestIds(state: State): string[] {
    const ids = new Set<string>();
    for (const r of state.requests) ids.add(r.payload.requestId);
    for (const g of state.grants) ids.add(g.payload.requestId);
    for (const c of state.closed) ids.add(c.payload.requestId);
    for (const d of state.denied) ids.add(d.payload.requestId);
    for (const id of state.requested.keys()) ids.add(id);
    for (const id of state.withdrawn) ids.add(id);
    return [...ids];
  }

  function scopeOf(
    items: readonly { recordId: string; kind: string; reason: string }[],
  ): ScopeItemView[] {
    return items.map((i) => ({
      recordId: i.recordId,
      kind: scopeKind(i.kind, i.recordId),
      label: catalog.labelFor(i.recordId),
      reason: i.reason,
    }));
  }

  /** The view of one request, from the ledger's contracts and the entries kept in the activity log. */
  async function viewOf(state: State, requestId: string): Promise<AuditRequestView | null> {
    const request = state.requests.find((r) => r.payload.requestId === requestId)?.payload;
    const grant = state.grants.find((g) => g.payload.requestId === requestId)?.payload;
    const closed = state.closed.find((c) => c.payload.requestId === requestId)?.payload;
    const denied = state.denied.find((d) => d.payload.requestId === requestId)?.payload;
    const snapshot = state.requested.get(requestId);
    const grantSnapshot = state.granted.get(grantIdOf(requestId));
    const auditor =
      request?.auditor ?? grant?.auditor ?? closed?.auditor ?? denied?.auditor ?? snapshot?.auditor;
    if (!auditor) return null;

    const status = deriveStatus(
      {
        requestActive: request !== undefined,
        grant: grant ?? null,
        closed: closed !== undefined,
        denied: denied !== undefined,
      },
      now(),
    );

    let grantView: GrantView | null = null;
    if (grant) {
      const expired = status === 'ended';
      grantView = {
        grantId: grant.grantId,
        grantedAt: grant.grantedAt,
        expiresAt: grant.expiresAt,
        recordIds: grant.recordIds,
        closedAt: expired ? grant.expiresAt : null,
        closedReason: expired ? 'expired' : null,
      };
    } else if (closed) {
      grantView = {
        grantId: closed.grantId,
        grantedAt: grantSnapshot?.grantedAt ?? closed.closedAt,
        expiresAt: grantSnapshot?.expiresAt ?? closed.closedAt,
        recordIds: grantSnapshot?.recordIds ?? [],
        closedAt: closed.closedAt,
        closedReason: closed.reason === 'revoked' ? 'revoked' : 'expired',
      };
    }

    const scopeItems =
      request?.scope ??
      snapshot?.scope ??
      (grantView?.recordIds ?? []).map((recordId) => ({
        recordId,
        kind: kindOfRecordId(recordId) ?? 'decision',
        reason: '',
      }));

    return {
      requestId,
      auditor: await names.ref(auditor),
      question: request?.question ?? snapshot?.question ?? grant?.question ?? '',
      scope: scopeOf(scopeItems),
      excluded: request?.excluded ?? snapshot?.excluded ?? '',
      requestedAt:
        request?.requestedAt ??
        snapshot?.requestedAt ??
        grant?.grantedAt ??
        closed?.closedAt ??
        denied?.at ??
        now().toISOString(),
      status,
      grant: grantView,
      denial: denied ? { reason: denied.reason, at: denied.at } : null,
    };
  }

  /** The request, or 404 when it does not exist or is not the viewer's (never a 403 with details). */
  async function viewFor(
    state: State,
    requestId: string,
    viewer: Viewer,
  ): Promise<AuditRequestView> {
    const view = await viewOf(state, requestId);
    if (!view || (!viewer.isTreasurer && view.auditor.partyId !== viewer.partyId)) {
      throw notFound();
    }
    return view;
  }

  async function previewOf(scope: readonly ScopeItemView[]): Promise<RecordPreview[]> {
    const [records, outcomes] = await Promise.all([reader.decisionRecords(), reader.outcomes()]);
    const decisions = new Map(records.map((r) => [r.payload.recordId, r.payload]));
    const byRecord = new Map(outcomes.map((o) => [o.payload.recordId, o.payload]));
    const outcomeOfDecision = new Map(outcomes.map((o) => [o.payload.decisionRecordId, o.payload]));
    return scope.map((item) => {
      if (item.kind === 'decision') {
        const d = decisions.get(item.recordId);
        return d
          ? previewDecision(d, outcomeOfDecision.get(d.recordId) ?? null, symbol)
          : previewUnavailable(item);
      }
      const o = byRecord.get(item.recordId);
      return o
        ? previewOutcome(o, decisions.get(o.decisionRecordId) ?? null, symbol)
        : previewUnavailable(item);
    });
  }

  async function detailOf(
    state: State,
    requestId: string,
    viewer: Viewer,
  ): Promise<AuditRequestDetail> {
    const request = await viewFor(state, requestId, viewer);
    return {
      request,
      preview: viewer.isTreasurer ? await previewOf(request.scope) : null,
    };
  }

  const asTreasurer = (treasurer: string): Viewer => ({ partyId: treasurer, isTreasurer: true });
  const asAuditor = (auditor: string): Viewer => ({ partyId: auditor, isTreasurer: false });

  async function activeRequest(
    requestId: string,
    auditorFilter?: string,
  ): Promise<{ request: Contract<AuditRequest>; state: State }> {
    const state = await loadState();
    const request = state.requests.find((r) => r.payload.requestId === requestId);
    if (request && (auditorFilter === undefined || request.payload.auditor === auditorFilter)) {
      return { request, state };
    }
    // Not pending, or not the auditor's: an auditor learns nothing about a request that is not theirs.
    const view = await viewOf(state, requestId);
    if (!view || (auditorFilter !== undefined && view.auditor.partyId !== auditorFilter)) {
      throw notFound();
    }
    throw new ApiError(
      409,
      'request_not_pending',
      'This request has already been answered or withdrawn. Refresh the page to see where it stands.',
    );
  }

  // Requests -------------------------------------------------------------------------------------

  async function createRequest(
    auditor: string,
    body: CreateAuditRequest,
  ): Promise<AuditRequestDetail> {
    const entries = new Map((await catalog()).map((e) => [e.recordId, e]));
    const seen = new Set<string>();
    const scope: { recordId: string; kind: AuditRecordKind; reason: string }[] = [];
    for (const item of body.items) {
      const entry = entries.get(item.recordId);
      if (!entry) {
        throw new ApiError(
          400,
          'unknown_record',
          `Record ${item.recordId} is not one of the fund's records. Ask the agent to draft the scope again.`,
        );
      }
      if (seen.has(item.recordId)) continue;
      seen.add(item.recordId);
      scope.push({ recordId: entry.recordId, kind: entry.kind, reason: item.reason });
    }
    const org = await reader.organization();
    if (!org) {
      throw new ApiError(
        409,
        'no_organization',
        'The fund has not finished setting up, so it cannot take audit requests yet.',
      );
    }
    const requestedAt = now();
    const requestId = newRequestId(requestedAt);
    await client.submit({
      actAs: [auditor],
      commands: [
        commands.createAuditRequest({
          auditor,
          treasury: config.parties.treasury,
          treasurer: org.payload.treasurer,
          agent: config.parties.agent,
          requestId,
          question: body.question,
          scope,
          excluded: body.excluded,
          requestedAt,
        }),
      ],
    });
    const auditorName = await names.name(auditor);
    const link = `/app/audit/${requestId}`;
    await logActivity({
      actor: auditor,
      kind: KIND_REQUESTED,
      subject: requestId,
      text: `Auditor ${auditorName} requested access: ${body.question}`,
      link,
      detail: {
        requestId,
        auditor,
        question: body.question,
        scope,
        excluded: body.excluded,
        requestedAt: requestedAt.toISOString(),
      } satisfies RequestSnapshot,
    });
    await logActivity({
      actor: auditor,
      kind: KIND_SCOPE,
      subject: requestId,
      text: `Scope: ${scope.length} ${scope.length === 1 ? 'record' : 'records'} proposed`,
      link,
      detail: { requestId, recordIds: scope.map((s) => s.recordId) },
    });
    publish(requestId, org.payload.treasurer, auditor);
    return detailOf(await loadState(), requestId, asAuditor(auditor));
  }

  async function list(viewer: Viewer): Promise<AuditRequestsResponse> {
    const state = await loadState();
    const views: AuditRequestView[] = [];
    for (const id of requestIds(state)) {
      const view = await viewOf(state, id);
      if (view && (viewer.isTreasurer || view.auditor.partyId === viewer.partyId)) views.push(view);
    }
    views.sort((a, b) =>
      a.requestedAt < b.requestedAt ? 1 : a.requestedAt > b.requestedAt ? -1 : 0,
    );
    return { requests: views };
  }

  async function detail(requestId: string, viewer: Viewer): Promise<AuditRequestDetail> {
    return detailOf(await loadState(), requestId, viewer);
  }

  async function withdraw(requestId: string, auditor: string): Promise<AuditRequestDetail> {
    const { request } = await activeRequest(requestId, auditor);
    await client.submit({
      actAs: [auditor],
      commands: [commands.auditRequestWithdraw(request.contractId)],
    });
    const name = await names.name(auditor);
    await logActivity({
      actor: auditor,
      kind: KIND_WITHDRAWN,
      subject: requestId,
      text: `Auditor ${name} withdrew the request`,
      link: `/app/audit/${requestId}`,
      detail: { requestId },
    });
    publish(requestId, request.payload.treasurer, auditor);
    return detailOf(await loadState(), requestId, asAuditor(auditor));
  }

  // The treasurer's answer ---------------------------------------------------------------------------

  async function grant(
    requestId: string,
    treasurer: string,
    body: GrantAccessRequest,
  ): Promise<AuditRequestDetail> {
    const { request } = await activeRequest(requestId);
    const org = await reader.organization();
    if (!org) throw notFound();
    const inScope = new Set(request.payload.scope.map((s) => s.recordId));
    const chosen = [...new Set(body.recordIds ?? request.payload.scope.map((s) => s.recordId))];
    const outside = chosen.filter((id) => !inScope.has(id));
    if (outside.length > 0) {
      throw new ApiError(
        400,
        'record_not_in_scope',
        `${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} not in the auditor's request. Share only records from the scope.`,
      );
    }
    const [records, outcomes] = await Promise.all([reader.decisionRecords(), reader.outcomes()]);
    const decisionCid = new Map(records.map((r) => [r.payload.recordId, r.contractId]));
    const outcomeCid = new Map(outcomes.map((o) => [o.payload.recordId, o.contractId]));
    const evidence: EvidenceRef[] = [];
    const kindOf = new Map(
      request.payload.scope.map((s) => [s.recordId, scopeKind(s.kind, s.recordId)]),
    );
    for (const recordId of chosen) {
      const kind = kindOf.get(recordId);
      const cid = kind === 'decision' ? decisionCid.get(recordId) : outcomeCid.get(recordId);
      if (!cid) {
        throw new ApiError(
          409,
          'record_unavailable',
          `Record ${recordId} is no longer on the ledger, so it cannot be shared. Leave it out and grant the rest.`,
        );
      }
      evidence.push(
        kind === 'decision'
          ? { tag: 'RefDecision', value: cid }
          : { tag: 'RefOutcome', value: cid },
      );
    }
    const expiresAt = expiresAtFor(body.expiresIn, now(), durations);
    const tx = await client.submit({
      actAs: [treasurer],
      commands: [
        commands.orgGrantAccess(org.contractId, {
          requestCid: request.contractId,
          expiresAt,
          evidence,
        }),
      ],
      shape: 'LEDGER_EFFECTS',
    });
    choiceResults.orgGrantAccess(tx);
    const created = createdIn(tx, 'Mithra.Audit:AccessGrant')
      .map((e) => AccessGrantSchema.safeParse(e.createArgument))
      .find((r) => r.success);
    const made = created?.success ? created.data : null;
    const snapshot: GrantSnapshot = {
      grantId: made?.grantId ?? grantIdOf(requestId),
      requestId,
      grantedAt: made?.grantedAt ?? now().toISOString(),
      expiresAt: made?.expiresAt ?? expiresAt.toISOString(),
      recordIds: made?.recordIds ?? chosen,
    };
    const auditorName = await names.name(request.payload.auditor);
    await logActivity({
      actor: treasurer,
      kind: KIND_GRANTED,
      subject: requestId,
      text: `Access granted to ${auditorName} until ${longDate(snapshot.expiresAt)} (${plural(chosen.length, 'record')})`,
      link: `/app/audit/${requestId}`,
      detail: snapshot,
    });
    publish(requestId, treasurer, request.payload.auditor);
    return detailOf(await loadState(), requestId, asTreasurer(treasurer));
  }

  async function deny(
    requestId: string,
    treasurer: string,
    body: DenyAccessRequest,
  ): Promise<AuditRequestDetail> {
    const { request } = await activeRequest(requestId);
    const org = await reader.organization();
    if (!org) throw notFound();
    await client.submit({
      actAs: [treasurer],
      commands: [
        commands.orgDenyAccess(org.contractId, {
          requestCid: request.contractId,
          reason: body.reason,
        }),
      ],
    });
    await logActivity({
      actor: treasurer,
      kind: KIND_DENIED,
      subject: requestId,
      text: 'Request denied',
      link: `/app/audit/${requestId}`,
      detail: { requestId, auditor: request.payload.auditor, reason: body.reason },
    });
    publish(requestId, treasurer, request.payload.auditor);
    return detailOf(await loadState(), requestId, asTreasurer(treasurer));
  }

  async function revoke(grantIdParam: string, treasurer: string): Promise<AuditRequestDetail> {
    const grantId = normalizeGrantId(grantIdParam);
    const state = await loadState();
    const active = state.grants.find((g) => g.payload.grantId === grantId);
    if (!active) {
      if (state.closed.some((c) => c.payload.grantId === grantId)) {
        throw new ApiError(
          409,
          'grant_closed',
          'This access has already ended. Refresh the page to see when.',
        );
      }
      throw new ApiError(404, 'not_found', 'There is no such access grant.');
    }
    await client.submit({
      actAs: [treasurer],
      commands: [commands.accessGrantRevoke(active.contractId)],
    });
    const name = await names.name(active.payload.auditor);
    await logActivity({
      actor: treasurer,
      kind: KIND_REVOKED,
      subject: grantId,
      text: `Access for ${name} revoked`,
      link: `/app/audit/${active.payload.requestId}`,
      detail: { requestId: active.payload.requestId, auditor: active.payload.auditor },
    });
    publish(active.payload.requestId, treasurer, active.payload.auditor);
    return detailOf(await loadState(), active.payload.requestId, asTreasurer(treasurer));
  }

  // Evidence room ------------------------------------------------------------------------------------

  /** At most one view session per auditor and grant in `viewSessionMs`: in memory, then in the log. */
  async function logViewSession(
    auditor: string,
    grantId: string,
    requestId: string,
    records: number,
  ): Promise<void> {
    const key = `${auditor}|${grantId}`;
    const at = now().getTime();
    const last = recentViews.get(key);
    if (last !== undefined && at - last < viewSessionMs) return;
    recentViews.set(key, at);
    try {
      const recent = await db
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.kind, KIND_VIEWED),
            eq(activityLog.subject, grantId),
            eq(activityLog.actorParty, auditor),
            gt(activityLog.createdAt, new Date(at - viewSessionMs)),
          ),
        )
        .limit(1);
      if (recent.length > 0) return;
      const name = await names.name(auditor);
      await logActivity({
        actor: auditor,
        kind: KIND_VIEWED,
        subject: grantId,
        text: `Auditor ${name} opened the evidence room (${plural(records, 'record')})`,
        link: `/app/audit/${requestId}`,
        detail: { requestId, auditor, records },
      });
    } catch (error) {
      recentViews.delete(key);
      throw error;
    }
  }

  /** Names of every holder of the fund, so a name in a memo is never shown even if not in this grant. */
  async function otherHolders(known: ReadonlySet<string>): Promise<string[]> {
    try {
      const register = await reader.register();
      const parties = new Set(register?.payload.changes.map((c) => c.holder) ?? []);
      return [...parties].filter((p) => !known.has(p));
    } catch {
      // Best effort: the labels already cover the holders of this grant's records.
      return [];
    }
  }

  async function evidenceContext(
    evidence: Parameters<typeof holderLabelsFor>[0],
  ): Promise<EvidenceContext> {
    const holderLabels = holderLabelsFor(evidence);
    const approverNames = new Map<string, string>();
    for (const approver of new Set(evidence.flatMap(approversOf))) {
      approverNames.set(approver, await names.name(approver));
    }
    const replacements = new Map<string, string>();
    for (const [party, label] of holderLabels) {
      replacements.set(party, label);
      replacements.set(shortPartyId(party), label);
      replacements.set(await names.name(party), label);
    }
    for (const party of await otherHolders(new Set(holderLabels.keys()))) {
      for (const text of [party, shortPartyId(party), await names.name(party)]) {
        if (!replacements.has(text)) replacements.set(text, 'another holder');
      }
    }
    const cids = [...new Set(evidence.flatMap(paymentCidsOf))];
    const updates = new Map<string, string>();
    if (cids.length > 0) {
      const rows = await db
        .select({ contractId: txRefs.contractId, updateId: txRefs.updateId })
        .from(txRefs)
        .where(and(inArray(txRefs.contractId, cids), eq(txRefs.kind, 'payment')));
      for (const row of rows) updates.set(row.contractId, row.updateId);
    }
    return {
      holderLabels,
      approverName: (party) => approverNames.get(party) ?? shortPartyId(party),
      updateIdOf: (cid) => updates.get(cid) ?? null,
      linkFor: (updateId) => auditorTxLink(config, updateId),
      redact: createRedactor(replacements),
    };
  }

  /**
   * The evidence room of a grant. Everything comes from the auditor's own view of the ledger:
   * the grant, its closing and its `SharedRecord` contracts are read as the auditor, so what the
   * ledger no longer shows to them, they no longer get (L8, L9).
   */
  async function evidence(grantIdParam: string, auditor: string): Promise<EvidenceRoom> {
    const grantId = normalizeGrantId(grantIdParam);
    const own = reader.as([auditor]);
    const [grants, closed] = await Promise.all([own.grants(), own.closed()]);
    const active = grants.find(
      (g) => g.payload.grantId === grantId && g.payload.auditor === auditor,
    );
    if (!active) {
      const ended = closed.find(
        (c) => c.payload.grantId === grantId && c.payload.auditor === auditor,
      );
      if (ended) throw accessEnded(ended.payload.closedAt);
      throw new ApiError(404, 'not_found', 'There is no such access grant.');
    }
    const g = active.payload;
    // Past its expiry the grant is over, even before the agent has closed it.
    if (Date.parse(g.expiresAt) <= now().getTime()) throw accessEnded(g.expiresAt);

    const shared = (await own.sharedRecords(auditor)).filter((r) => r.payload.grantId === grantId);
    const items = shared.map((r) => r.payload.evidence);
    const ctx = await evidenceContext(items);
    const room: EvidenceRoom = {
      grantId,
      question: g.question,
      grantedAt: g.grantedAt,
      expiresAt: g.expiresAt,
      records: toEvidenceRecords(items, ctx),
    };
    await logViewSession(auditor, grantId, g.requestId, room.records.length);
    return room;
  }

  async function exportMarkdown(
    grantIdParam: string,
    auditor: string,
  ): Promise<{ filename: string; markdown: string }> {
    const room = await evidence(grantIdParam, auditor);
    return {
      filename: `mithra-evidence-${room.grantId.replace(/[^A-Za-z0-9._-]+/g, '-')}.md`,
      markdown: evidenceMarkdown(room, symbol),
    };
  }

  return {
    createRequest,
    list,
    detail,
    grant,
    deny,
    revoke,
    withdraw,
    evidence,
    exportMarkdown,
    assertServerSigns,
  };
}

/**
 * The audit module: the service, the routes (a Fastify plugin to register after the session
 * plugin) and the catalog the scope drafter needs.
 */
export function createAuditModule(deps: AuditModuleDeps): AuditModule {
  const catalog = createAuditCatalog({ ledger: deps.ledger, names: deps.names });
  const service = createAuditService(deps, catalog);
  return { routes: createAuditRoutesPlugin({ service }), catalog, service };
}
