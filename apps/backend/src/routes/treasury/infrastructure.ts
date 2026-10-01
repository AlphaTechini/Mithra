import type { InfrastructureResponse } from '@mithra/shared';
import type { Config } from '../../config/env';
import type { LedgerClient } from '../../ledger';
import { ordinalWord } from './format';

/** One node answers within this time or it counts as offline. */
export const NODE_TIMEOUT_MS = 2000;
/** The infrastructure answer is reused for this long. */
export const INFRASTRUCTURE_TTL_MS = 30_000;

/**
 * The line under the node list (userflow 12). `online` counts nodes that answered; the treasury
 * keeps working while at least `threshold` of them are up.
 */
export function infrastructureSummary(online: number, total: number, threshold: number): string {
  if (online >= total) return `Running on ${online} of ${total} nodes`;
  if (online >= threshold) return `Still running on ${online} of ${total} nodes`;
  const wait =
    online > 0 ? `until a ${ordinalWord(online + 1)} node is back` : 'until a node is back';
  return `Below threshold: ${online} of ${total} nodes online. Payments and approvals wait ${wait}.`;
}

export interface InfrastructureChecker {
  get(): Promise<InfrastructureResponse>;
}

export interface InfrastructureDeps {
  config: Config;
  /** The ledger client; other nodes are reached with `atUrl`, using the same credentials. */
  client: LedgerClient;
  ttlMs?: number;
  now?: () => number;
}

/** Live node status for the Infrastructure panel; cached for 30 s. */
export function createInfrastructureChecker(deps: InfrastructureDeps): InfrastructureChecker {
  const { config } = deps;
  const ttlMs = deps.ttlMs ?? INFRASTRUCTURE_TTL_MS;
  const now = deps.now ?? Date.now;
  let cached: { value: InfrastructureResponse; at: number } | undefined;
  let inflight: Promise<InfrastructureResponse> | undefined;

  async function check(): Promise<InfrastructureResponse> {
    const treasuryParty = config.parties.treasury;
    if (config.network !== 'localnet') {
      return {
        treasuryParty,
        hostingThreshold: 1,
        nodes: [],
        summary: "Hosted by the operator's validator on MainNet",
      };
    }
    const nodes = await Promise.all(
      config.localnet.nodes.map(async (node) => {
        // One attempt, two seconds: a node that is slow counts as offline.
        const client = deps.client.atUrl(node.jsonApiUrl, {
          timeoutMs: NODE_TIMEOUT_MS,
          retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
        });
        const [version, parties] = await Promise.allSettled([
          client.version(),
          client.listParties(),
        ]);
        return {
          id: node.id,
          name: node.name,
          operator: node.operator,
          online: version.status === 'fulfilled',
          hostsTreasury:
            parties.status === 'fulfilled' && parties.value.some((p) => p.party === treasuryParty),
        };
      }),
    );
    const threshold = config.localnet.decmanGovernanceThreshold;
    const online = nodes.filter((n) => n.online).length;
    return {
      treasuryParty,
      hostingThreshold: threshold,
      nodes,
      summary: infrastructureSummary(online, nodes.length, threshold),
    };
  }

  return {
    async get() {
      if (cached && now() - cached.at < ttlMs) return cached.value;
      if (!inflight) {
        inflight = check()
          .then((value) => {
            cached = { value, at: now() };
            return value;
          })
          .finally(() => {
            inflight = undefined;
          });
      }
      return inflight;
    },
  };
}
