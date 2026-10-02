import { ApprovalsInboxSchema, type ApprovalsInbox } from '@mithra/shared';
import { apiGet } from '$lib/api/client';

/** GET /api/approvals: proposals waiting for the signed-in approver (userflow 10 step 1). */
export function fetchApprovals(): Promise<ApprovalsInbox> {
  return apiGet('/approvals', ApprovalsInboxSchema);
}
