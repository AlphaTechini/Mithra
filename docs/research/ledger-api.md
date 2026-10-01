# JSON Ledger API v2 (verified 2026-10-01)

Source: OpenAPI spec for Canton 3.5.8, `github.com/canton-network/wallet` → `api-specs/ledger-api/3.5.8/openapi.yaml` (and `asyncapi.yaml` for WebSocket streams). Canton 3.5.8 is what Splice 0.6.12 LocalNet runs.

## Endpoints Mithra uses

| Purpose | Method + path | Notes |
|---|---|---|
| Submit and get the transaction back | `POST /v2/commands/submit-and-wait-for-transaction` | body `JsSubmitAndWaitForTransactionRequest { commands: JsCommands, transactionFormat? }`; response `{ transaction: JsTransaction }` |
| Submit, get only update id | `POST /v2/commands/submit-and-wait` | response `{ updateId, completionOffset }` |
| Active contracts | `POST /v2/state/active-contracts` | body `GetActiveContractsRequest { activeAtOffset (required), eventFormat }`; response is a JSON **array** of `JsGetActiveContractsResponse` |
| Ledger end | `GET /v2/state/ledger-end` | `{ offset }` |
| Updates since offset (poll) | `POST /v2/updates` | `GetUpdatesRequest { beginExclusive, endInclusive?, updateFormat }`; query params `limit`, `stream_idle_timeout_ms`. WebSocket variant described in asyncapi |
| Update by id | `POST /v2/updates/update-by-id` | `{ updateId, updateFormat }` |
| Upload DAR | `POST /v2/dars` | `Content-Type: application/octet-stream`, raw DAR bytes |
| Allocate party | `POST /v2/parties` | `AllocatePartyRequest { partyIdHint, localMetadata?, identityProviderId?, synchronizerId?, userId? }` → `{ partyDetails }` |
| List parties | `GET /v2/parties` | |
| Participant id | `GET /v2/parties/participant-id` | |
| User rights | `POST /v2/users/{user-id}/rights` | grant `CanActAs` / `CanReadAs` |
| Connected synchronizers | `GET /v2/state/connected-synchronizers` | used for node health |
| Interactive submission | `POST /v2/interactive-submission/prepare`, `/execute`, `/executeAndWait` | used by external parties (wallet SDK, DecMan); Mithra's backend does not need it on LocalNet |

## Shapes

```jsonc
// JsCommands (required: commandId, commands, actAs)
{
  "commandId": "uuid",
  "actAs": ["party::1220..."],
  "readAs": ["treasury::1220..."],
  "userId": "ledger-api-user",
  "commands": [
    { "CreateCommand": { "templateId": "#mithra-v1:Mithra.Org:Organization", "createArguments": { } } },
    { "ExerciseCommand": { "templateId": "#mithra-v1:Mithra.Mandate:Mandate", "contractId": "00ab..", "choice": "Mandate_Propose", "choiceArgument": { } } }
  ],
  "disclosedContracts": [ { "templateId": "...", "contractId": "...", "createdEventBlob": "...", "synchronizerId": "..." } ],
  "synchronizerId": "optional"
}
```
- `templateId` accepts the package-name reference form `#<package-name>:<Module>:<Entity>` (spec: "Both package-name and package-id reference formats are supported"; package-id form is deprecated). Interfaces too: `#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory`.
- Event format: `{ "filtersByParty": { "<party>": { "cumulative": [ { "identifierFilter": { "TemplateFilter": { "value": { "templateId": "#mithra-v1:Mithra.Org:Organization", "includeCreatedEventBlob": false } } } } ] } }, "verbose": false }`. Other variants: `{"WildcardFilter": {"value": {"includeCreatedEventBlob": true}}}`, `{"InterfaceFilter": {"value": {"interfaceId": "...", "includeInterfaceView": true, "includeCreatedEventBlob": true}}}`.
- ACS entry: `{ "contractEntry": { "JsActiveContract": { "createdEvent": CreatedEvent, "synchronizerId", "reassignmentCounter" } } }`.
- `CreatedEvent` required: `offset, nodeId, contractId, templateId, createdAt, packageName, representativePackageId, acsDelta, createArgument, witnessParties, signatories`; optional `observers, createdEventBlob, interfaceViews`.
- `JsTransaction`: `updateId, commandId?, effectiveAt, offset, synchronizerId, recordTime, events[]` where each event is `{ "CreatedEvent": {...} } | { "ArchivedEvent": {...} } | { "ExercisedEvent": {...} }`.
- Errors: `JsCantonError { code, cause, context, errorCategory, correlationId?, traceId?, grpcCodeValue?, definiteAnswer? }`. Daml `assertMsg` failures surface as `code` like `DAML_INTERPRETATION_ERROR` / `UNHANDLED_EXCEPTION` with the message inside `cause`.

