/** Timers shared by the live pages. */

export interface Debounced {
  (): void;
  cancel(): void;
}

/** Calls `fn` once, `ms` after the last call. */
export function debounce(fn: () => void, ms: number): Debounced {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wrapped = (() => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn();
    }, ms);
  }) as Debounced;
  wrapped.cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return wrapped;
}

/**
 * Runs `fn` every `ms` while the page is visible, and once when the window regains focus. Returns
 * a stop function, for use as an `$effect` cleanup. Used as a fallback beside Server-Sent Events.
 */
export function poll(fn: () => void, ms: number): () => void {
  const timer = setInterval(() => {
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') fn();
  }, ms);
  const onFocus = (): void => fn();
  if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);
  return () => {
    clearInterval(timer);
    if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
  };
}
