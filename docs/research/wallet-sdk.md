# @canton-network/wallet-sdk (verified 2026-10-01)

Source: npm `@canton-network/wallet-sdk@1.5.3` (published 2026-09-17), repo `github.com/canton-network/wallet` (commit of 2026-10-01): `sdk/wallet-sdk/src/config.ts`, `docs/wallet-integration-guide/examples/scripts/{01-init,03-parties,05-preapproval}.ts`.

## Creating the SDK

```ts
import { SDK, localNetStaticConfig } from '@canton-network/wallet-sdk'
const auth = { method: 'self_signed', issuer: 'unsafe-auth',
  credentials: { clientId: 'ledger-api-user', clientSecret: 'unsafe', audience: 'https://canton.network.global', scope: '' } }
const sdk = await SDK.create({
  auth,
  ledgerClientUrl: 'http://localhost:3975',          // JSON Ledger API of the node
  token:  { validatorUrl, registries: [registryUrl], auth },
  amulet: { validatorUrl, scanApiUrl, auth, registryUrl },
})
```
LocalNet constants (`localNetStaticConfig`): `LOCALNET_APP_VALIDATOR_URL = http://localhost:2000/api/validator`, `LOCALNET_SCAN_API_URL = http://scan.localhost:4000/api/scan`, `LOCALNET_REGISTRY_API_URL = ${validator}/v0/scan-proxy`, ledger URLs 2975/3975/4975, `LOCALNET_USER_ID = 'ledger-api-user'`.

## Operations used by the examples

| Operation | Call |
|---|---|
| Tap CC (DevNet/LocalNet only) | `const [cmds, disclosed] = await sdk.amulet.tap(partyId, '10000')` then submit as that party |
| Transfer via token standard | `const [cmds, disclosed] = await sdk.token.transfer.create({ sender, recipient, amount: '2000', instrumentId: 'Amulet', registryUrl })` |
| Submit (external party) | `await sdk.ledger.prepare({ partyId, commands, disclosedContracts }).sign(privateKey).execute({ partyId })` |
| Holdings | `await sdk.token.utxos.list({ partyId })` → `PrettyContract<HoldingView>[]` with `interfaceViewValue.amount` (string), `.instrumentId.id` |
| Tx by id | `await sdk.token.transactionsById({ updateId, partyId })` |
| Create preapproval | `await sdk.amulet.preapproval.command.create({ parties: { receiver } })` → commands, submit as receiver |
| Preapproval status | `await sdk.amulet.preapproval.fetchStatus(receiver)` → `{ contractId, templateId, expiresAt } \| null`; `fetchQuick(receiver)` |
| Renew / cancel | `sdk.amulet.preapproval.renew({ parties: { receiver }, expiresAt })`, `sdk.amulet.preapproval.command.cancel({ parties: { receiver } })` |
| Parties | `sdk.party.external.create(publicKey, { partyHint, confirmingParticipantEndpoints? })...execute()`, `sdk.party.list()` |

The SDK's submission path is built for **external parties** (prepare → sign → execute). Mithra's LocalNet parties are local parties signed server-side by the ledger user, so Mithra uses the SDK where it adds value (registry/choice-context lookups, preapproval commands, tap, holdings) and submits commands through its own ledger module (`apps/backend/src/ledger`) with `submit-and-wait-for-transaction`.

## Transfers inside a Daml choice

Mithra pays holders from inside `Mandate` choices (so the cap is a ledger rule). The choice needs, per payee, the `TransferFactory` contract id and the `ExtraArgs` choice context, and the submission needs the registry's disclosed contracts. These come from the registry's off-ledger API (`POST {registry}/registry/transfer-instruction/v1/transfer-factory` with `{ choiceArguments: <TransferFactory_Transfer args with empty extraArgs.context/meta>, excludeDebugFields: true }` → `{ factoryId, transferKind: "self"|"direct"|"offer", choiceContext: { choiceContextData, disclosedContracts[] } }`; spec in splice `token-standard/splice-api-token-transfer-instruction-v1/openapi/transfer-instruction-v1.yaml`). `transferKind: "direct"` means the receiver has a preapproval (auto-receive) and the transfer completes in one step; `"offer"` creates a pending `TransferInstruction` the receiver accepts. This is P2.

The `choiceContextData` maps to Daml `ChoiceContext { values : TextMap AnyValue }`; the JSON is already in Daml-LF JSON form, so it is passed through as `extraArgs.context`.
