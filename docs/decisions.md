# Decisions

| # | Date | Decision | Why |
|---|---|---|---|
| 1 | 2026-10-01 | Daml SDK 3.4.11 with `--target=2.2` | Same as BitSafe's governance DARs that Mithra depends on; compatible with Canton 3.5.8 in Splice 0.6.12 |
| 2 | 2026-10-01 | LocalNet = Splice 0.6.12 bundle | Version BitSafe DecMan's own 3-node e2e runs against |
| 3 | 2026-10-01 | Payments happen inside the `Mandate` Daml choice via `TransferFactory_Transfer` | Makes the cap and pro-rata rules ledger-enforced, not backend checks (L1, L2, P1) |
| 4 | 2026-10-01 | Charter and Mandate are created only by BitSafe governed actions on LocalNet | Gives N8 a real "governed action below threshold fails" and keeps L6 (treasurer signature) |
| 5 | 2026-10-01 | Approvals are a consuming choice on `Proposal`; execution is a separate agent (LocalNet) or treasurer (MainNet) step | Approvers stay single-party and Grofty-friendly; the agent never needs approver authority |
| 6 | 2026-10-01 | Audit evidence is copied into per-grant `SharedRecord` contracts that are archived at close | Canton has no revocable observers; this gives "auditor sees nothing after expiry" in the active contract set |
| 7 | 2026-10-01 | Pro-rata rounds down to 10 places; residual to the largest holder (ties: first by party id) | Exact sum, same result in Daml and decimal.js |
| 8 | 2026-10-01 | Manual OpenAI tool loop with Zod-generated JSON Schema | One place for guardrails and fingerprinting; works with OpenAI-compatible providers |
| 9 | 2026-10-01 | Work is pushed to branch `ccr-a1ba735a-c2ycnx`, not `main` | The cloud session is bound to that branch; the owner merges |
| 10 | 2026-10-01 | SvelteKit with `adapter-static` and `ssr = false` | Frontend only, no server routes (T1) |
