# BitSafe Decentralization Manager (DecMan) (verified 2026-10-01)

Source: `github.com/DLC-link/decentralization-manager` at commit `a74bc48` (2026-10-01): `README.md`, `docs/ARCHITECTURE.md`, `docs/CUSTOM_DAML_TEMPLATES.md`, `integration-tests/{env,common}.sh`, `crates/common/src/api.rs`, `crates/decman/tests/common/phases/*.rs`, `daml/governance-*`. Latest tag `v1.13.0`. License Apache-2.0.

## What it does

One DecMan instance per participant node. Instances talk to each other over the Noise protocol (secp256k1 keys, auto-generated) and to their own node over gRPC (Admin API + Ledger API). Workflows: create a Decentralized Party (onboarding), distribute DARs, deploy contracts (multi-party signed interactive submission), governance confirm/execute, kick/add member, change threshold.

A Decentralized Party's namespace is owned jointly by the nodes. Its `PartyToParticipant` mapping lists each hosting node; **the onboarding `threshold` is applied to both the decentralized-namespace mapping and the party-to-participant mapping** (`OnboardingRequest.threshold` doc comment in `crates/common/src/api.rs`). Default `ceil(n/2)` = 2 for three nodes. So threshold 2 means two of three hosting nodes must confirm transactions for the party, and two of three owners must sign topology changes.

## Running it

- Image: `public.ecr.aws/dlc-link/decentralization-manager:<tag>` (and `<tag>-nonroot`). Tag `v1.13.0` exists (manifest resolved from this session; blob CDN `d2glxqk2uabbnd.cloudfront.net` is blocked here by network policy).
- Building from source needs an SSH key registered on any GitHub account (Cargo fetches `canton-lib` over SSH).
- Env vars per instance: `DECPM_PORT` (HTTP, default 8080), `DECPM_NOISE_PORT`, `DECPM_PUBLIC_ADDRESS`, `DECPM_CANTON_ADMIN_HOST/PORT`, `DECPM_CANTON_LEDGER_HOST/PORT` (gRPC ledger API, not JSON), `DECPM_CANTON_SYNCHRONIZER` (`global`), `DECPM_CANTON_NETWORK`, `DECPM_INSECURE=true` for LocalNet unsafe auth (mints HS256 token with secret `unsafe`, audience `https://canton.network.global`, sub `ledger-api-user` by default — matches LocalNet), data dir `-d <dir>` holding `data/noise.key`, `data/decpm.db`.
- LocalNet mapping used by DecMan's own e2e: instance 1 → app-provider (ledger 3901, admin 3902), instance 2 → app-user (2901/2902), instance 3 → sv (4901/4902). HTTP 8081/8082/8083, Noise 9001/9002/9003. `DECPM_TOPOLOGY_PROPAGATION_DELAY_SECS=3` on LocalNet.

## Bring-up sequence (from `integration-tests/common.sh` and phases)

1. Start three instances; wait for `GET /node-config` and `GET /keys/status` (`.public_key`).
2. Read each `participant_id` from `GET /node-config` (`.node.participant_id`).
3. `POST /network-config` on every instance with all three peers: `[{participant_id, name, address, port (noise), public_key, party: null}]`, then **restart** the instances (peer keys load at startup).
4. Create the party: `POST /onboarding` on instance 1 with `{ "party_id_prefix": "mithra-treasury", "peer_ids": [p2, p3], "threshold": 2 }`. Instances 2 and 3 get an invitation: `GET /invitations` → `POST /invitations/accept {"id": ...}`. Poll `GET /onboarding/status` until `completed`. Party appears in `GET /decentralized-parties`.
5. Allocate one **member party** per node via that node's JSON API `POST /v2/parties {"partyIdHint": "...", ...}` and grant `ledger-api-user` `CanActAs`/`CanReadAs`; `PUT /party-config` on each instance `{dec_party_id, member_party_id, user_id, packages: {governance_action: "#governance-action-v1", governance_core: "#governance-core-v1"}}` (keycloak fields omitted in insecure mode — verify).
6. Distribute DARs: `POST /dars/distribute {dar_files: [{filename, data: base64}], peer_ids: [p2, p3]}` → peers accept `Dars` invitations → poll `/dars/distribute/status`.
7. Deploy `GovernanceRules`: `POST /contracts` with `decentralized_party_id`, `participant_ids`, `participant_parties` (the three member parties), `operator_party`, and `contracts: [{ id, name: "GovernanceRules", package_id: "#governance-core-v1", module_name: "Governance.Rules", entity_name: "GovernanceRules", fields: [{type:"decentralized_party"}, {type:"party_set", parties:[m1,m2,m3]}, {type:"int64", value:2}, {type:"rel_time", microseconds:1800000000}, {type:"none"}] }]`. Peers accept `Contracts` invitations. Then `GET /governance/state?party_id=...` returns the rules contract id.

