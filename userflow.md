# Mithra: user flow and UX

How each person moves through Mithra, from the landing page to a successful use of the product, plus the design direction for the UI. Product rules live in `details.md`; hard requirements in `specs.md`.

## 0. What "success" means

The happy path is complete when, in one session:
1. A treasury organization exists with approvers, a signed Mandate and holders.
2. One clean cycle has auto-executed inside the Mandate and holders received CC.
3. One flagged cycle has been approved by the threshold of approvers and paid.
4. One audit request has been scoped, granted, viewed by the auditor and closed at expiry.

Every screen below exists to move someone one step closer to that.

## 1. Design direction

### Subject and feel
A fund's back office where agreements are kept. The feel is a calm, exact instrument: quiet surfaces, precise numbers, and one ceremonial moment, the seal, whenever someone commits to something. Mithra is the god of covenants, so signing, approving and granting are treated as acts of sealing an agreement.

### Palette
| Name | Hex | Use |
|---|---|---|
| Porcelain | `#F4F6F8` | App background |
| Night ink | `#151A2D` | Primary text, dark surfaces |
| Lapis | `#1F3A6E` | Primary actions, links, selected states |
| Saffron seal | `#D99A1E` | Only for seals: Mandate, approvals, access grants |
| Verdigris | `#2E7D6A` | Paid, passed checks, active grants |
| Garnet | `#A23A4E` | Flags, failures, expired or denied |

Rules: Saffron appears only on seal moments so it keeps its meaning. Status colors always pair with an icon and a word, never color alone. Provide a dark theme from the same tokens.

### Type
- **Newsreader** (serif) for page titles and large amounts. Amounts use tabular, lining figures.
- **Public Sans** for everything else.
- Sentence case everywhere. No all-caps labels, no eyebrow labels above headings.
- Scale: 13 / 15 / 18 / 24 / 32 / 44 px. Body 15 px, line length under 75 characters.

### The one memorable element: the seal
A circular ring split into one segment per required signer. Each signature fills a segment in Saffron with a short, satisfying settle animation. When the ring closes, it becomes a solid seal stamped with the action ("Mandate sealed", "Approved 2 of 3", "Access granted until Oct 14"). The seal appears on:
- Mandate signing.
- Proposal approvals (shows threshold progress at a glance).
- Access grants (the ring slowly empties as expiry approaches).

Everything else stays quiet: no decorative gradients, no entrance animations on every section, no hover effects on every card.

### The one live moment: the agent timeline
When a cycle runs, a vertical timeline fills step by step in real time: woke up, snapshot taken, amounts computed, checks run, review written, verdict. This is the only motion that runs without a user action.

### Layout
- **Treasurer and approvers:** left navigation (Overview, Agent, Cycles, Holders, Audit, Activity, Settings), main content, and an agent panel that can slide in from the right on any screen.
- **Holder:** single column, no navigation beyond their payments and units.
- **Auditor:** two panes: requests on the left, evidence room on the right.
- Left-aligned content. Numbers right-aligned in tables.
- Responsive down to 375 px wide: navigation collapses to a bottom bar; tables become stacked rows.

### Voice and vocabulary
Plain, specific, active. One name per action across the whole product:

| Action | Button | Confirmation |
|---|---|---|
| Sign the agent's authority | Seal mandate | Mandate sealed |
| Approve a proposal | Approve | Approved (2 of 3) |
| Reject a proposal | Reject | Rejected |
| Run a cycle immediately | Run cycle now | Cycle started |
| Auditor asks for records | Request access | Request sent |
| Treasurer grants it | Grant access | Access granted until {date} |
| Treasurer refuses | Deny | Request denied |
| Holder enables auto-receive | Turn on auto-receive | Auto-receive is on |

Errors say what happened and what to do next. Empty states invite the next action.

## 2. Landing page (first visit)

**Hero:** a live, animated replay of the seal closing on a real proposal ("September distribution, 1,200 CC to 4 holders, approved 2 of 3"), beside the headline:

> Your fund's payouts, run by an agent you can audit.

Sub-line: "Mithra prepares every distribution, pays inside limits your team sets on Canton, and shows auditors exactly what they ask for. Nothing more."

Primary button: **Launch app**. Secondary: **Watch the 3-minute demo**.

Below the hero, three short sections, no more:
1. **The problem**, in three numbers with sources: 88% report payment ops problems; the $894M Revlon error after three reviewers; 10 to 25 business days for one bank confirmation.
2. **How it works**, as a real sequence: set the rules, the agent runs the cycle, your team approves what is flagged, auditors see only what you grant.
3. **Why Canton**: each holder sees only their own payment; the agent's limits are enforced by the ledger, not by the app.

