import type { Pathname } from '$app/types';

/** Shared prop types for the design-system components. */

export type TimelineStatus = 'pending' | 'running' | 'done' | 'failed';

export interface TimelineStep {
  id: string;
  label: string;
  status: TimelineStatus;
  detail?: string;
  /** When the step finished or started, shown as a time. */
  at?: Date | string | number;
}

export type ActionStatus = 'running' | 'done' | 'failed' | 'needs-you';

export interface ActionDetail {
  label: string;
  value: string;
}

export interface ActionCardData {
  id: string;
  title: string;
  status: ActionStatus;
  summary?: string;
  details?: readonly ActionDetail[];
  /** In-app path to what the action touched. */
  href?: string;
}

export type AgentMessage =
  | { id: string; role: 'user'; text: string }
  /** `degraded`: the agent could not use its language model; the text says what still happened. */
  | { id: string; role: 'agent'; text: string; degraded?: boolean }
  | { id: string; role: 'tool'; action: ActionCardData };

export type ChipKind =
  | 'paid'
  | 'paid-auto'
  | 'awaiting-approval'
  | 'awaiting-acceptance'
  | 'pending'
  | 'rejected'
  | 'cancelled'
  | 'flagged'
  | 'passed'
  | 'active'
  | 'expired'
  | 'denied'
  | 'seeded'
  | 'paid-approved'
  | 'running'
  | 'countdown'
  | 'held'
  | 'failed'
  | 'needs-funds'
  | 'advisory'
  | 'auto-on'
  | 'auto-off'
  | 'online'
  | 'offline'
  | 'confirmed'
  | 'waiting'
  | 'approved';

export interface TableColumn {
  key: string;
  label: string;
  /** Right-aligned, tabular figures. */
  numeric?: boolean;
}

export interface NavItem {
  href: Pathname;
  label: string;
  /** Name of an icon in Icon.svelte. */
  icon: import('$lib/components/Icon.svelte').IconName;
}
