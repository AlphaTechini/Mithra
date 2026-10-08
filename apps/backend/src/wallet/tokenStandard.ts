import { sumDecimals } from '@mithra/shared';
import { z } from 'zod';
import type { TokenProvider } from '../ledger/auth';
import type { LedgerClient } from '../ledger/client';
import { LfDecimal, encodeDecimal } from '../ledger/codec';
import {
  AnyValueSchema,
  InstrumentIdSchema,
  type ExtraArgs,
  type InstrumentId,
} from '../ledger/mithra/templates';
import type { DisclosedContract } from '../ledger/types';
import type { AssetAdapter, Holding, TransferLegInput, TransferLegResult } from './assetAdapter';

/** Interface id of the CIP-56 `Holding` interface, used to list holdings of any registry. */
export const HOLDING_INTERFACE_ID =
  '#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding';

/** The registry answered with an error or an unusable response. */
export class RegistryError extends Error {
  readonly status: number;

  constructor(message: string, status: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RegistryError';
    this.status = status;
  }
}

const HoldingViewSchema = z.object({
  owner: z.string(),
  instrumentId: InstrumentIdSchema,
  amount: LfDecimal,
  lock: z.unknown().nullable().optional(),
});

const DisclosedContractSchema = z.object({
  templateId: z.string(),
  contractId: z.string(),
  createdEventBlob: z.string(),
  synchronizerId: z.string(),
});

const ChoiceContextSchema = z.object({
  choiceContextData: z
    .object({ values: z.record(z.string(), AnyValueSchema).optional() })
    .loose()
    .nullish(),
  disclosedContracts: z.array(DisclosedContractSchema).default([]),
});

const TransferFactoryResponseSchema = z.object({
  factoryId: z.string().min(1),
  transferKind: z.enum(['direct', 'offer', 'self']),
  choiceContext: ChoiceContextSchema,
});

export interface TokenStandardAdapterOptions {
  ledger: LedgerClient;
  registryUrl: string;
  instrument: InstrumentId;
  /** Bearer token for registries that need one, such as a LocalNet validator's scan-proxy. */
  auth?: TokenProvider;
  fetch?: typeof fetch;
  /** Per request timeout. Default 15 s. */
  timeoutMs?: number;
  /** Clock for `requestedAt`/`executeBefore` in the factory lookup (tests). */
  now?: () => Date;
}

const REGISTRY_TIMEOUT_MS = 15_000;
/** How far back `requestedAt` is set, so clock differences with the registry never reject it. */
const REQUESTED_AT_SKEW_MS = 60_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function disclosedOf(items: z.infer<typeof DisclosedContractSchema>[]): DisclosedContract[] {
  return items.map((d) => ({
    templateId: d.templateId,
    contractId: d.contractId,
    createdEventBlob: d.createdEventBlob,
    synchronizerId: d.synchronizerId,
  }));
}

function extraArgsOf(context: z.infer<typeof ChoiceContextSchema>): ExtraArgs {
  return {
    context: { values: context.choiceContextData?.values ?? {} },
    meta: { values: {} },
  };
}

/** The asset adapter for any CIP-56 token standard registry. */
export function createTokenStandardAdapter(options: TokenStandardAdapterOptions): AssetAdapter {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? REGISTRY_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());
  const base = options.registryUrl.replace(/\/+$/, '');

  async function post<T extends z.ZodType>(
    path: string,
    body: unknown,
    schema: T,
  ): Promise<z.output<T>> {
    const url = `${base}${path}`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    const token = await options.auth?.getToken();
    if (token) headers['authorization'] = `Bearer ${token}`;
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw new RegistryError(
        `Cannot reach the token registry at ${base}. Check REGISTRY_URL and that the registry is running.`,
        0,
        { cause },
      );
    }
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      throw new RegistryError(
        `The token registry answered HTTP ${response.status} for ${path}${text ? `: ${text.slice(0, 200)}` : ''}`,
        response.status,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (cause) {
      throw new RegistryError(
        `The token registry sent a response that is not JSON for ${path}`,
        response.status,
        {
          cause,
        },
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new RegistryError(
        `The token registry sent an unexpected response for ${path}: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
        response.status,
      );
    }
    return parsed.data;
  }

  const adapter: AssetAdapter = {
    instrument: () => ({ ...options.instrument }),

    async holdings(party: string): Promise<Holding[]> {
      const active = await options.ledger.activeContracts({
        parties: [party],
        interfaceIds: [HOLDING_INTERFACE_ID],
      });
      const holdings: Holding[] = [];
      for (const contract of active) {
        const view = contract.interfaceViews.find((v) =>
          v.interfaceId.endsWith(':Splice.Api.Token.HoldingV1:Holding'),
        );
        if (!view) continue;
        const parsed = HoldingViewSchema.safeParse(view.viewValue);
        if (!parsed.success) continue;
        const h = parsed.data;
        if (h.owner !== party) continue;
        if (
          h.instrumentId.admin !== options.instrument.admin ||
          h.instrumentId.id !== options.instrument.id
        )
          continue;
        holdings.push({
          contractId: contract.contractId,
          owner: h.owner,
          instrument: h.instrumentId,
          amount: h.amount,
          locked: h.lock !== null && h.lock !== undefined,
        });
      }
      return holdings;
    },

    async balance(party: string): Promise<string> {
      const holdings = await adapter.holdings(party);
      return sumDecimals(holdings.filter((h) => !h.locked).map((h) => h.amount));
    },

    async transferLeg(input: TransferLegInput): Promise<TransferLegResult> {
      const requestedAt = new Date(now().getTime() - REQUESTED_AT_SKEW_MS);
      const choiceArguments = {
        expectedAdmin: options.instrument.admin,
        transfer: {
          sender: input.sender,
          receiver: input.receiver,
          amount: encodeDecimal(input.amount),
          instrumentId: { admin: options.instrument.admin, id: options.instrument.id },
          requestedAt: requestedAt.toISOString(),
          executeBefore: new Date(now().getTime() + ONE_DAY_MS).toISOString(),
          inputHoldingCids: [],
          meta: { values: {} },
        },
        // The registry wants the extra arguments empty: it fills in the context itself.
        extraArgs: { context: { values: {} }, meta: { values: {} } },
      };
      const result = await post(
        '/registry/transfer-instruction/v1/transfer-factory',
        { choiceArguments, excludeDebugFields: true },
        TransferFactoryResponseSchema,
      );
      return {
        leg: {
          holder: input.receiver,
          factoryCid: result.factoryId,
          extraArgs: extraArgsOf(result.choiceContext),
        },
        disclosed: disclosedOf(result.choiceContext.disclosedContracts),
        kind: result.transferKind,
      };
    },

    async acceptContext(instructionCid: string) {
      const context = await post(
        `/registry/transfer-instruction/v1/${encodeURIComponent(instructionCid)}/choice-contexts/accept`,
        { meta: {}, excludeDebugFields: true },
        ChoiceContextSchema,
      );
      return {
        extraArgs: extraArgsOf(context),
        disclosed: disclosedOf(context.disclosedContracts),
      };
    },
  };
  return adapter;
}
