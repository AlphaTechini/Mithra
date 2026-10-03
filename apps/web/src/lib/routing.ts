import type { Role, SessionResponse } from '@mithra/shared';
import type { Pathname } from '$app/types';

/** The landing route for a party's primary role. An unknown party goes to `/start`. */
export function homeFor(primaryRole: Role | null | undefined): Pathname {
  switch (primaryRole) {
    case 'treasurer':
      return '/app/overview';
    case 'approver':
      // Falls back to the overview when nothing is pending, once the inbox can tell.
      return '/app/approvals';
    case 'holder':
      return '/holder';
    case 'auditor':
      return '/auditor';
    default:
      return '/start';
  }
}

/**
 * LocalNet convenience for the role switcher and the launch page: the demo party called "Auditor"
 * has no role until it makes a first request, so `homeFor(null)` would send it to `/start`. Take it
 * to the Audit workspace instead (userflow 11.1: "Auditor connects and lands on the Audit
 * workspace"). Every other party, and every party that has a role, goes where `homeFor` says.
 */
export function localnetHomeFor(
  party: { displayName: string; primaryRole: Role | null } | null | undefined,
): Pathname {
  if (party && party.primaryRole === null && party.displayName === 'Auditor') return '/auditor';
  return homeFor(party?.primaryRole ?? null);
}

/**
 * Where a layout must send the visitor, or null when they may stay.
 * `allowed` lists the primary roles the layout is for (`null` stands for a signed-in party that has
 * no role yet); `'any'` only requires a signed-in party.
 */
export function redirectFor(
  session: SessionResponse | null,
  allowed: readonly (Role | null)[] | 'any',
): Pathname | null {
  if (!session?.signedIn) return '/launch';
  const role = session.party?.primaryRole ?? null;
  if (allowed === 'any') return null;
  if (allowed.includes(role)) return null;
  return homeFor(role);
}
