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

## Active contracts over the WebSocket stream (verified 2026-10-02 against the same sandbox)

`POST /v2/state/active-contracts` has a result limit, the participant's `http-list-max-elements-limit`. It is 200 unless the operator changed it (config key `canton.participants.<name>.http-ledger-api.websocket-config.http-list-max-elements-limit`, found in the `WebsocketConfig` class of `canton.jar` 3.4.0-rc2). A read of more contracts fails:

```
HTTP 413  {"code":"JSON_API_MAXIMUM_LIST_ELEMENTS_NUMBER_REACHED","cause":"The number of matching elements (201) is greater than the node limit (200).","errorCategory":2,"definiteAnswer":false,"retryInfo":"1 second",…}
```

Note `errorCategory: 2` (transient) on an error that repeats exactly: the client does not retry a 413.

The same read over the WebSocket variant of the endpoint has no such limit (712 active contracts streamed in one read on the sandbox; the HTTP read of the same filter answered 413 at 201):

- URL: the same path with `ws://` or `wss://`: `ws://localhost:7575/v2/state/active-contracts`.
- Subprotocols: `jwt.token.<token>` and `daml.ws.auth` when the participant needs a token. **`daml.ws.auth` has to be requested even without a token**: the sandbox always answers the handshake with `Sec-WebSocket-Protocol: daml.ws.auth`, and Node 22's global `WebSocket` throws `TypeError: Cannot read properties of null (reading 'includes')` from inside undici when the answer names a protocol that was not requested (it cannot be caught from the `WebSocket` object).
- Protocol: after the connection opens, the client sends the same JSON as the HTTP body (`{ activeAtOffset, eventFormat }`) as one text message. The server answers one text message per active contract, each the same `JsGetActiveContractsResponse` object that the HTTP array holds (`{ workflowId, contractEntry: { JsActiveContract: { createdEvent, synchronizerId } } }`), then closes the stream with code 1000. No separate "end" message.
- Errors arrive as a message `{ "code": "…", "cause": "…", … }` (for example `LEDGER_API_INTERNAL_ERROR` for a request that does not decode) followed by a normal close 1000, so a message with a `code` and no `contractEntry` must be treated as the error. A party the participant does not know gives an empty stream, not an error.
- Not verified: the token subprotocols against a participant that requires authentication (the sandbox has no auth). The format is the one of the Canton documentation and of the asyncapi file; the client sends exactly it and a unit test checks the subprotocols, but nothing has answered it with a real token.

How Mithra uses it: `LedgerClient.activeContracts` reads over HTTP and, only when that answers 413, repeats the same request over the WebSocket stream. It does not use the stream for every read: the HTTP read is the path the rest of the application and the tests exercise, and the stream was only verified on the sandbox. Integration test: `test/integration/ledger.test.ts`, "reads more active contracts than the list limit allows over the WebSocket stream" (creates 205 contracts, shows the HTTP 413, reads them all through the client).

