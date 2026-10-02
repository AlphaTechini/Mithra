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
| 11 | 2026-10-02 | **MainNet means MainNet payouts; Mithra's records always live on LocalNet.** Payouts on MainNet are plain CC transfers signed in the treasurer's Grofty Wallet (`prepareExecuteAndWait({ receiver, amount, memo })`); the Mandate's rules decide on the LocalNet ledger (`Mandate_AuthorizeExternalPayout`) before a transfer is offered for signing; each payment is recorded with `Payment_RecordExternal`. The spec deviates at N6: user actions other than payouts (organization, policy, approvals, units, audit) are signed on LocalNet, not by each user's Grofty party. | There is no MainNet node, so Mithra cannot host its Daml package or read the MainNet ledger. Grofty's plain transfer needs no package and no node. Holders connect Grofty only to register the MainNet party they are paid to (and turn on auto-receive, N5). Replaces the MainNet parts of decisions 3 and 5. |
