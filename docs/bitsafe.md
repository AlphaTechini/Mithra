# BitSafe: the treasury as a Decentralized Party

Evidence for the BitSafe challenge (contribution pool path, LocalNet; specs.md N7, N8, S5). What is claimed, how to reproduce it, what has been run, and what is still open.

Technical owner: <name, contact>

## What BitSafe's Decentralization Manager does in Mithra

Mithra's treasury is not one party on one node. It is a **Decentralized Party** created with BitSafe's [Decentralization Manager](https://github.com/DLC-link/decentralization-manager) (DecMan): its namespace is owned jointly by three nodes run by three different operators, and the party is hosted on all three. Nothing the treasury does depends on a single operator.

- **Hosting.** Every transaction that uses the treasury's authority (a cycle proposal, a payout, an approval) needs confirmations from 2 of its 3 hosting nodes. One node can be offline and the treasury keeps working.
- **Governance.** The treasury cannot submit commands itself. Its authority reaches the app only through DecMan's `GovernanceRules`: the `TreasuryCharter` and every `Mandate` are created by *governed actions* (`CharterProposal`, `MandateChangeProposal`) that execute only after 2 of 3 nodes confirmed them. Day-to-day payouts then run through choices on the Mandate that was created this way, so they need no votes, only the hosting confirmations.
- **Privacy note (from DecMan's docs).** Every hosting node sees what the treasury sees. That is intended: the three nodes are the treasury's own operators. Holder and auditor isolation is separate (`docs/ledger-model.md`).

Research and response shapes: `docs/research/bitsafe-dm.md`. Ledger model: `docs/ledger-model.md` ("Governed actions").

## Nodes, operators and thresholds (N7)

Defined in `localnet/nodes.env`; the names, operators and ports below are the defaults and are configurable there (nothing is hard-coded elsewhere).

| Node | Operator | LocalNet participant | Ledger API (gRPC) | JSON Ledger API | DecMan | Confirms Mithra's governed actions |
|---|---|---|---|---|---|---|
| A | Mithra Labs (app provider) | `app-provider` | 3901 | http://localhost:3975 | http://localhost:8081 | automatically, by the backend (`AUTO_CONFIRM=true`) |
| B | Ledgerline Fund Services (fund administrator) | `app-user` | 2901 | http://localhost:2975 | http://localhost:8082 | automatically, by the backend (`AUTO_CONFIRM=true`) |
| C | Canton super validator (synchronizer operator) | `sv` | 4901 | http://localhost:4975 | http://localhost:8083 | by hand in its own DecMan (`AUTO_CONFIRM=false`) |

| Threshold | Value | Where it applies |
|---|---|---|
| Hosting / transaction confirmation threshold | **2 of 3** (`HOSTING_THRESHOLD`) | every transaction that uses the treasury's authority; DecMan applies the onboarding threshold to the party-to-participant mapping |
| Namespace (topology) threshold | **2 of 3** | two of three owners must sign topology changes of the party (DecMan applies the same onboarding threshold to the decentralized namespace) |
| Governance confirmation threshold | **2 of 3** (`GOVERNANCE_THRESHOLD`, `GovernanceRules`) | executing a governed action: the charter and every Mandate seal |

The Infrastructure screen of the app (userflow 12) shows these nodes, their operators, the threshold and live status; a node counts as online when its JSON API answers and it is connected to a synchronizer. With one node down it says "Still running on 2 of 3 nodes"; below the threshold: "Below threshold: 1 of 3 nodes online. Payments and approvals wait until a second node is back."

All demo parties live on node A, so taking node B offline never affects a payee. Node C hosts the DSO party and the synchronizer, so it is only ever taken offline by the evidence script, in the one step where CC is not needed.

## How the party and `GovernanceRules` are created

`scripts/localnet-up.sh` (steps in `localnet/README.md`, what each prints in `docs/verification.md`):

1. Starts LocalNet (three participants) and one DecMan instance per node.
2. Gives each DecMan the full peer list (`POST /network-config`) and restarts them.
3. Onboards the party: `POST /onboarding` on DecMan A with `party_id_prefix: mithra-treasury`, peers B and C, `threshold: 2`; B and C accept the invitation. The party appears in `GET /decentralized-parties`.
4. Allocates Mithra's parties on node A and one member party per node (`mithra-member-a/b/c`), and sets each DecMan's party configuration.
5. Distributes the DARs (`governance-action-v1`, `governance-core-v1`, `mithra-v1`) to all nodes.
6. Deploys `GovernanceRules` (members = the three member parties, threshold 2) and adds Mithra's operator as an additional proposer through a governed action confirmed on A and B.
7. The operator files a `CharterProposal`; DecMan A and B confirm, it is executed, and the `TreasuryCharter` exists with the treasury's authority.

## What needs which threshold

| Action | Threshold | Why |
|---|---|---|
| Creating the `TreasuryCharter` | governance, 2 of 3 | governed action `CharterProposal` |
| Sealing a Mandate (every Mandate change) | governance, 2 of 3, plus the treasurer's signature | governed action `MandateChangeProposal` consumes the treasurer-signed seal request (L6 and N8) |
| A cycle proposal, a payout within the cap, an approval | hosting, 2 of 3 nodes confirm the transaction | the transaction uses the treasury's authority through the Mandate, but needs no governance vote |
| Reading data, holders accepting units, auditors reading shared records | none from the treasury's nodes | not the treasury's authority |

Sealing is therefore the one place a person-visible wait for node operators exists: the app confirms on the nodes with auto-confirm (A, B) and shows "awaiting nodes" with the confirmations it has until the threshold is met.

## Test results

What proves what, and what has run. **Nothing in the LocalNet row is claimed until a real report exists.**

### Daml Script tests (`daml/mithra-tests/daml/Mithra/Test/Governance.daml`)

| Test | What it proves |
|---|---|
| `test_n8_governed_mandate_change_below_threshold_fails` | A Mandate change filed as a governed action does not execute with 1 confirmation, nor with the same member confirming twice, nor when confirmers or the executor are not governance members (the agent and an outsider cannot confirm; the proposer, who is not a member, cannot execute); the Mandate stays at version 1 with the old cap. With two distinct confirmations it executes: a new Mandate with the new cap and version 2, the organization moved to version 2, a `GovernanceExecutionResult` naming the confirmers, and the proposal cannot be executed again. |
| `test_n8_charter_via_governance` | Nobody (operator, treasurer) can create the `TreasuryCharter` alone; with 1 of 3 confirmations nothing exists; with 2 the charter exists with the given roles; the agent cannot create the organization from it. |
| `test_charter_creates_one_organization_only` | The charter creates exactly one organization; invalid terms are refused without using the charter up. |

Run: `scripts/daml.sh test`. These tests were not re-run for this document (no Daml toolchain in the environment it was written in); their result is whatever `scripts/daml.sh test` prints on your machine.

### Backend: the DecMan sealer (`apps/backend/src/governance/decman.test.ts`)

`N8: does not execute below the confirmation threshold, executes once it is met, then reports sealed`: with node B offline the sealer confirms on node A only (1 of 2), `advance` sends no `/governance/execute`; once B is back, the retry confirms, the threshold is met, exactly one execute is sent to a confirming node and the seal reports sealed. Against a stub DecMan, not the real one. Run: `cd apps/backend && npx vitest run src/governance/decman.test.ts` (15 tests passed when this document was written).

Also unit-tested: the node status rule (`apps/backend/src/routes/treasury/infrastructure.test.ts`: a node that answers `/v2/version` but is disconnected from every synchronizer counts as offline) and the mapping of "not enough confirming nodes" ledger errors to the message "The treasury's nodes did not confirm in time. At least 2 of its 3 nodes must be online; check Settings › Infrastructure, then try again." (`apps/backend/src/ledger/errors.test.ts`). The Canton error ids in that mapping are not verified against Canton 3.5; the LocalNet run records the real error.

### LocalNet run (`scripts/bitsafe-demo.sh`)

Run `scripts/bitsafe-demo.sh` on LocalNet to produce it (how: `docs/verification.md`, "BitSafe evidence (owner's machine)"). No report has been produced yet; when it has, link the newest `docs/bitsafe-evidence/<timestamp>.md` here. It records, with the exact commands and trimmed responses:

| # | Claim | Step |
|---|---|---|
| B1, B2 | The treasury is a Decentralized Party hosted on A, B, C with threshold 2 (DecMan's party list, each node's ledger API, the Infrastructure panel); all three nodes online | 1 |
| O1, O2 | Node B offline: the panel says "Still running on 2 of 3 nodes" and a cycle inside the Mandate still pays; payout update ids recorded | 2 |
| T1 to T4 | Nodes B and C offline (below the hosting threshold of 2): the panel says "Below threshold: 1 of 3 nodes online"; a new cycle does not complete and the app shows the clear message; with the nodes back the same cycle proposes | 3 |
| G1, G2, R1 | Node B offline: a Mandate change stays `awaiting-nodes` with 1 of 2 confirmations and the Mandate does not change; with B back it seals (new version and cap); the original cap is restored | 4 |

## Remaining work

An honest list of what is not done or not verified:

- **Real LocalNet results.** Everything LocalNet-specific was written without a LocalNet (images cannot be pulled where the code was written): the bring-up, the node-offline mechanism (Canton console commands `synchronizers.disconnect_all()` / `reconnect_all()`, marked "verify on owner's machine" in `localnet/console/`), and `scripts/bitsafe-demo.sh` itself (checked with `shellcheck`, `--dry-run` and stub services only). The first real run may need fixes; `docs/verification.md` lists what to check.
- **DecMan response shapes are verified only on the owner's machine.** The sealer's parsing of `/governance/confirmations` and the party list's threshold and hosting fields were taken from DecMan's source and tests, not from a live instance.
- **The Canton error ids for "not enough confirming nodes" are unverified** (`NODE_CONFIRMATION_ERROR_IDS`). Both integration points are done (M12): `apps/backend/src/ledger/client.ts` passes the request path to `ledgerUnreachable`, so a timed-out command submission is mapped to the "treasury's nodes did not confirm" message, and `apps/backend/src/http/errors.ts` lets that message through on API routes as a 503 with code `treasury_nodes_unconfirmed` (other retryable ledger errors keep the generic text).
- **Auto-confirm is a LocalNet convenience.** The backend confirms governed actions on nodes A and B because it can reach both DecMan instances. In production each node operator confirms in their own DecMan UI (as node C already does here); the app would then show the pending confirmations and wait.
- **Node C is never offline in normal use** and node A cannot be, by design of this LocalNet (A hosts the agent and every demo party; C hosts the DSO and the synchronizer). The evidence covers B offline, and B plus C offline only for a step that does not need CC.
- **Disconnecting a participant is not the same as a crashed node.** `localnet-node.sh` disconnects a participant from the synchronizer; the participant process stays up. A crash or network partition behaves the same for confirmations, but has not been exercised.
- **MainNet and the Gold tier.** The product owner has confirmed there will be no MainNet node. On MainNet, Mithra's records stay on the LocalNet ledger and Grofty Wallet is used only to sign the CC payouts; BitSafe stays LocalNet-only. The Gold tier needs a Decentralized Party on the builder's own DevNet or MainNet node, which is out of scope (details.md note 4). There is no Decentralized Party on MainNet.
- **Only the treasury party is decentralized.** The treasurer, agent, operator, approvers, holders and auditor are ordinary parties on node A.
- **Namespace changes are not demonstrated** (adding or removing a node, changing the threshold with DecMan's own workflows). The evidence covers hosting and governed actions.

## BitSafe segment (for the demo script)

Link from the demo script's section 5. About 60 to 90 seconds, on the Infrastructure screen of a LocalNet that has the seeded history:

1. **Show the nodes.** Settings, Infrastructure: three nodes, each with its operator (Mithra Labs, Ledgerline Fund Services, a Canton super validator), "Hosting threshold 2 of 3", all online. Say: the treasury is a Decentralized Party created with BitSafe's Decentralization Manager; no single operator controls it.
2. **One node offline, the cycle still runs.** In a terminal: `scripts/localnet-node.sh b offline`. Refresh Infrastructure: node B shows offline, "Still running on 2 of 3 nodes" (the panel refreshes every 30 seconds at most). Run the next cycle ("Distribute 300 CC for August" as in section 2 of the demo script, if August has not run) and show it execute. Bring B back: `scripts/localnet-node.sh b online`.
3. **A governed change cannot execute below its threshold.** With B offline again, change the cap in the policy, **Seal mandate**: the seal waits for the nodes and shows 1 of 2 confirmations. Show the Mandate still has the old cap. `scripts/localnet-node.sh b online`: the second node confirms, the seal closes, the new cap applies.
4. **Point to the evidence.** "All of this is recorded, with the exact commands, in `docs/bitsafe-evidence/`, and reproducible with `scripts/bitsafe-demo.sh`."

Do not take node C offline in the video (it stops all CC transfers); the below-threshold behavior is shown in the recorded evidence, not live.
