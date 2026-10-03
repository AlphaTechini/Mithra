# Accessibility

Specs U5 and userflow section 14: visible keyboard focus, WCAG AA contrast, reduced motion, status as icon plus text, works at 375 px, Lighthouse accessibility at least 90. Results of the checks run in M12 (2026-10-02), how to repeat them, and what is not covered.

## Automated: axe inside the Playwright run

`pnpm e2e` runs axe-core (`@axe-core/playwright`, all rules, default tags) on eight screens at the point in the story where each is fully rendered, and fails on any **serious or critical** violation. Result of the last run:

| Screen                                  | Critical | Serious | Moderate | Minor |
| --------------------------------------- | -------- | ------- | -------- | ----- |
| Landing page                            | 0        | 0       | 0        | 0     |
| Launch (sign-in form)                   | 0        | 0       | 0        | 0     |
| Setup, policy (agent draft showing)     | 0        | 0       | 0        | 0     |
| Treasurer overview                      | 0        | 0       | 0        | 0     |
| Cycle page, flagged proposal            | 0        | 0       | 0        | 0     |
| Holder home                             | 0        | 0       | 0        | 0     |
| Auditor workspace (scope proposed)      | 0        | 0       | 0        | 0     |
| Audit review (treasurer, request open)  | 0        | 0       | 0        | 0     |

The first run reported one moderate finding on every screen, `region` (the "LocalNet test mode" strip was outside any landmark). It is now an `aside` labelled "Network mode", and the count is zero. Light theme only; the dark theme uses the same tokens (contrast ratios of both themes are listed in `apps/web/src/lib/styles/tokens.css`).

## Lighthouse accessibility (CLI, headless Chromium)

Lighthouse 13.5.0, category `accessibility`, run by `pnpm e2e:lighthouse` at the end of the story with the browser's session cookie sent as a header, so the app pages are the signed-in screens (final URL equals the requested URL, no redirect to `/launch`). Mobile emulation (375 px wide) unless stated. Target: at least 90.

| Page                                          | Party        | Score |
| --------------------------------------------- | ------------ | ----- |
| `/` landing, mobile                           | none         | 100   |
| `/` landing, desktop preset                   | none         | 100   |
| `/launch`                                     | none         | 100   |
| `/app/overview`                               | Treasurer    | 100   |
| `/app/cycles/2026-09` (flagged cycle, paid)   | Treasurer    | 100   |
| `/holder`                                     | Holder A     | 100   |
| `/auditor`                                    | Auditor      | 100   |

To repeat one page by hand: start the server (`pnpm --filter @mithra/backend e2e:server`), sign in, copy the `mithra_session` cookie, then `CHROME_PATH=/opt/pw-browsers/chromium npx lighthouse http://127.0.0.1:8788/launch --only-categories=accessibility --chrome-flags="--headless=new --no-sandbox" --extra-headers='{"Cookie":"mithra_session=..."}'`. (The Lighthouse CLI has no `--chrome-path` flag; it reads `CHROME_PATH`.) Lighthouse leaves ten checks as "manual"; the keyboard checklist below covers the ones that matter here.

## Keyboard and motion: what was checked

Checked in the Playwright run (step "keyboard: ...") unless marked otherwise.

| Check                                                                                             | How                              | Result |
| ------------------------------------------------------------------------------------------------- | -------------------------------- | ------ |
| First Tab on a page reaches "Skip to main content", and it is visible                             | Playwright, Holders page         | pass   |
| Focus is visible (a focus ring, `outline-style` not `none`) on the skip link                       | Playwright                       | pass   |
| Tab order follows the reading order: skip link, header (badge strip, party, switcher, Ask the agent, Sign out), navigation, main content | read from the markup order; `:focus-visible` rule in `base.css` covers every interactive element | pass (reviewed, not scripted) |
| A dialog opened with Enter keeps Tab and Shift+Tab inside it (24 key presses)                      | Playwright, Issue units dialog   | pass   |
| Escape closes the dialog and focus returns to the button that opened it                            | Playwright                       | pass   |
| Ctrl+K opens the agent panel, Tab stays inside it, Escape closes it                                | Playwright; `AgentPanel.test.ts` (also Cmd+K, focus returns to the opener) | pass |
| Every control used by the whole happy path was reached by its role and visible name               | the Playwright story itself      | pass   |
| Reduced motion (`prefers-reduced-motion: reduce`): the landing seal shows closed at once and there is no "Replay the seal" button; app animations are switched off in `base.css` | Playwright with `emulateMedia` for the landing page; the CSS rule is global | pass |
| Status is never colour alone: every chip has an icon and a word                                    | `StatusChip.test.ts` ("uses a different icon for statuses that share a colour"); axe `color-contrast` and `link-in-text-block` | pass |
| 375 px: no sideways scrolling on the landing page                                                  | Playwright (`scrollWidth <= clientWidth` at 375 px) | pass |
| Contrast AA                                                                                        | axe `color-contrast` on the eight screens (light theme); token pairs computed in `tokens.css` | pass |

## Not covered

- Screen readers were not run (no NVDA, JAWS or VoiceOver here); the markup is checked by axe and by tests that query by role and accessible name, and the seal announces its count in words (`Seal.test.ts`).
- Axe and Lighthouse ran on seven or eight screens, not every screen (Settings, Activity, Invites, the transaction pages and the MainNet signing panel are not scanned). They share the components that were scanned.
- 375 px was checked for overflow on the landing page; the other screens' stacked-row layout is covered by component tests (`DataTable.test.ts`), not by a browser at that width.
- Dark theme contrast is computed in `tokens.css`, not scanned.
