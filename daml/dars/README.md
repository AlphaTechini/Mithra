# Vendored DARs

| DAR | Source | License |
|---|---|---|
| governance-action-v1-0.1.0.dar, governance-core-v1-0.1.0.dar | github.com/DLC-link/decentralization-manager `releases/v1/` (commit a74bc48) | Apache-2.0 |
| splice-api-token-{metadata,holding,transfer-instruction}-v1-1.0.0.dar | Splice 0.6.12 release bundle `splice-node/dars/` | Apache-2.0 |

Checksums in `SHA256SUMS`. These are the CIP-56 token standard v1 interfaces and BitSafe's governance interfaces.

What reaches a LocalNet from here: `scripts/localnet-up.sh` (step 10) distributes the two governance DARs, `governance-action-v1` and `governance-core-v1`, together with the built Mithra DAR (`daml/mithra/.daml/dist/mithra-v1-0.1.0.dar`) to the three nodes through DecMan and waits until they are vetted on all of them. It does not upload the token standard DARs: Splice LocalNet ships those itself, and they are vendored here only so the Daml packages in `daml/` can compile against them.
