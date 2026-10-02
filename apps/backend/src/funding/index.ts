import { randomUUID } from 'node:crypto';
import { toDecimal, formatDecimal } from '@mithra/shared';
import { z } from 'zod';
import type { Config } from '../config/env';
import {
  encodeDecimal,
  encodeExtraArgs,
  exerciseResultOf,
  type DisclosedContract,
  type Ledger,
  type LedgerCommand,
} from '../ledger';
import type { AssetAdapter } from '../wallet';

/** Interface id of the CIP-56 `TransferFactory`, the choice every transfer goes through. */
export const TRANSFER_FACTORY_INTERFACE =
  '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory';
/** Interface id of the CIP-56 `TransferInstruction`, a pending transfer a receiver can accept. */
export const TRANSFER_INSTRUCTION_INTERFACE =
  '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction';

/** A funding step failed; the message says which and what to do. */
export class FundingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FundingError';
  }
}

/**
 * The part of `@canton-network/wallet-sdk` this module uses, so tests can stub it. The SDK is
 * used only to build commands (tap, preapproval); they are submitted with the app's own ledger
 * client, because the SDK's submission path is made for external parties (wallet-sdk.md).
 */
export interface AmuletSdk {
  amulet: {
    /** `[command, disclosedContracts]` that mint `amount` to `partyId` (LocalNet and DevNet only). */
    tap(partyId: string, amount: string): Promise<readonly [unknown, readonly unknown[]]>;
    preapproval: {
      command: {
        /** The command that creates a transfer preapproval for `parties.receiver`. */
        create(args: { parties: { receiver: string } }): Promise<unknown>;
      };
    };
  };
}

/** What funding needs from the configuration. */
export type FundingConfig = Pick<
  Config,
  'network' | 'ledger' | 'parties' | 'asset' | 'registryUrl'
>;

export interface FundingDeps {
  config: FundingConfig;
  ledger: Pick<Ledger, 'client' | 'reader' | 'commands'>;
  asset: AssetAdapter;
  /** Builds the SDK on first use. Default: `createAmuletSdk(config, scanUrl)`. */
  sdk?: () => Promise<AmuletSdk>;
  /** Scan API URL for the SDK; derived from REGISTRY_URL when absent (see `deriveScanUrl`). */
  scanUrl?: string;
  now?: () => Date;
}

export interface FundingResult {
  /** The amount added, as given. */
  amount: string;
  /** True when the registry made the transfer pending and the agent accepted it for the treasury. */
  acceptedPending: boolean;
  tapUpdateId: string;
  transferUpdateId: string;
  acceptUpdateId: string | null;
}

/** LocalNet test funds and auto-receive (the two things only the registry's own SDK can build). */
export interface Funding {
  /** Taps CC to the operator, sends it to the treasury and accepts it for the treasury. */
  fundTreasury(amount: string): Promise<FundingResult>;
  /** Creates a CC transfer preapproval (auto-receive) for `receiver`, submitted as the receiver. */
  createPreapproval(receiver: string): Promise<void>;
}

const VALIDATOR_SUFFIX = /\/v0\/scan-proxy\/?$/;
/** The SV's scan on LocalNet (wallet SDK `localNetStaticConfig`). */
const LOCALNET_SCAN_URL = 'http://scan.localhost:4000/api/scan';

/**
 * The validator API URL from REGISTRY_URL: `…/api/validator/v0/scan-proxy` → `…/api/validator`.
 * Throws a FundingError that names REGISTRY_URL when it has another shape.
 */
export function deriveValidatorUrl(registryUrl: string): string {
  if (!VALIDATOR_SUFFIX.test(registryUrl)) {
    throw new FundingError(
      'Cannot work out the validator URL: REGISTRY_URL should end with /v0/scan-proxy (for example http://localhost:2000/api/validator/v0/scan-proxy).',
    );
  }
  return registryUrl.replace(VALIDATOR_SUFFIX, '');
}

/**
 * The scan API URL the SDK is configured with. The SDK only uses it for traffic status (CC
 * amounts and tap go through the validator's scan proxy), so a best guess is enough: an explicit
 * `override`, else LocalNet's SV scan for localhost, else `<validator origin>/api/scan`.
 */
export function deriveScanUrl(validatorUrl: string, override?: string): string {
  if (override) return override;
  const url = new URL(validatorUrl);
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return LOCALNET_SCAN_URL;
  return `${url.origin}/api/scan`;
}