Footer: network badge (LocalNet test mode or MainNet), GitHub link.

## 3. Launch and connect

> **Update (decision 11, 2026-10-02).** Mithra's records always live on the LocalNet ledger, so on both networks the app starts with the LocalNet sign-in and the role switcher; the badge reads "LocalNet test mode", or "MainNet payouts · records on LocalNet" when `NETWORK=mainnet`. On MainNet only the CC payouts are signed in Grofty Wallet (by the treasurer). Holders connect Grofty on their welcome page to register the MainNet wallet they are paid to. The "Connect Grofty Wallet" step 2 below applies to holders and to the treasurer's payouts, not to signing in. See `docs/decisions.md`.

1. User clicks **Launch app**.
2. **MainNet mode:** "Connect Grofty Wallet". If the extension is missing, show how to install it and a link back. On connect, show the party ID shortened with a copy button.
   **LocalNet mode:** a sign-in screen, then a role switcher listing the demo parties (Treasurer, Approver 1, 2, 3, Holders A to D, Auditor). A persistent "LocalNet test mode" badge stays visible.
3. Mithra checks the party's role and routes:
   - Unknown party: "Set up a treasury" or "I was invited" (enter invite code).
   - Treasurer: Overview.
   - Approver: Overview, opened on the approvals inbox if anything is pending.
   - Holder: Holder home.
   - Auditor: Audit workspace.

## 4. Treasurer: first-time setup

A three-step setup with a progress indicator (this is a real sequence, so numbering is correct here).

### Step 1: Organization
- Fields: treasury name, base asset (CC, fixed for now), approvers (party ID or invite by link), approval threshold (picker showing "2 of 3" with the seal ring preview).
- Validation inline. Duplicate or malformed party IDs are flagged on the field.
- Button: **Continue**.

### Step 2: Policy, drafted by the agent
- A single prompt box with an example in the placeholder: "Pay monthly yield on the 1st. Auto-pay if the total is under 5,000 CC and nothing looks off. Otherwise 2 of 3 approvals."
- The agent responds with a structured policy card beside a plain-English summary:
  - Schedule: monthly, 1st, 09:00 UTC
  - Record date: last day of the previous month
  - Auto-execute cap: 5,000 CC
  - Approval threshold: 2 of 3
  - Flag if: total deviates more than 50% from the 3-cycle average; a holder's units changed more than 100% in the 3 days before the record date
- Every field is editable in place. Edits update the summary live.
- The treasurer can keep chatting to adjust ("make the cap 3,000").
- Button: **Review mandate**.

### Step 3: Seal the mandate
- A clear two-column statement: "The agent can" / "The agent cannot".
- Seal ring with one segment (the treasurer).
- Button: **Seal mandate**. Wallet signature (MainNet) or confirmation (LocalNet).
- Success: the seal closes, "Mandate sealed", then Overview.

## 5. Treasurer: holders

**Holders page.** Table: holder name, party ID, units, share %, auto-receive status, last payment.
- **Issue units:** pick or invite a holder, enter units, confirm.
- **Invite link:** copyable link for the holder.
- Holders without auto-receive show a warning: "Payments to this holder will wait for them to accept."
- Empty state: "No holders yet. Issue units to your first holder to start paying yield."

## 6. Holder onboarding and home

> **Update (decision 11, 2026-10-02).** Accepting units, and everything else a holder does besides their wallet, is recorded on the LocalNet ledger as the demo party. On MainNet payouts the holder additionally **connects Grofty Wallet** (the app asks the wallet to sign a short message, so the server knows which MainNet party the holder is paid to) and **turns on auto-receive in Grofty**; payments are then CC transfers on MainNet and link to the explorer. Step 2 below reads "Connects wallet" in that sense. See `docs/decisions.md`.

1. Holder opens the invite link, sees the fund name and units offered.
2. Connects wallet (Grofty on MainNet).
3. **Accept units**.
4. Prompt: "Turn on auto-receive so yield arrives without you having to accept each payment." Button: **Turn on auto-receive**. Success: "Auto-receive is on".
5. **Holder home:** units held, share of fund, total yield received, next expected payment date, payment history with links to the explorer for each CC transfer.
- A small note: "Only you and the fund can see your position."
- No other holders' names, units or amounts appear anywhere.

## 7. Treasurer: Overview (home)

- **Top row:** treasury balance (large Newsreader figure), next cycle with countdown, active mandate (cap and threshold, with its seal), pending approvals count.
- **Recent cycles:** status chips (Paid automatically, Awaiting approval 1 of 2, Paid after approval, Rejected).
- **Recent activity:** last 10 log entries.
- **Run cycle now** button (also available from the agent).
- If balance is below the next expected total plus fees: a Garnet warning with "Add funds".

