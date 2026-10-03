/**
 * A reactive stand-in for SvelteKit's `page` from `$app/state`, so a test can navigate between two
 * records on one route the way the router does: the page component stays mounted and only the
 * params change. Use it in the mock: `vi.mock('$app/state', async () => ({ page: (await
 * import('.../test/route-page.svelte')).routePage }))`.
 */
import { SvelteURL } from 'svelte/reactivity';

export const routePage = $state<{ params: Record<string, string>; url: URL }>({
  params: {},
  url: new SvelteURL('http://localhost/'),
});

/** Move to another URL on the same route, as back and forward do. */
export function navigateTo(path: string, params: Record<string, string>): void {
  routePage.url = new SvelteURL(path, 'http://localhost');
  routePage.params = params;
}
