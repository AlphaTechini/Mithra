/**
 * A small reactive loader for one API resource. `load` shows the skeleton only while there is no
 * data yet; later calls (live updates, polling) replace the data silently. Out-of-order answers
 * are dropped, so a slow older request can never overwrite a newer one.
 */
export interface Resource<T> {
  readonly data: T | null;
  /** The last failure, or null. Pages show it as an error state only when `data` is null. */
  readonly error: unknown;
  /** True until the first answer (data or error) arrives. */
  readonly loading: boolean;
  load(): Promise<void>;
  /** Replace the data, for example with a response that already carries the new state. */
  set(data: T): void;
}

export function createResource<T>(fetcher: () => Promise<T>): Resource<T> {
  const state = $state<{ data: T | null; error: unknown; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  let latest = 0;

  async function load(): Promise<void> {
    const mine = ++latest;
    try {
      const data = await fetcher();
      if (mine !== latest) return;
      state.data = data;
      state.error = null;
    } catch (e) {
      if (mine !== latest) return;
      state.error = e;
    } finally {
      if (mine === latest) state.loading = false;
    }
  }

  return {
    get data() {
      return state.data;
    },
    get error() {
      return state.error;
    },
    get loading() {
      return state.loading;
    },
    load,
    set(data: T) {
      latest++;
      state.data = data;
      state.error = null;
      state.loading = false;
    },
  };
}
