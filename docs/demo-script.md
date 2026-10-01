# Demo script

The main pitch demo (about 5 minutes), following `details.md` section 10. It runs on LocalNet, in "LocalNet test mode", with the role switcher in the header ("Acting as"). The video can start from a fresh setup (steps 1 to 4) or from a seeded one (`pnpm seed:localnet`, see `docs/verification.md`): the seed has the organization, the Mandate, four holders and the seeded history of June (400 CC) and July (420 CC), with auto-receive on for Holders A to C. Holder D has none, so only D shows the pending-acceptance path. August and September are left for the day.

Dates below assume the demo runs in October 2026; use the previous two months otherwise. The record date of a cycle is the last day of the previous month.

## 1. Setup (skip when seeded)

1. Landing page, **Launch app**, enter the LocalNet password. Acting as Treasurer you land on `/start`: **Set up a treasury**. *Viewer sees:* three ways in (set up, invited, auditor).
2. Organization: name "Northwind Income Fund", tick Approver 1, 2 and 3 (nothing is preselected), threshold 2 of 3, **Continue**. *Sees:* the seal ring previewing 0 of 2.
3. Policy: paste "Pay monthly yield on the 1st. Auto-pay if the total is under 5,000 CC and nothing looks off. Otherwise 2 of 3 approvals.", **Ask the agent**, **Review mandate**, **Seal mandate**. *Sees:* the policy card, "The agent can / cannot", the seal closing, "Mandate sealed".
4. Holders, **Issue units** (Holder A 100, B 300, C 600, D 1,000; the demo parties are in the list). Switch to Holder D, **Accept units**, **Turn on auto-receive**. *Sees:* "Auto-receive is on".

## 2. August: the clean cycle (about 1 minute)

1. Acting as Treasurer, open the agent (Ctrl+K) and type: `Distribute 300 CC for August.`
2. *Sees:* the action card "Created proposal for August 2026, 4 payees, 300 CC", then **Open**: the timeline fills (woke up, snapshot, amounts, checks, review, verdict), all checks pass, verdict "Within mandate", a short countdown with **Hold**, then payments turn Paid. Holder D's row says "Awaiting acceptance".
3. Switch to Holder D, **Accept payment**. Switch to Holder A: "Your position" shows only A's own payments, nothing of the others.

## 3. September: the flagged cycle (about 2 minutes)

1. Acting as Treasurer, Holders, **Issue units**: Holder C, 900 units, effective date 30 August (the day before the record date, 31 August). *Sees:* Holder C now holds 1,500 of 2,900 units.
2. Agent: `Distribute 1,200 CC for September.`
3. *Sees:* the card "Created proposal for September 2026, 4 payees, 1,200 CC", status "Needs you", needing 2 of 3 approvals. 1,200 CC is under the 5,000 CC cap, so the reasons are the two flags on the cycle page: the total against the average of the last cycles (the check shows the exact percentage; the average is near 400 CC) and Holder C's units jump in the 3 days before the record date. The memo explains both ("Written by the AI reviewer", or "Written from the checks" without the model). Open **View decision record**.
4. Switch to Approver 1: Approvals, open September, read the memo, **Approve**, note "Checked with Holder C". *Sees:* one segment of the seal fills, "Approved (1 of 2)". Switch to Approver 2, **Approve**: the seal closes, payments execute, the cycle becomes "Paid after approval" (Holder D's payment waits for acceptance again).

## 4. The audit (about 1 minute)

1. Switch to Auditor (no role yet, so it lands on the Audit workspace). Type: `Show all Q3 distributions and the approvals behind any flagged one.`, then **Request access**. *Sees:* the agent's scope with one reason per record and "Holder identities are shown as Holder A to D", then "Request sent", status "Waiting for the treasurer".
2. Switch to Treasurer, Audit, open the request: the exact records beside the question. Choose 7 days, **Grant access**. *Sees:* the seal and "Access granted until {date}".
3. Switch to Auditor: the evidence room opens read-only (decision records, outcomes, payment references, the expiry ring). **Export summary** for working papers. *Say:* when the grant expires the agent closes it and the records disappear; the treasurer's Activity log shows the request, the grant, the view session and the expiry.

## 5. BitSafe segment (placeholder)

To be filled by the infrastructure milestone: Settings, Infrastructure, take Node B offline (`scripts/localnet-node.sh b offline`), run the next cycle on the other two nodes, then show that a governed Mandate change cannot execute below the threshold of 2.

## Reset between takes

Re-seed from a clean LocalNet (`scripts/localnet-down.sh --reset`, bring-up, `pnpm seed:localnet`). Do not reuse August or September: a cycle is paid once.
