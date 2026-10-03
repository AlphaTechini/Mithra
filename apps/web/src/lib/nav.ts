import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import type { Pathname } from '$app/types';

/** Client-side navigation to an app route. Resolves the path against the configured base. */
export function navigate(path: Pathname, options: { replaceState?: boolean } = {}): Promise<void> {
  return goto(resolve(path), options);
}
