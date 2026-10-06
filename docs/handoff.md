# Handoff: continuing on your own machine

State on 2026-10-06. The build is merged on `main` and CI is green there. This page is the short list of what is left and how to pick it up.

## The plan (decision 14)

- **Submission:** HackCanton Season 3, Track 3 (Investment Infrastructure), plus the BitSafe challenge. Both run on LocalNet. Submissions close **October 9, 2026**; aim to submit the night of October 8. The Grand Final is October 21.
- **Grofty bounty: withdrawn.** Grofty is MainNet only and there are no funds for MainNet CC. The MainNet payout code stays in the repo, off by default (`NETWORK=localnet`), built and tested but not demonstrated.
- The demo still shows the agent paying holders: on LocalNet those payouts are real ledger transfers inside the Mandate.

## Get it running

```sh
git clone https://github.com/AlphaTechini/Mithra && cd Mithra
```

Then follow "Quick start on LocalNet" in the [README](../README.md): `scripts/localnet-up.sh`, `scripts/localnet-env.sh`, fill in `.env`, `pnpm install && pnpm build`, `pnpm seed:localnet`, start the backend. You need Docker with about 8 GB of memory, Node 22, pnpm 10 and PostgreSQL 16 (a Docker container is fine).

**The agent's LLM.** Any OpenAI-compatible endpoint works (`LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`). A free option is a local model served with an OpenAI-compatible API (for example Ollama at `http://localhost:11434/v1`); pick a model that supports tool calls, since the agent uses them. This has not been tried yet: run one cycle and one audit request through the agent panel to check it.

To check that everything still works before recording:

```sh
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build
scripts/daml.sh test
```

## Before October 9, in order

1. **LocalNet bring-up** from the clone (spec N2). Note anything that fails in [verification.md](verification.md).
2. **BitSafe evidence** (N8): `scripts/bitsafe-demo.sh`. It takes a node offline while a cycle runs and shows a governed Mandate change blocked below the threshold, then passing. Commit the report it writes. This is the strongest item left for the BitSafe challenge.
3. **Agent with a real model:** one clean cycle, one flagged cycle, one audit request.
4. **Demo video**, under 5 minutes, following [demo-script.md](demo-script.md): setup, the clean August cycle, the flagged September cycle with two approvals, a holder's own view, the audit grant and its expiry, and the BitSafe segment (node offline, still running on 2 of 3).
5. **Submit** on AppsFactory: repo link, video, and the README.

## Open decisions (yours)

- **Run cycle dialog:** keep or drop the custom record date field.
- **License:** the repo is "all rights reserved". Leave it for the hackathon. A grant (below) needs an open-source license on the parts it funds.

## After the hackathon: the Canton Development Fund

The Fund (canton.foundation/grants-program, proposals as pull requests to `github.com/canton-foundation/canton-dev-fund`) pays in CC per accepted milestone and funds common-good work: shared tooling, reference implementations, infrastructure. It does not fund private or proprietary products, so Mithra as a whole does not fit. Parts that could be proposed as open-source libraries:

- **Mandate pattern:** ledger-enforced spending limits for AI agents (cap, pro-rata, hold, flags, one payout per cycle), as a reusable Daml package.
- **Scoped, time-limited audit grants:** per-grant `SharedRecord` copies archived at expiry, so an auditor sees exactly what was granted and nothing after.
- **TypeScript client for the JSON Ledger API v2**, including the WebSocket active-contracts read for large results (`apps/backend/src/ledger/`).

## Where things are

- What each spec item maps to, and its status: [traceability.md](traceability.md)
- Why things are the way they are: [decisions.md](decisions.md) (11 to 14 cover MainNet)
- What was and was not verified, with checklists: [verification.md](verification.md)
- The CodeRabbit fix lists: `docs/briefs/CR1.md` to `CR5.md`
