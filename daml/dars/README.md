# Vendored DARs

| DAR | Source | License |
|---|---|---|
| governance-action-v1-0.1.0.dar, governance-core-v1-0.1.0.dar | github.com/DLC-link/decentralization-manager `releases/v1/` (commit a74bc48) | Apache-2.0 |
| splice-api-token-{metadata,holding,transfer-instruction}-v1-1.0.0.dar | Splice 0.6.12 release bundle `splice-node/dars/` | Apache-2.0 |

Checksums in `SHA256SUMS`. These are the CIP-56 token standard v1 interfaces and BitSafe's governance interfaces. They are uploaded to LocalNet by `scripts/localnet-bootstrap.sh` only if not already present (Splice ships the token standard DARs itself).