/** The real SDK for the configured LocalNet. Loaded lazily: it is large and only used here. */
export async function createAmuletSdk(config: FundingConfig, scanUrl?: string): Promise<AmuletSdk> {
  const auth = config.ledger.auth;
  if (auth.mode !== 'unsafe-hmac') {
    throw new FundingError(
      'Adding test funds needs LEDGER_AUTH_MODE=unsafe-hmac, which is how LocalNet is set up.',
    );
  }
  const validatorUrl = deriveValidatorUrl(config.registryUrl);
  const tokenAuth = {
    method: 'self_signed' as const,
    issuer: 'unsafe-auth',
    credentials: {
      clientId: config.ledger.userId,
      clientSecret: auth.secret,
      audience: auth.audience,
      scope: '',
    },
  };
  const { SDK } = await import('@canton-network/wallet-sdk');
  return SDK.create({
    auth: tokenAuth,
    ledgerClientUrl: config.ledger.jsonApiUrl,
    token: { validatorUrl, registries: [config.registryUrl], auth: tokenAuth },
    amulet: {
      validatorUrl,
      scanApiUrl: deriveScanUrl(validatorUrl, scanUrl),
      auth: tokenAuth,
      registryUrl: config.registryUrl,
    },
  });
}

const CommandSchema = z.union([
  z.object({
    ExerciseCommand: z.object({
      templateId: z.string().min(1),
      contractId: z.string().min(1),
      choice: z.string().min(1),
      choiceArgument: z.record(z.string(), z.unknown()),
    }),
  }),
  z.object({
    CreateCommand: z.object({
      templateId: z.string().min(1),
      createArguments: z.record(z.string(), z.unknown()),
    }),
  }),
]);

const DisclosedSchema = z.object({
  templateId: z.string().min(1),
  contractId: z.string().min(1),
  createdEventBlob: z.string().min(1),
  synchronizerId: z.string().default(''),
});

