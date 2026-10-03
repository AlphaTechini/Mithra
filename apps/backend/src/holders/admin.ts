import type { Invite } from '@mithra/shared';
import type { ActivityLog } from '../activity/log';
import type { Config } from '../config/env';
import type { Database } from '../db';
import { invites } from '../db/schema';
import type { EventBus } from '../events/bus';
import { ApiError } from '../http/errors';
import type { Ledger } from '../ledger';
import type { PartyNames } from '../parties/names';
import { formatAmount } from '../routes/treasury/format';
import { newInviteCode } from '../routes/treasury/invites';

/**
 * The two treasurer actions on holders that more than one caller needs: the REST routes
 * (`POST /api/holders/issue`, `POST /api/invites`) and the agent's tools. They share this code, so
 * a request made by chat is checked, signed and logged exactly like one made on the Holders page.
 */
export interface HolderAdmin {
  /** Issues units as the treasurer `actor`. The route has already checked the actor's role. */
  issueUnits(input: {
    actor: string;
    holder: string;
    units: number;
    /** `YYYY-MM-DD`, not in the future; default today. */
    effectiveDate?: string;
    /** Marks the units as demo history (seeding). */
    seeded?: boolean;
  }): Promise<void>;
  createInvite(input: {
    actor: string;
    kind: 'holder' | 'auditor';
    displayName: string;
    partyId?: string | undefined;
  }): Promise<Invite>;
}

export interface HolderAdminDeps {
  config: Config;
  ledger: Pick<Ledger, 'client' | 'reader' | 'commands'>;
  names: PartyNames;
  activity: ActivityLog;
  bus: EventBus;
  db: Database;
  now?: () => Date;
}

export function createHolderAdmin(deps: HolderAdminDeps): HolderAdmin {
  const { config, ledger, names, activity, bus, db } = deps;
  const { reader, client, commands } = ledger;
  const now = deps.now ?? (() => new Date());

  return {
    async issueUnits({ actor, holder, units, effectiveDate, seeded }) {
      const today = now().toISOString().slice(0, 10);
      const effective = effectiveDate ?? today;
      if (effective > today) {
        throw new ApiError(
          400,
          'future_date',
          'The effective date cannot be in the future. Pick today or an earlier date.',
        );
      }
      if (
        [config.parties.treasury, config.parties.agent, config.parties.operator, actor].includes(
          holder,
        )
      ) {
        throw new ApiError(
          400,
          'invalid_holder',
          "Units can only be issued to a holder, not to the treasury, the treasurer, the agent or the operator. Pick the holder's party.",
        );
      }
      const [organization, register] = await Promise.all([
        reader.organization(),
        reader.register(),
      ]);
      if (!organization || !register) {
        throw new ApiError(
          409,
          'no_organization',
          'There is no organization yet. Finish setup first, then issue units.',
        );
      }
      await client.submit({
        actAs: [actor],
        commands: [
          commands.orgIssueUnits(organization.contractId, {
            registerCid: register.contractId,
            holder,
            units,
            effectiveDate: effective,
            seeded: seeded ?? false,
          }),
        ],
      });
      bus.publish({ type: 'holder', change: 'units' }, { parties: [holder] });
      await activity.record({
        actorParty: actor,
        kind: 'units.issued',
        subject: holder,
        text: `Issued ${formatAmount(String(units))} units to ${await names.name(holder)}`,
        ...(seeded ? { seeded: true } : {}),
      });
    },

    async createInvite({ actor, kind, displayName, partyId }) {
      const org = await reader.organization();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const code = newInviteCode();
        const [row] = await db
          .insert(invites)
          .values({
            code,
            kind,
            partyId: partyId ?? null,
            displayName,
            createdBy: actor,
          })
          .onConflictDoNothing()
          .returning();
        if (!row) continue;
        // The invite names its party for the whole app (PartyNames reads it).
        names.invalidate();
        await activity.record({
          actorParty: actor,
          kind: 'invite.created',
          subject: code,
          text: `Created an invitation link for ${displayName}`,
        });
        return {
          code,
          kind: row.kind,
          displayName: row.displayName,
          path: `/invite/${code}`,
          orgName: org?.payload.name ?? '',
          used: false,
          unitsOffered: null,
        } satisfies Invite;
      }
      throw new ApiError(
        500,
        'invite_code_failed',
        'Could not create a unique invitation code. Try again.',
      );
    },
  };
}
