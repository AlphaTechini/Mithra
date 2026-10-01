# Grofty Wallet and CIP-0103 (verified 2026-10-01)

Source: npm `@groftylabs/dapp-sdk@0.2.0` and its repo `github.com/groftywallet/grofty-dapp-sdk` (commit of 2026-08-27): `README.md`, `src/types.ts`, `src/errors.ts`, `CHANGELOG.md`. CIP texts in `github.com/canton-foundation/cips` (cloned). grofty.cc docs are blocked by this session's network policy.

## API

```ts
import { createGroftyClient, isUserRejection, isUnauthorized, INTERNAL_ERROR } from '@groftylabs/dapp-sdk'
const grofty = await createGroftyClient()   // null when not installed or during SSR
await grofty.connect()                       // prompts
const account = await grofty.getPrimaryAccount()  // { partyId, hint, namespace, networkId, publicKey, primary, status }
const { tx } = await grofty.prepareExecuteAndWait({ commands, disclosedContracts, commandId })
// tx: { status: 'executed', commandId, payload: { updateId, completionOffset } }
```
Other methods: `disconnect`, `isConnected`, `status()` (no prompt; for session restore), `getActiveNetwork()` → `{ networkId: 'canton:da-mainnet' }`, `listAccounts`, `signMessage(msg)` → string, `prepareExecute` (resolves `undefined`), `getBalance()`, `getUpdateById(updateId)`, `getActiveContracts({...})`, `on(event, handler)` for `statusChanged | accountsChanged | txChanged | connected`. Options `discoveryTimeoutMs` (1000) and `timeoutMs` (240000).

`prepareExecute(AndWait)` accepts either a simple transfer `{ receiver, amount: "1.5", tokenSymbol?, memo? }` or generic commands `{ commands, disclosedContracts?, commandId?, readAs?, synchronizerId?, packageIdSelectionPreference? }`. Disclosed contracts must carry all four of `templateId, contractId, createdEventBlob, synchronizerId`.

## Constraints Mithra must handle

| Constraint | Detail | Mithra handling |
|---|---|---|
| MainNet only | reports `canton:da-mainnet`, no network switching | Grofty path only when `NETWORK=mainnet` |
| Single party | `actAs` refused; `readAs` only own party | every user action is a single-party choice; contracts the user's node lacks are passed as `disclosedContracts` fetched by the backend |
| Approval timeout | a timed-out approval is `-32603` (not `4001`) | message "Your wallet approval expired after 3 minutes. Approve again." |
| User rejected | `4001` | "You declined in Grofty. Nothing was submitted." |
| Not connected / signed out | `4100` | prompt to unlock / reconnect |
| Version | needs Grofty Wallet 2.0.4+ (first to resolve `prepareExecuteAndWait` with `{tx}`) | `prepareExecuteAndWait` returning `undefined` → "Update Grofty Wallet to 2.0.4 or newer" |
| Missing extension | `createGroftyClient()` returns null | install instructions + link back |
| Ledger reads | `ledgerApi` serves only 4 read paths, scoped to own party | Mithra reads from its Fastify API instead |

## Auto-receive (preapproval) on MainNet

Grofty handles receiving preferences in the wallet. The SDK exposes no preapproval method. Mithra's holder onboarding guides the user to turn on auto-receive in Grofty, then the backend verifies with the registry: the transfer-factory lookup reports `transferKind: "direct"` for receivers with a preapproval (see `wallet-sdk.md`). Exact Grofty menu wording is **unverified** (docs blocked); the copy says "Turn on auto-receive in Grofty Wallet settings".

## Open question for the owner

Generic Daml commands submitted through Grofty run on Grofty's participant node, so **the Mithra DAR must be vetted on Grofty's participant** for treasurer/approver/holder/auditor actions to touch Mithra contracts on MainNet (N6). This cannot be verified from here. If Grofty cannot vet it, the fallback is: user actions are recorded through Grofty `signMessage` attestations stored on Mithra contracts hosted by the operator, and payouts use Grofty's simple transfer shape. Asked the owner on 2026-10-01.
