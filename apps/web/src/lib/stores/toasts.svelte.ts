/** Confirmation toasts, worded from the vocabulary in userflow.md ("Mandate sealed", ...). */

export type ToastKind = 'success' | 'info' | 'error';

export interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

const DEFAULT_TIMEOUT_MS = 5000;
const items = $state<ToastItem[]>([]);
let nextId = 1;

export const toasts = {
  get items(): readonly ToastItem[] {
    return items;
  },

  /** Shows a toast. `timeoutMs` of 0 keeps it until dismissed (errors should do this). */
  push(message: string, kind: ToastKind = 'success', timeoutMs = DEFAULT_TIMEOUT_MS): number {
    const id = nextId++;
    items.push({ id, message, kind });
    if (timeoutMs > 0 && typeof window !== 'undefined') {
      window.setTimeout(() => toasts.dismiss(id), timeoutMs);
    }
    return id;
  },

  dismiss(id: number): void {
    const index = items.findIndex((t) => t.id === id);
    if (index >= 0) items.splice(index, 1);
  },

  clear(): void {
    items.splice(0, items.length);
  },
};