Steps 5 and 7's field names are copied from `phases/deploy_gov_core.rs`; insecure-mode details marked **verify on owner's machine**.

## How an app gets the Decentralized Party's authority

The party is an external, multi-key party: a plain `actAs` submission for it is not possible. Its authority reaches an app in two ways:

1. **Governed actions.** `GovernanceRules` (signatory `governanceParty`) has nonconsuming `GovernanceRules_ConfirmAction { confirmer, actionProposalCid : ContractId GovernableAction }` (controller confirmer, must be a member; proposer must be a member or in `additionalProposers`) and `GovernanceRules_ExecuteConfirmedAction { executor, actionProposalCid, confirmations }` (controller executor, a member; requires `length valid >= threshold`, distinct current members, unexpired). Execute exercises `GovernableAction_Execute` on the proposal, which runs `executeImpl` with the governance party's authority, and records a `GovernanceExecutionResult`.
2. **Delegation.** Anything created by a governed action and signed by the governance party can expose choices to other controllers (for example Mithra's agent). Those choices run with the governance party's authority. Transactions still need confirmations from the hosting threshold of the party's nodes.

Interface (from `governance-action-v1`, `Governance.Action`):
```daml
data GovernableActionView = GovernableActionView with
    governanceParty : Party; proposer : Party; actionLabel : Text; description : Text
interface GovernableAction where
  viewtype GovernableActionView
  executeImpl : Update ()
  choice GovernableAction_Execute : ()        -- controller governanceParty
  choice GovernableAction_Cancel : ()         -- controller governanceParty
  choice GovernableAction_ProposerCancel : () -- controller proposer
```
Template conventions (`CUSTOM_DAML_TEMPLATES.md`): proposal `signatory proposer`, `observer governanceParty`, stable PascalCase `actionLabel`. `executeImpl` may only need `{proposer, governanceParty}` authority; third-party sign-offs are collected beforehand as contracts that the governance party consumes ("Require business sign-offs at execute time").

REST for a custom (`core_domain`) action, once the proposal contract exists:
- `POST /governance/confirm {party_id, rules_contract_id, action: {type:"generic_vote", description:"x"}, governance_type: "core_domain", proposal_cid}` on each confirming node.
- `GET /governance/confirmations?party_id=...` → `domain_actions[]` with `proposal_cid`, `confirmations[]`, `can_execute`.
- `POST /governance/execute {party_id, rules_contract_id, action, confirmation_cids, disclosed_contracts: [], governance_type: "core_domain", proposal_cid}` on any member node.
- Non-member proposers (Mithra's operator party) must first be added with the `core_self` action `{type: "governance_add_additional_proposer", additional_proposer}` (confirm on 2 nodes, then execute).

## How Mithra uses it

- Treasury party = DecMan Decentralized Party `mithra-treasury::1220…`, hosted on all three LocalNet nodes, threshold 2.
- `TreasuryCharter` and every `Mandate` are created only by governed actions (`CharterProposal`, `MandateChangeProposal`, both implementing `GovernableAction`). The governed Mandate change consumes a treasurer-signed seal request, so it needs both the treasurer's signature (L6) and 2 of 3 node confirmations (N8).
- Day-to-day agent work (proposals, payments within the cap) runs through choices on the governance-created `Mandate`, so it needs no votes, only the 2-of-3 hosting confirmations. With one node offline, two nodes still confirm and the cycle runs; with two offline, transactions touching the treasury time out.
- The Mithra backend calls DecMan's REST API to file and execute governed actions. Nodes whose operators turned on auto-confirm for Mithra actions (`DM_NODES` env with `autoConfirm`) are confirmed by the backend; others confirm in their own DecMan UI. This is shown in the Infrastructure panel.

## Privacy caveat (from DecMan docs)

"Every member's node sees what the governance party sees." Treasury-signed contracts (all holders' units, decision records) are stored on all three treasury nodes. That is acceptable: the nodes are the treasury's own operators. Holder isolation (L7) is about holders and auditors, and holds because holder- and auditor-visible contracts are separate per holder or per grant.