## 8. Treasurer: working with the agent

The agent panel opens from any screen. It is a chat with visible tool use: each action the agent takes appears as a compact, expandable card ("Created proposal for September, 4 payees, 1,200 CC").

Example prompts the UI suggests:
- "Distribute 1,200 CC for September."
- "Why was last cycle flagged?"
- "What did we pay Holder B in Q3?"
- "Raise the cap to 3,000 CC." (The agent drafts the change and asks the treasurer to re-seal the mandate; it never applies it alone.)

When a request exceeds the mandate, the agent says so plainly: "5,000 CC is your auto-pay cap. I've prepared this as a proposal that needs 2 of 3 approvals."

## 9. A cycle runs

Triggered by schedule, by **Run cycle now**, or by a prompt.

**Cycle page, live:**
1. Agent timeline fills in real time.
2. Then the proposal appears:
   - Header: cycle name, total, record date, verdict.
   - Per-holder table: holder, units on record date, share, amount.
   - Checks list: each check with pass or flag, and the actual values ("Total 1,200 CC vs 3-cycle average 410 CC, +193%").
   - Memo: the agent's plain-English review.
   - Decision record link.

**Clean path:** verdict "Within mandate". After a short visible countdown with a **Hold** button (so a human can stop it), payments execute. Each row turns Verdigris "Paid" with an explorer link. Cycle status: "Paid automatically".

**Flagged path:** verdict "Needs 2 of 3 approvals" with the reasons. Seal ring shows 0 of 2 (or the configured threshold). Approvers are notified.

## 10. Approver flow

1. Approver lands on the **Approvals inbox**: pending proposals with total, flag count and age.
2. Opens a proposal: same view as above, flags at the top, memo expanded.
3. Can ask the agent about it from the panel ("Is Holder C's increase legitimate?").
4. **Approve** or **Reject** (reject asks for a short reason).
5. Approve: wallet signature; a seal segment fills. "Approved (1 of 2)".
6. When the threshold is met: the seal closes, payments execute, rows turn "Paid".
7. Rejected: cycle status "Rejected", reason shown, no payments.

## 11. Auditor flow

1. Auditor connects and lands on the **Audit workspace**.
2. **New request:** a prompt box. Example: "Show all Q3 distributions and the approvals behind any flagged one."
3. The agent proposes a scope: a list of records, each with a one-line reason, and what is excluded ("Holder identities are shown as Holder A to D unless you ask for them").
4. Auditor can refine, then **Request access**. Status: "Request sent".
5. **Treasurer side:** an Audit page lists requests. Opening one shows the exact records that would be shared, side by side with the auditor's question. Pick an expiry (24 hours, 7 days, 30 days). **Grant access** or **Deny**. Granting shows the seal and "Access granted until {date}".
6. **Auditor evidence room:** read-only. Distributions, decision records (inputs fingerprint, checks, memo, approvals), payment references with explorer links. A ring at the top empties as expiry approaches. Export a summary for working papers.
7. At expiry the agent closes the grant. Both sides see "Access ended {date}". The records disappear from the auditor's view.
8. **Activity log** on the treasurer side shows request, scope, grant, every view session, and expiry.

## 12. Settings

- **Organization:** name, approvers, threshold (changes require re-sealing).
- **Mandate:** current terms and seal; **Edit and re-seal**.
- **Network:** shows current mode (LocalNet test mode or MainNet).
- **Infrastructure (LocalNet):** the treasury party's hosting nodes, each node's operator, the hosting threshold (2 of 3) and live node status. When a node is offline it shows "Still running on 2 of 3 nodes".

## 13. States every screen must handle

- **Loading:** skeletons shaped like the content, never a blank screen.
- **Empty:** one sentence and the next action.
- **Error:** what failed and what to do ("Your wallet approval expired after 3 minutes. Approve again."). Never a raw error code alone.
- **Pending ledger action:** the action stays visibly in progress until the ledger confirms; never show "Paid" before it is final.
- **Wallet missing or locked:** clear instructions to install or unlock Grofty.
- **Seeded data:** cycles and payments created by seeding scripts carry a small "Seeded" tag.

## 14. Accessibility and quality floor

- Visible keyboard focus everywhere; the whole app is usable by keyboard.
- Color contrast at least WCAG AA.
- Respects reduced-motion: the seal and timeline change state without animation.
- Every status uses icon plus text, not color alone.
- Works at 375 px wide.
