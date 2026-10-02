import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../db';
import { mainnetWallets } from '../db/schema';
import { ApiError } from '../http/errors';
import { parsePublicKey, partyMatchesKey, verifyMessageSignature } from './fingerprint';

/** How long a connection challenge can be answered. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export const INVALID_SIGNATURE_MESSAGE =
  "Grofty's signature did not match this wallet. Try connecting again.";

/** The wallet lookups the cycle engine and the routes use. */
export interface MainnetWalletLookup {
  /** MainNet party by holder party, for the holders that connected. */
  all(): Promise<Map<string, string>>;
  get(holder: string): Promise<{ partyId: string } | null>;
}

export interface Challenge {
  nonce: string;
  message: string;
}

export interface WalletRegistration {
  partyId: string;
  publicKey: string;
  signature: string;
  nonce: string;
}

interface PendingChallenge {
  holder: string;
  message: string;
  expiresAt: number;
}

/**
 * Holders' MainNet wallets. A holder proves control of a Grofty wallet by signing a challenge with
 * `signMessage`; the server checks that the party id belongs to the key that signed
 * (`fingerprint.ts`) and stores the pairing. Challenges are single use and expire after 5 minutes;
 * they are kept in memory (a restart only means asking Grofty to sign again).
 */
export class MainnetWallets implements MainnetWalletLookup {
  private readonly pending = new Map<string, PendingChallenge>();
  private readonly now: () => number;

  constructor(
    private readonly db: Database,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /** A fresh challenge for `holder`. `displayName` is the name the holder sees in Mithra. */
  challenge(holder: string, displayName: string): Challenge {
    const nowMs = this.now();
    for (const [nonce, entry] of this.pending) {
      if (entry.expiresAt <= nowMs) this.pending.delete(nonce);
    }
    const nonce = randomBytes(16).toString('hex');
    const message = [
      'Connect your Grofty Wallet to Mithra',
      `Holder: ${displayName}`,
      `Nonce: ${nonce}`,
      `Issued: ${new Date(nowMs).toISOString()}`,
    ].join('\n');
    this.pending.set(nonce, { holder, message, expiresAt: nowMs + CHALLENGE_TTL_MS });
    return { nonce, message };
  }

  /**
   * Verifies the wallet and stores it for `holder`. The nonce is used up by the first attempt,
   * successful or not, so a captured signature cannot be tried again.
   */
  async register(holder: string, input: WalletRegistration): Promise<{ partyId: string }> {
    const entry = this.pending.get(input.nonce);
    this.pending.delete(input.nonce);
    if (!entry || entry.holder !== holder || entry.expiresAt <= this.now()) {
      throw new ApiError(
        400,
        'invalid_nonce',
        'This connection request expired or was already used. Connect again.',
      );
    }
    const publicKey = parsePublicKey(input.publicKey);
    const valid =
      publicKey !== null &&
      partyMatchesKey(input.partyId, publicKey) &&
      verifyMessageSignature(entry.message, input.signature, publicKey);
    if (!valid || !publicKey) {
      throw new ApiError(401, 'invalid_signature', INVALID_SIGNATURE_MESSAGE);
    }
    const [taken] = await this.db
      .select({ holderParty: mainnetWallets.holderParty })
      .from(mainnetWallets)
      .where(eq(mainnetWallets.mainnetParty, input.partyId))
      .limit(1);
    if (taken && taken.holderParty !== holder) {
      throw new ApiError(
        409,
        'wallet_in_use',
        'This Grofty wallet is already connected to another holder. Use a different wallet.',
      );
    }
    const values = {
      holderParty: holder,
      mainnetParty: input.partyId,
      publicKey: input.publicKey,
      verifiedAt: new Date(this.now()),
    };
    await this.db
      .insert(mainnetWallets)
      .values(values)
      .onConflictDoUpdate({ target: mainnetWallets.holderParty, set: values });
    return { partyId: input.partyId };
  }

  async get(holder: string): Promise<{ partyId: string } | null> {
    const [row] = await this.db
      .select({ mainnetParty: mainnetWallets.mainnetParty })
      .from(mainnetWallets)
      .where(eq(mainnetWallets.holderParty, holder))
      .limit(1);
    return row ? { partyId: row.mainnetParty } : null;
  }

  async all(): Promise<Map<string, string>> {
    const rows = await this.db.select().from(mainnetWallets);
    return new Map(rows.map((r) => [r.holderParty, r.mainnetParty]));
  }
}