/** Checks the shape of a command the SDK built, so a change in the SDK fails here, not on the ledger. */
export function toLedgerCommand(value: unknown, what: string): LedgerCommand {
  const parsed = CommandSchema.safeParse(value);
  if (!parsed.success) {
    throw new FundingError(
      `The wallet SDK returned an unexpected ${what} command. Check that @canton-network/wallet-sdk matches the LocalNet version.`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function toDisclosed(values: readonly unknown[], what: string): DisclosedContract[] {
  return values.map((value) => {
    const parsed = DisclosedSchema.safeParse(value);
    if (!parsed.success) {
      throw new FundingError(
        `The wallet SDK returned an unexpected disclosed contract for ${what}. Check that @canton-network/wallet-sdk matches the LocalNet version.`,
        { cause: parsed.error },
      );
    }
    return parsed.data;
  });
}

const TransferResultSchema = z.looseObject({
  output: z.discriminatedUnion('tag', [
    z.object({
      tag: z.literal('TransferInstructionResult_Pending'),
      value: z.object({ transferInstructionCid: z.string().min(1) }),
    }),
    z.object({ tag: z.literal('TransferInstructionResult_Completed'), value: z.unknown() }),
    z.object({ tag: z.literal('TransferInstructionResult_Failed'), value: z.unknown() }),
  ]),
});

const REQUESTED_AT_SKEW_MS = 60_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function createFunding(deps: FundingDeps): Funding {
  const { config, ledger, asset } = deps;
  const now = deps.now ?? (() => new Date());
  let sdkPromise: Promise<AmuletSdk> | undefined;

  function sdk(): Promise<AmuletSdk> {
    if (!sdkPromise) {
      const build = deps.sdk ?? (() => createAmuletSdk(config, deps.scanUrl));
      sdkPromise = build().catch((error: unknown) => {
        // Try again next time instead of keeping a failed start.
        sdkPromise = undefined;
        throw error;
      });
    }
    return sdkPromise;
  }

  /** Unlocked holdings of the operator, largest first, until they cover `amount`. */
  async function inputHoldings(operator: string, amount: string): Promise<string[]> {
    const holdings = (await asset.holdings(operator))
      .filter((h) => !h.locked)
      .sort((a, b) => toDecimal(b.amount).cmp(toDecimal(a.amount)));
    const chosen: string[] = [];
    let sum = toDecimal('0');
    for (const holding of holdings) {
      if (sum.gte(toDecimal(amount))) break;
      chosen.push(holding.contractId);
      sum = sum.plus(toDecimal(holding.amount));
    }
    if (sum.lt(toDecimal(amount))) {
      throw new FundingError(
        `The operator holds ${formatDecimal(sum)} ${config.asset.symbol} after the tap, less than the ${amount} to send. Check that the tap worked and try again.`,
      );
    }
    return chosen;
  }

  return {
    async fundTreasury(amount) {
      const { operator, treasury, agent } = config.parties;
      const value = encodeDecimal(amount);

      // (1) Tap CC to the operator party. The SDK builds the command; the app submits it.
      const [tapCommand, tapDisclosed] = await (await sdk()).amulet.tap(operator, value);
      const tapTx = await ledger.client.submit({
        actAs: [operator],
        commands: [toLedgerCommand(tapCommand, 'tap')],
        disclosedContracts: toDisclosed(tapDisclosed, 'the tap'),
        commandId: `fund-tap-${randomUUID()}`,
      });

      // (2) Send it from the operator to the treasury with the token standard.
      const leg = await asset.transferLeg({ sender: operator, receiver: treasury, amount: value });
      const instrument = asset.instrument();
      const at = now();
      const transferTx = await ledger.client.submit({
        actAs: [operator],
        commands: [
          {
            ExerciseCommand: {
              templateId: TRANSFER_FACTORY_INTERFACE,
              contractId: leg.leg.factoryCid,
              choice: 'TransferFactory_Transfer',
              choiceArgument: {
                expectedAdmin: instrument.admin,
                transfer: {
                  sender: operator,
                  receiver: treasury,
                  amount: value,
                  instrumentId: { admin: instrument.admin, id: instrument.id },
                  requestedAt: new Date(at.getTime() - REQUESTED_AT_SKEW_MS).toISOString(),
                  executeBefore: new Date(at.getTime() + ONE_DAY_MS).toISOString(),
                  inputHoldingCids: await inputHoldings(operator, value),
                  meta: { values: {} },
                },
                extraArgs: encodeExtraArgs(leg.leg.extraArgs),
              },
            },
          },
        ],
        disclosedContracts: leg.disclosed,
        commandId: `fund-transfer-${randomUUID()}`,
        shape: 'LEDGER_EFFECTS',
      });
      const result = TransferResultSchema.safeParse(
        exerciseResultOf(transferTx, 'TransferFactory_Transfer'),
      );
      if (!result.success) {
        throw new FundingError(
          'The registry answered the transfer in a form this app does not know.',
          {
            cause: result.error,
          },
        );
      }
      const { output } = result.data;
      if (output.tag === 'TransferInstructionResult_Failed') {
        throw new FundingError(
          'The registry refused the transfer to the treasury. Check the operator balance and try again.',
        );
      }
      if (output.tag === 'TransferInstructionResult_Completed') {
        return {
          amount: value,
          acceptedPending: false,
          tapUpdateId: tapTx.updateId,
          transferUpdateId: transferTx.updateId,
          acceptUpdateId: null,
        };
      }

      // (3) The transfer is pending: the treasury cannot submit, so the agent accepts for it.
      const instructionCid = output.value.transferInstructionCid;
      const org = await ledger.reader.organization();
      if (!org) {
        throw new FundingError(
          'The funds were sent but the treasury has no organization to accept them yet. Create the organization first, then add funds again.',
        );
      }
      const accept = await asset.acceptContext(instructionCid);
      const acceptTx = await ledger.client.submit({
        actAs: [agent],
        readAs: [treasury],
        commands: [
          ledger.commands.orgAcceptDeposit(org.contractId, {
            instructionCid,
            extraArgs: accept.extraArgs,
          }),
        ],
        disclosedContracts: accept.disclosed,
        commandId: `fund-accept-${instructionCid.slice(0, 24)}`,
      });
      return {
        amount: value,
        acceptedPending: true,
        tapUpdateId: tapTx.updateId,
        transferUpdateId: transferTx.updateId,
        acceptUpdateId: acceptTx.updateId,
      };
    },

    async createPreapproval(receiver) {
      const command = await (
        await sdk()
      ).amulet.preapproval.command.create({ parties: { receiver } });
      await ledger.client.submit({
        actAs: [receiver],
        commands: [toLedgerCommand(command, 'preapproval')],
        commandId: `preapproval-${randomUUID()}`,
      });
    },
  };
}
