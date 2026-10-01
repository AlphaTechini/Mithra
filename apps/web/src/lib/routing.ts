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
 * Where a layout must send the visitor, or null when they may stay.
 * `allowed` lists the primary roles the layout is for; `'any'` only requires a signed-in party.
 */
export function redirectFor(
  session: SessionResponse | null,
  allowed: readonly Role[] | 'any',
): Pathname | null {
  if (!session?.signedIn) return '/launch';
  const role = session.party?.primaryRole ?? null;
  if (allowed === 'any') return null;
  if (role !== null && allowed.includes(role)) return null;
  return homeFor(role);
}
