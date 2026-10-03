# Daml SDK, dpm and Daml Script (verified 2026-10-01)

Sources read: `github.com/digital-asset/dpm` (source), `github.com/DLC-link/decentralization-manager` (`daml/*/daml.yaml`, CI workflow), `github.com/digital-asset/cn-quickstart` (`nix/dpm.nix`, `quickstart/daml/build.gradle.kts`), Splice 0.6.12 release bundle (`docs/html/app_dev/overview/version_information.html`), `github.com/hyperledger-labs/splice` (`token-standard/`).

## Versions

| Thing | Version | Source |
|---|---|---|
| Canton in Splice 0.6.12 LocalNet | 3.5.8 | Splice bundle docs, version_information |
| Daml SDK used to compile Splice 0.6.12 DARs | 3.5.2 | same |
| Daml SDK used by BitSafe DecMan packages | 3.4.11, `--target=2.2` | DecMan `daml/*/daml.yaml` |
| Token standard v1 API DARs | LF target 2.1 | splice `token-standard/*/daml.yaml` |
| Latest `dpm` tags | 1.0.22 | `git ls-remote digital-asset/dpm` |

**Decision:** Mithra uses `sdk-version: 3.4.11` and `--target=2.2`, the same as the BitSafe governance DARs it depends on. LF 2.2 packages can depend on LF 2.1 token standard DARs. Splice docs: ".dar files built by older 3.x Daml SDKs are generally compatible with the Canton version used in this Splice release."

## Installing dpm (owner's machine)

```bash
curl -sSL https://get.digitalasset.com/install/install.sh | sh   # installs ~/.dpm/bin/dpm
~/.dpm/bin/dpm install 3.4.11
```
(DecMan CI, `.github/workflows/ci.yml`). Components are fetched from `europe-docker.pkg.dev/da-images/public` (dpm `pkg/assistantconfig/consts.go`).

Commands used by real projects:
- `dpm build --all` (multi-package build, reads `multi-package.yaml`) — cn-quickstart, DecMan.
- `dpm test --package-root <dir>` — cn-quickstart `build.gradle.kts`.
- `dpm build` / `dpm test` inside a single package directory.

## Running in this cloud session (no dpm here)

`get.digitalasset.com` and `europe-docker.pkg.dev` are blocked by this environment's network policy. Docker Hub works, and `digitalasset/daml-sdk:3.4.0-rc2` contains the legacy `daml` assistant. Verified working here:

```bash
docker run --rm -e DAML_SDK_VERSION=3.4.0-rc2 -v $PWD:/w -w /w --user root \
  digitalasset/daml-sdk:3.4.0-rc2 sh -c 'daml build && daml test'
```
`DAML_SDK_VERSION` overrides `sdk-version` in `daml.yaml` (prints a warning). A smoke project with `--target=2.2` and data-dependencies on `governance-action-v1-0.1.0.dar` plus the three token-standard v1 DARs built, and `daml test` ran Daml Script and reported failures correctly. The repo script `scripts/daml.sh` wraps this: it uses `dpm` when installed and falls back to the Docker image.

## Project layout used by Mithra

```yaml
# daml/mithra/daml.yaml
sdk-version: 3.4.11
name: mithra-v1
version: 0.1.0
source: daml
dependencies: [daml-prim, daml-stdlib]
data-dependencies:
  - ../dars/governance-action-v1-0.1.0.dar
  - ../dars/splice-api-token-metadata-v1-1.0.0.dar
  - ../dars/splice-api-token-holding-v1-1.0.0.dar
  - ../dars/splice-api-token-transfer-instruction-v1-1.0.0.dar
build-options: [--target=2.2]
```
A separate test package (`daml/mithra-tests`) depends on `daml-script`, the built `mithra-v1` DAR, and `governance-core-v1-0.1.0.dar` (for the governed Mandate change test). Keeping Daml Script out of the main package avoids the `template-interface-depends-on-daml-script` warning and keeps the deployed DAR small.

Prebuilt DARs vendored in `daml/dars/` come from: DecMan `releases/v1/` (governance-action-v1, governance-core-v1) and the Splice 0.6.12 bundle `splice-node/dars/` (token standard v1 APIs). Both are Apache-2.0.

## Language facts relied on

- No contract keys in LF 2.x (Canton 3.x). Uniqueness is enforced by consuming and recreating a single "registry" contract.
- `Decimal` = `Numeric 10`. Multiplication of a Decimal by an integer-valued Decimal is exact within 38 digits. Division rounds to 10 places (rounding mode not relied on: Mithra computes floor by checking `q * d <= n` and stepping down by 1e-10).
- Interface choice exercise: `exercise (toInterfaceContractId @TransferFactory cid) TransferFactory_Transfer with ...`.
- Script: `submit`, `submitMustFail`, `allocateParty`, `query @T party`, `setTime`/`passTime` work in the IDE ledger used by `daml test`.

## CIP-56 token standard (Daml API, verified from splice `token-standard/` sources)

`Splice.Api.Token.HoldingV1`: `InstrumentId { admin : Party, id : Text }`, interface `Holding` with view `HoldingView { owner, instrumentId, amount : Decimal, lock : Optional Lock, meta : Metadata }`.

`Splice.Api.Token.MetadataV1`: `Metadata { values : TextMap Text }`, `emptyMetadata`, `ChoiceContext { values : TextMap AnyValue }`, `emptyChoiceContext`, `ExtraArgs { context : ChoiceContext, meta : Metadata }`.

`Splice.Api.Token.TransferInstructionV1`:
- `Transfer { sender, receiver, amount : Decimal, instrumentId, requestedAt : Time, executeBefore : Time, inputHoldingCids : [ContractId Holding], meta : Metadata }`
- interface `TransferFactory`, nonconsuming choice `TransferFactory_Transfer { expectedAdmin : Party, transfer : Transfer, extraArgs : ExtraArgs } : TransferInstructionResult`, **controller `transfer.sender`**.
- `TransferInstructionResult { output : TransferInstructionResult_Output, senderChangeCids : [ContractId Holding], meta }` with output `TransferInstructionResult_Pending { transferInstructionCid } | TransferInstructionResult_Completed { receiverHoldingCids } | TransferInstructionResult_Failed`.
- interface `TransferInstruction` with `TransferInstruction_Accept { extraArgs }` (controller receiver), `_Reject`, `_Withdraw` (controller sender), `_Update`.

Consequence for Mithra: any contract signed by the treasury party can hand its authority to a choice that calls `TransferFactory_Transfer` with `sender = treasury`. This is how the Mandate makes the cap a ledger rule: the payments happen inside the Mandate choice that checks the cap.
