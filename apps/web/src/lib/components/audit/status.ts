import type { AuditRequestView } from '@mithra/shared';

/**
 * When access ended, for "Access ended {date}": the moment the treasurer revoked it, otherwise
 * the expiry. Both come from the server; nothing is computed here.
 */
export function endedAt(request: AuditRequestView): string | null {
  const grant = request.grant;
  if (!grant) return null;
  return grant.closedReason === 'revoked' && grant.closedAt ? grant.closedAt : grant.expiresAt;
}

/** The expiry choices the treasurer picks from, in the words the vocabulary uses. */
export const EXPIRY_CHOICES = [
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
] as const;
