import {
  PublicConfigSchema,
  SessionResponseSchema,
  type PublicConfig,
  type SessionResponse,
} from '@mithra/shared';
import { apiGet, apiPost } from '$lib/api/client';

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

const state = $state<{
  session: SessionResponse | null;
  config: PublicConfig | null;
  status: LoadStatus;
  error: unknown;
}>({ session: null, config: null, status: 'idle', error: null });

let inflight: Promise<void> | null = null;

async function fetchAll(): Promise<void> {
  state.status = state.session ? state.status : 'loading';
  try {
    const [session, config] = await Promise.all([
      apiGet('/session', SessionResponseSchema),
      apiGet('/config/public', PublicConfigSchema),
    ]);
    state.session = session;
    state.config = config;
    state.error = null;
    state.status = 'ready';
  } catch (e) {
    state.error = e;
    state.status = 'error';
  }
}

/**
 * A sign-in or switch answered with a session. When the config is already here, the store is
 * complete, so an earlier error or a loading skeleton must not stay on screen (SessionGate).
 */
function adopt(session: SessionResponse): void {
  state.session = session;
  if (state.config) {
    state.error = null;
    state.status = 'ready';
  }
}

/**
 * Session and public config, loaded once at startup. The ledger is the source of truth: this
 * store only mirrors what the backend says about the current party.
 */
export const sessionStore = {
  get session(): SessionResponse | null {
    return state.session;
  },
  get config(): PublicConfig | null {
    return state.config;
  },
  get status(): LoadStatus {
    return state.status;
  },
  get error(): unknown {
    return state.error;
  },
  /** LocalNet test mode, once known. Null until the backend has answered. */
  get testMode(): boolean | null {
    return state.session?.testMode ?? state.config?.testMode ?? null;
  },
  get network(): 'localnet' | 'mainnet' | null {
    return state.session?.network ?? state.config?.network ?? null;
  },
  get party() {
    return state.session?.party ?? null;
  },

  /** Loads session and config once. Later calls return the same load; use `refresh` to reload. */
  load(): Promise<void> {
    if (state.status === 'ready') return Promise.resolve();
    inflight ??= fetchAll().finally(() => {
      inflight = null;
    });
    return inflight;
  },

  /** Reloads session and config from the backend. */
  refresh(): Promise<void> {
    inflight ??= fetchAll().finally(() => {
      inflight = null;
    });
    return inflight;
  },

  /** LocalNet sign-in with the shared demo password. Throws ApiError on a wrong password. */
  async signIn(password: string): Promise<SessionResponse> {
    const session = await apiPost('/session/localnet/sign-in', SessionResponseSchema, { password });
    adopt(session);
    return session;
  },

  /** LocalNet role switcher: acts as another demo party. */
  async switchParty(partyId: string): Promise<SessionResponse> {
    const session = await apiPost('/session/switch', SessionResponseSchema, { partyId });
    adopt(session);
    return session;
  },

  async signOut(): Promise<void> {
    await apiPost('/session/sign-out', null);
    if (state.session) state.session = { ...state.session, signedIn: false, party: null };
  },

  /** Test helper: drop everything back to the initial state. */
  reset(): void {
    state.session = null;
    state.config = null;
    state.status = 'idle';
    state.error = null;
    inflight = null;
  },
};