## Daml-LF JSON encoding (JSON API v2)

- `Decimal`/`Numeric` → JSON **string** (`"1200.0000000000"`). Mithra keeps amounts as strings end to end (no JS number).
- `Int` → string. `Party`, `Text`, `ContractId` → string. `Time` → ISO-8601 string (`"2026-09-30T00:00:00Z"`). `Date` → `"2026-09-30"`. `RelTime` → `{ "microseconds": "..." }`.
- `Optional` → `null` or the value (nested optionals use `[]`/`[x]`). `List` → array. `TextMap`/`Map` → for `TextMap` an object; for `DA.Map.Map k v` an array of `[k, v]` pairs. `Set` → `{ "map": [[x, {}], ...] }`.
- Variants → `{ "tag": "Ctor", "value": {...} }`. Enums → `"Ctor"`. Records → objects.
(Encoding rules are the standard Daml-LF JSON encoding used by JSON API v2; verify against a live LocalNet before relying on Map/Set shapes — Mithra's model avoids `Map`/`Set` in choice arguments for this reason and uses lists of records.)

## Auth on LocalNet

Splice LocalNet participants use `auth-services = [{ type = unsafe-jwt-hmac-256, target-audience = "https://canton.network.global", secret = "unsafe" }]` (bundle `conf/canton/*/app-auth.conf`). Token: HS256 JWT signed with `unsafe`, claims `{ "aud": "https://canton.network.global", "sub": "ledger-api-user" }`. `ledger-api-user` is configured as `additional-admin-user-id` on every participant. Max token lifetime is unlimited on LocalNet.

## Auth on MainNet

OIDC client-credentials or password grant against the operator's identity provider (`LEDGER_AUTH_*` env vars). Token's `sub` is the ledger user; the user needs `CanActAs` for the operator and agent parties.

## Verified live (2026-10-01) against a Canton 3.4.0-rc2 sandbox

`docker run --network host ... digitalasset/daml-sdk:3.4.0-rc2 daml sandbox --json-api-port 7575 --wall-clock-time --dar ...` (see `scripts/sandbox.sh`). The sandbox has no auth; `userId: "participant_admin"`. It needs ~20 s after "ready" before party allocation works (`PARTY_ALLOCATION_WITHOUT_CONNECTED_SYNCHRONIZER` until then).

- `POST /v2/parties {"partyIdHint":"alice","identityProviderId":""}` → `{"partyDetails":{"party":"alice::1220…","isLocal":true,…}}`.
- `POST /v2/commands/submit-and-wait-for-transaction` with `{"commands":{"commandId","userId","actAs":[p],"commands":[{"CreateCommand":{"templateId":"#mithra-v1:Mithra.Charter:TreasuryCharter","createArguments":{…}}}]}}` → `{"transaction":{"updateId","commandId","effectiveAt","events":[{"CreatedEvent":{…,"templateId":"<package-id>:Mithra.Charter:TreasuryCharter",…}}],…}}`. Package-name template ids work in requests; responses carry package-id form.
- `POST /v2/state/active-contracts` with `{"activeAtOffset": <ledger end>, "eventFormat": {"filtersByParty": {p: {"cumulative": [{"identifierFilter": {"TemplateFilter": {"value": {"templateId": "#mithra-v1:…", "includeCreatedEventBlob": false}}}}]}}, "verbose": false}}` → JSON array of `{"workflowId","contractEntry":{"JsActiveContract":{"createdEvent":{…}}}}`.
- Encoding confirmed: `Decimal` and `Int` sent as strings (`"5000"`, `"3"`) are accepted; `Optional` `None` as `null`; records as objects; `Time` as ISO string.
- A failed `ensure` returns HTTP 400-class JSON `{"code":"DAML_FAILURE","cause":"Interpretation error: Error: User failure: UNHANDLED_EXCEPTION/DA.Exception.PreconditionFailed…","context":{"error_id":…},"errorCategory":9,…}`. `assertMsg` failures carry the message text inside `cause`.
