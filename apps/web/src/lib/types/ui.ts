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

export type ActionStatus = 'running' | 'done' | 'failed';

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
}

export type AgentMessage =
  | { id: string; role: 'user' | 'agent'; text: string }
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
  | 'seeded';

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
