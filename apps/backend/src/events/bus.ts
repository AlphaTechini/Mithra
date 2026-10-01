import { EventEmitter } from 'node:events';
import type { LiveEvent, Role } from '@mithra/shared';

/** Who may receive an event: anyone with one of `roles`, or one of `parties`. */
export interface Audience {
  roles?: readonly Role[];
  parties?: readonly string[];
}

export interface Published {
  event: LiveEvent;
  audience: Audience;
}

/**
 * In-process publish/subscribe for live updates (the SSE route subscribes). Events carry ids and
 * statuses only; clients refetch what changed, so the audience check here is a second guard, not
 * the only one.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // One listener per open SSE connection.
    this.emitter.setMaxListeners(0);
  }

  publish(event: LiveEvent, audience: Audience): void {
    this.emitter.emit('event', { event, audience } satisfies Published);
  }

  /** Returns the unsubscribe function. */
  subscribe(listener: (published: Published) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}

/** True when a viewer with `partyId` and `roles` is in `audience`. */
export function inAudience(audience: Audience, partyId: string, roles: readonly Role[]): boolean {
  if (audience.parties?.includes(partyId)) return true;
  return audience.roles?.some((r) => roles.includes(r)) ?? false;
}

/** The treasury team: everyone who sees proposals, flags and payment history. */
export const TREASURY_TEAM: Audience = { roles: ['treasurer', 'approver'] };
