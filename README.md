# Mithra

Mithra is a treasury app on Canton where an AI agent runs a fund's recurring yield distributions on schedule, inside spending limits the ledger enforces, and gives auditors scoped, time-limited, logged access to exactly the records they ask for.

## Repository layout

| Path              | What it is                                                        |
| ----------------- | ----------------------------------------------------------------- |
| `apps/backend`    | Fastify API (the whole backend, one process)                      |
| `apps/web`        | SvelteKit 2 / Svelte 5 frontend only, static SPA, talks to `/api` |
| `packages/shared` | Shared types, Zod schemas and decimal helpers (`@mithra/shared`)  |
| `daml`            | Daml contracts                                                    |
| `scripts`         | Daml build helper and (later) idempotent LocalNet seeding scripts |

## Development

Requires Node 22 and pnpm 10 (`corepack enable` picks the pinned version).

```sh
pnpm install            # install all workspaces
cp .env.example .env    # fill in the required variables, then export them (the backend reads the process environment)
pnpm dev                # backend on :8787 and web dev server on :5173 (proxies /api to the backend)
pnpm lint               # ESLint
pnpm format:check       # Prettier (use `pnpm format` to fix)
pnpm typecheck          # tsc and svelte-check
pnpm test               # Vitest
pnpm build              # backend bundle in apps/backend/dist, web app in apps/web/build
```

To run the production build in one process, the backend serves the built web app:

```sh
WEB_DIST_DIR=apps/web/build node apps/backend/dist/index.js
```

Daml commands: `pnpm daml:build` and `pnpm daml:test`.

## Configuration

All configuration comes from environment variables. `.env.example` lists every variable with a one-line description. The backend validates them at startup and names every missing or invalid variable. The network (`localnet` or `mainnet`) is chosen with `NETWORK`; no code changes are needed to switch.
