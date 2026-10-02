import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  test as base,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';

/**
 * The happy path of userflow section 0, in a real browser against the full-stack test server:
 * a treasury with approvers, a sealed Mandate and holders; one clean cycle paid inside the Mandate;
 * one flagged cycle approved by 2 of 3 approvers and paid; one audit request scoped, granted,
 * viewed by the auditor and ended. The test drives the app like a person: it finds everything by
 * its visible name and role, and signs in as the demo parties through the role switcher.
 *
 * An accessibility pass (axe) runs on eight screens along the way: zero serious or critical
 * violations are allowed (userflow 14, U5).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, 'screenshots');

const PASSWORD = 'demo';
const POLICY_PROMPT =
  'Pay monthly yield on the 1st. Auto-pay if the total is under 5,000 CC and nothing looks off. Otherwise 2 of 3 approvals.';
const AUDIT_QUESTION = 'Show all Q3 distributions and the approvals behind any flagged one.';

// The server address is only known once global-setup has started the server.
const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  baseURL: async ({}, use) => {
    const url = process.env['E2E_BASE_URL'];
    if (!url) throw new Error('E2E_BASE_URL is not set: global-setup did not start the server.');
    await use(url);
  },
});

let shotNumber = 0;

/** A screenshot of the page, numbered in the order the story reaches it. */
async function shot(page: Page, name: string): Promise<void> {
  shotNumber += 1;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({
    path: join(SHOTS, `${String(shotNumber).padStart(2, '0')}-${name}.png`),
    fullPage: true,
  });
}

interface AxeSummary {
  screen: string;
  serious: number;
  critical: number;
  moderate: number;
  minor: number;
  /** The rules that fired below serious, for the record. */
  others: string[];
}
const axeSummaries: AxeSummary[] = [];

/** Fails when axe finds a serious or critical violation on the screen as it is now. */
async function expectAccessible(page: Page, screen: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const count = (impact: string): number => violations.filter((v) => v.impact === impact).length;
  axeSummaries.push({
    screen,
    critical: count('critical'),
    serious: count('serious'),
    moderate: count('moderate'),
    minor: count('minor'),
    others: violations
      .filter((v) => v.impact !== 'serious' && v.impact !== 'critical')
      .map((v) => v.id),
  });
  const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const report = blocking
    .map(
      (v) =>
        `${v.impact}: ${v.id} (${v.help})\n` +
        v.nodes
          .slice(0, 4)
          .map(
            (n) => `    ${n.target.join(' ')}: ${n.failureSummary?.split('\n')[1]?.trim() ?? ''}`,
          )
          .join('\n'),
    )
    .join('\n');
  expect(
    blocking,
    `serious or critical accessibility violations on "${screen}":\n${report}`,
  ).toEqual([]);
}

/**
 * Switches the demo party with the "Acting as" selector, as a person would. Holder screens have
 * no selector (they never list other holders, U7); they link to the launch page instead.
 */
async function actAs(page: Page, name: string): Promise<void> {
  const link = page.getByRole('link', { name: 'Switch demo party' });
  if (await link.isVisible()) {
    await link.click();
    await expect(page.getByRole('heading', { name: 'Choose who to act as' })).toBeVisible();
  }
  await page.getByLabel('Acting as').selectOption({ label: name });
  await expect(page.getByRole('banner')).toContainText(name);
}

const run = promisify(execFile);

/**
 * Lighthouse accessibility score (0 to 100) of one page, as the signed-in party of the browser
 * context (its session cookie is sent with every request). Only when E2E_LIGHTHOUSE=1:
 * `pnpm e2e:lighthouse`.
 */
async function lighthouseAccessibility(
  context: BrowserContext,
  url: string,
  label: string,
  preset: 'mobile' | 'desktop',
): Promise<number> {
  const cookies = await context.cookies(url);
  const headers = { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') };
  const out = join(SHOTS, `lighthouse-${label}.json`);
  const headersFile = join(SHOTS, 'lighthouse-headers.json');
  writeFileSync(headersFile, JSON.stringify(headers));
  const chrome = process.env['E2E_CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
  await run(
    join(HERE, '..', 'node_modules', '.bin', 'lighthouse'),
    [
      url,
      '--only-categories=accessibility',
      '--chrome-flags=--headless=new --no-sandbox --disable-gpu',
      `--extra-headers=${headersFile}`,
      ...(preset === 'desktop' ? ['--preset=desktop'] : []),
      '--output=json',
      `--output-path=${out}`,
      '--quiet',
    ],
    {
      timeout: 180_000,
      maxBuffer: 20 * 1024 * 1024,
      // The CLI finds the browser through CHROME_PATH (it has no --chrome-path flag).
      env: { ...process.env, CHROME_PATH: chrome },
    },
  );
  const report = JSON.parse(readFileSync(out, 'utf8')) as {
    categories: { accessibility: { score: number | null } };
  };
  return Math.round((report.categories.accessibility.score ?? 0) * 100);
}

const main = (page: Page): Locator => page.getByRole('main');

/** A link in the left navigation (the rail on wide screens). */
function navigate(page: Page, label: string): Promise<void> {
  return page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: label }).click();
}

async function issueUnits(page: Page, holder: string, units: string, date: string): Promise<void> {
  await page.getByRole('button', { name: 'Issue units' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Issue units' });
  await dialog.getByLabel('Holder').selectOption({ label: holder });
  await dialog.getByLabel('Units').fill(units);
  await dialog.getByLabel('Effective date').fill(date);
  await dialog.getByRole('button', { name: 'Issue units' }).click();
  await expect(dialog).toBeHidden();
}

function payoutRow(page: Page, holder: string): Locator {
  return page
    .getByRole('table', { name: 'Per-holder amounts' })
    .getByRole('row', { name: new RegExp(`^${holder} `) });
}

test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  // What the person would have seen, to read the failure without opening the trace.
  const url = page.url();
  const snapshot = await page
    .locator('body')
    .ariaSnapshot()
    .catch(() => '(no page)');
  process.stdout.write(`\n[e2e] failed at ${url}\n${snapshot}\n`);
});

test.afterAll(() => {
  process.stdout.write('\n[e2e] axe, by screen (serious and critical must be zero):\n');
  for (const s of axeSummaries) {
    process.stdout.write(
      `  ${s.screen.padEnd(28)} critical ${s.critical}  serious ${s.serious}  moderate ${s.moderate}  minor ${s.minor}  ${s.others.join(', ')}\n`,
    );
  }
});

test('a treasury runs a clean and a flagged cycle, a holder sees only their own, an auditor gets scoped access', async ({
  page,
}) => {
  // ---- Landing and launch -------------------------------------------------------------------
  await test.step('the landing page: headline, live seal, Launch app', async () => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: "Your fund's payouts, run by an agent you can audit.",
      }),
    ).toBeVisible();
    // A new fund has no approved distribution yet, so the page replays a labelled example.
    await expect(page.getByText('Example.')).toBeVisible();
    await expect(page.getByRole('img', { name: /2 of 2 signatures, sealed/ })).toBeVisible();
    await expect(
      page.getByText('September 2026, 1,200 CC to 4 holders, approved 2 of 3'),
    ).toBeVisible();
    await expect(page.getByText('88%')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'How it works' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Why Canton' })).toBeVisible();
    await expect(page.getByRole('contentinfo')).toContainText('LocalNet test mode');
    await shot(page, 'landing');
    await expectAccessible(page, 'landing');

    // At 375 px wide nothing scrolls sideways.
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(page.getByRole('link', { name: 'Launch app' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, 'landing-375px');
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  await test.step('Launch app, sign in with the LocalNet password, act as the Treasurer', async () => {
    await page.getByRole('link', { name: 'Launch app' }).click();
    await expect(page.getByRole('heading', { name: 'Launch app' })).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expectAccessible(page, 'launch');
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Choose who to act as' })).toBeVisible();
    await shot(page, 'launch-choose-party');
    await page.getByLabel('Acting as').selectOption({ label: 'Treasurer' });
    // A party that is new to the fund is asked how it is joining.
    await expect(page.getByRole('heading', { name: 'How are you joining?' })).toBeVisible();
    await shot(page, 'start');
  });

  // ---- Set up the organization, the policy and the Mandate ----------------------------------
  await test.step('set up the organization: Approver 1 to 3, 2 of 3', async () => {
    await page.getByRole('link', { name: 'Set up a treasury' }).click();
    await expect(page.getByRole('heading', { name: 'Organization' })).toBeVisible();
    await page.getByLabel('Treasury name').fill('Northwind Income Fund');
    for (const approver of ['Approver 1', 'Approver 2', 'Approver 3']) {
      await page.getByRole('checkbox', { name: approver }).check();
    }
    await page.getByLabel('Approval threshold').selectOption({ label: '2 of 3' });
    await shot(page, 'setup-organization');
    await page.getByRole('button', { name: 'Continue' }).click();
  });

  await test.step('describe the policy and ask the agent; review the mandate', async () => {
    await expect(page.getByRole('heading', { name: 'Policy' })).toBeVisible();
    await page.getByLabel('Describe your policy').fill(POLICY_PROMPT);
    await page.getByRole('button', { name: 'Ask the agent' }).click();
    await expect(page.getByRole('heading', { name: 'In plain English' })).toBeVisible();
    await expect(page.getByLabel('Auto-execute cap (CC)')).toHaveValue('5000');
    await expect(page.getByLabel('Approvals needed')).toHaveValue('2');
    await shot(page, 'setup-policy');
    await expectAccessible(page, 'setup policy');
    await page.getByRole('button', { name: 'Review mandate' }).click();
    await expect(page.getByRole('heading', { name: 'Seal the mandate' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'The agent cannot' })).toBeVisible();
    await shot(page, 'setup-mandate');
  });

  await test.step('Seal mandate: "Mandate sealed", then the Overview', async () => {
    await page.getByRole('button', { name: 'Seal mandate' }).click();
    await expect(page.getByText('Mandate sealed').first()).toBeVisible();
    await shot(page, 'mandate-sealed');
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Active mandate' })).toBeVisible();
    await expect(main(page)).toContainText('Cap 5,000.00 CC');
    await shot(page, 'overview');
    await expectAccessible(page, 'overview');
  });

  // ---- Holders ------------------------------------------------------------------------------
  await test.step('issue units: Holder A 100, B 300, C 600, D 1,000 (effective 2026-05-01)', async () => {
    await navigate(page, 'Holders');
    await expect(page.getByRole('heading', { name: 'Holders', level: 1 })).toBeVisible();
    await issueUnits(page, 'Holder A', '100', '2026-05-01');
    await issueUnits(page, 'Holder B', '300', '2026-05-01');
    await issueUnits(page, 'Holder C', '600', '2026-05-01');
    await issueUnits(page, 'Holder D', '1000', '2026-05-01');
    await expect(page.getByRole('table', { name: 'Holders, 2,000 units in total' })).toBeVisible();
    await expect(page.getByRole('row', { name: /^Holder D / })).toContainText('Auto-receive off');
    await expect(page.getByRole('row', { name: /^Holder A / })).toContainText('Auto-receive on');
    await shot(page, 'holders');
  });

  // ---- Keyboard and reduced motion --------------------------------------------------------------
  await test.step('keyboard: skip link, visible focus, dialogs trap focus and give it back, Escape closes panels', async () => {
    const focusRing = (): Promise<string> =>
      page.evaluate(() => {
        const el = document.activeElement;
        return el ? getComputedStyle(el).outlineStyle : 'none';
      });

    // The first Tab on a page reaches the skip link, and it shows.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Holders', level: 1 })).toBeVisible();
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    expect(await focusRing()).not.toBe('none');

    // A dialog opened from the keyboard keeps Tab inside it; Escape closes it and focus returns.
    const opener = page.getByRole('button', { name: 'Issue units' }).first();
    await opener.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Issue units' });
    await expect(dialog).toBeVisible();
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press(i % 2 === 0 ? 'Tab' : 'Shift+Tab');
      expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();

    // The agent panel opens with Ctrl+K, traps Tab, and closes with Escape.
    await page.keyboard.press('Control+k');
    const panel = page.getByRole('dialog', { name: 'Agent' });
    await expect(panel).toBeVisible();
    for (let i = 0; i < 10; i += 1) {
      await page.keyboard.press('Tab');
      expect(await panel.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();

    // Reduced motion: the landing seal is closed at once and there is nothing to replay.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(page.getByRole('img', { name: /sealed/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Replay the seal' })).toBeHidden();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/app/overview');
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  });

  // ---- August: the clean cycle --------------------------------------------------------------
  await test.step('ask the agent: "Distribute 300 CC for August."', async () => {
    await page.getByRole('button', { name: 'Ask the agent' }).click();
    const panel = page.getByRole('dialog', { name: 'Agent' });
    await panel.getByLabel('Message to the agent').fill('Distribute 300 CC for August.');
    await panel.getByRole('button', { name: 'Send' }).click();
    await expect(
      panel.getByRole('button', { name: /Created proposal for August 2026, 4 payees, 300 CC/ }),
    ).toBeVisible();
    await shot(page, 'agent-august');
    await panel.getByRole('link', { name: 'Open' }).click();
  });

  await test.step('the cycle page: countdown with Hold, then the rows become Paid', async () => {
    await expect(page.getByRole('heading', { name: 'August 2026', level: 1 })).toBeVisible();
    const countdown = page.getByRole('group', { name: 'Automatic payment countdown' });
    await expect(countdown).toContainText('Payments run in');
    await expect(countdown.getByRole('button', { name: 'Hold' })).toBeVisible();
    await shot(page, 'august-countdown');
    for (const holder of ['Holder A', 'Holder B', 'Holder C']) {
      await expect(payoutRow(page, holder)).toContainText('Paid');
    }
    await expect(payoutRow(page, 'Holder D')).toContainText('Awaiting acceptance');
    await expect(payoutRow(page, 'Holder A')).toContainText('15.00 CC');
    await expect(payoutRow(page, 'Holder D')).toContainText('150.00 CC');
    await shot(page, 'august-paid');
  });

  await test.step('Holder D accepts the units and the payment', async () => {
    await actAs(page, 'Holder D');
    await expect(page.getByRole('heading', { name: 'Your position' })).toBeVisible();
    await page.getByRole('link', { name: 'Accept units' }).click();
    await page.getByRole('button', { name: /^Accept units, 1,000 units/ }).click();
    await expect(page.getByText('You hold 1,000 units.')).toBeVisible();
    await shot(page, 'holder-d-units-accepted');
    await page.getByRole('link', { name: 'Go to my home' }).click();
    await page.getByRole('button', { name: 'Accept payment, August 2026' }).click();
    await expect(page.getByRole('row', { name: /^August 2026 / })).toContainText('Paid');
    await expect(main(page)).toContainText('150.00 CC');
    await shot(page, 'holder-d-paid');
  });

  await test.step('the treasurer sees August as Paid automatically', async () => {
    await actAs(page, 'Treasurer');
    await navigate(page, 'Cycles');
    await page.getByRole('link', { name: /August 2026/ }).click();
    await expect(page.getByText('Paid automatically').first()).toBeVisible();
    await expect(payoutRow(page, 'Holder D')).toContainText('Paid');
  });

  // ---- September: the flagged cycle ---------------------------------------------------------
  await test.step('Holder C gets 900 more units just before the record date; run the cycle now for September', async () => {
    await navigate(page, 'Holders');
    await issueUnits(page, 'Holder C', '900', '2026-09-28');
    await expect(page.getByRole('row', { name: /^Holder C / })).toContainText('1,500');
    await navigate(page, 'Overview');
    await page.getByRole('button', { name: 'Run cycle now' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Run cycle now' });
    await dialog.getByLabel('Period').fill('2026-09');
    await dialog.getByLabel('Total (CC)').fill('1200');
    await dialog.getByRole('button', { name: 'Run cycle now' }).click();
  });

  await test.step('the cycle is flagged: "Needs 2 of 3 approvals", with the reasons', async () => {
    await expect(page.getByRole('heading', { name: 'September 2026', level: 1 })).toBeVisible();
    await expect(page.getByText('Needs 2 of 3 approvals').first()).toBeVisible();
    await expect(page.getByText('Awaiting approval 0 of 2')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Why approval is needed' })).toContainText(
      'Holder C: 600 → 1,500 units',
    );
    await expect(page.getByRole('region', { name: 'Checks' })).toContainText('Flagged');
    await expect(page.getByRole('figure', { name: 'Approved 0 of 2' })).toBeVisible();
    await shot(page, 'september-flagged');
    await expectAccessible(page, 'cycle page (flagged)');
  });

  await test.step('Approver 1 approves (seal 1 of 2), Approver 2 approves (seal closes)', async () => {
    await actAs(page, 'Approver 1');
    await page.getByRole('link', { name: /September 2026/ }).click();
    await page.getByLabel('Note (optional)').fill('Checked with Holder C');
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByRole('figure', { name: 'Approved 1 of 2' })).toBeVisible();
    await shot(page, 'september-approved-1-of-2');

    await actAs(page, 'Approver 2');
    await page.getByRole('link', { name: /September 2026/ }).click();
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByRole('img', { name: /2 of 2 signatures, sealed/ })).toBeVisible();
  });

  await test.step('the payments go out; Holder D has to accept again, so it is not fully paid yet', async () => {
    // What the server shows: A to C are paid at once; D has no auto-receive, so D's transfer waits.
    for (const holder of ['Holder A', 'Holder B', 'Holder C']) {
      await expect(payoutRow(page, holder)).toContainText('Paid');
    }
    await expect(payoutRow(page, 'Holder D')).toContainText('Awaiting acceptance');
    await expect(page.getByText('Awaiting acceptance').first()).toBeVisible();
    await shot(page, 'september-executed');

    await actAs(page, 'Holder D');
    await page.getByRole('button', { name: 'Accept payment, September 2026' }).click();
    await expect(page.getByRole('row', { name: /^September 2026 / })).toContainText('Paid');

    await actAs(page, 'Treasurer');
    await navigate(page, 'Cycles');
    await page.getByRole('link', { name: /September 2026/ }).click();
    await expect(page.getByText('Paid after approval').first()).toBeVisible();
    await shot(page, 'september-paid-after-approval');
  });

  // ---- A holder sees only their own -----------------------------------------------------------
  await test.step('Holder A sees only Holder A: their payments, nobody else', async () => {
    await actAs(page, 'Holder A');
    await expect(page.getByRole('heading', { name: 'Your position' })).toBeVisible();
    const payments = page.getByRole('table', { name: 'Payment history' });
    await expect(payments.getByRole('row', { name: /^August 2026 / })).toContainText('15.00');
    await expect(payments.getByRole('row', { name: /^September 2026 / })).toContainText(
      '41.3793103448',
    );
    await expect(main(page)).toContainText('Only you and the fund can see your position.');
    // Holder screens have no "Acting as" list (U7): no other holder is named anywhere on them.
    await expect(page.getByLabel('Acting as')).toHaveCount(0);
    const whole = await page.locator('body').innerText();
    for (const other of ['Holder B', 'Holder C', 'Holder D']) expect(whole).not.toContain(other);
    const text = await main(page).innerText();
    for (const other of ['Holder B', 'Holder C', 'Holder D']) expect(text).not.toContain(other);
    // The other holders' amounts and party ids are nowhere on the page either.
    for (const amount of ['45.00', '90.00', '150.00', '124.1379', '620.6896', '413.7931']) {
      expect(text).not.toContain(amount);
    }
    expect(text).not.toMatch(/holder[BCD][0-9a-f]*::/);
    await shot(page, 'holder-a-home');
    await expectAccessible(page, 'holder home');
  });

  // ---- The audit ----------------------------------------------------------------------------
  await test.step('the Auditor says "I\'m an auditor" and asks for the Q3 records', async () => {
    await actAs(page, 'Auditor');
    await page.goto('/start');
    await page
      .getByRole('region', { name: "I'm an auditor" })
      .getByRole('link', { name: 'Open the audit workspace' })
      .click();
    await expect(page.getByRole('heading', { name: 'Audit workspace' })).toBeVisible();
    await page.getByRole('button', { name: 'New request' }).click();
    await page.getByLabel('What do you need to see?').fill(AUDIT_QUESTION);
    await page.getByRole('button', { name: 'Propose scope' }).click();
    await expect(page.getByRole('button', { name: 'Request access' })).toBeVisible();
    await expect(main(page)).toContainText('Holder identities are shown as Holder A to D');
    await shot(page, 'auditor-scope');
    await expectAccessible(page, 'auditor workspace');
    await page.getByRole('button', { name: 'Request access' }).click();
    await expect(page.getByText('Waiting for the treasurer').first()).toBeVisible();
    await shot(page, 'auditor-request-sent');
  });

  await test.step('the treasurer opens the request and grants access for 24 hours', async () => {
    await actAs(page, 'Treasurer');
    await navigate(page, 'Audit');
    await page.getByRole('link', { name: /Show all Q3 distributions/ }).click();
    await expect(page.getByRole('heading', { name: "Auditor's question" })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Records that would be shared' })).toBeVisible();
    await shot(page, 'audit-review');
    await expectAccessible(page, 'audit review');
    await page.getByRole('radio', { name: '24 hours' }).check();
    await page.getByRole('button', { name: 'Grant access' }).click();
    await expect(page.getByRole('heading', { name: /^Access granted until/ })).toBeVisible();
    await shot(page, 'audit-granted');
  });

  await test.step('the auditor opens the evidence room: the records, with Holder A to D labels', async () => {
    await actAs(page, 'Auditor');
    await page.getByRole('button', { name: /Show all Q3 distributions/ }).click();
    await expect(page.getByRole('heading', { name: 'Evidence room' })).toBeVisible();
    const room = page.getByRole('region', { name: 'Evidence room' });
    // A decision record and an outcome for each month.
    await expect(room.getByRole('heading', { name: 'August 2026' })).toHaveCount(2);
    await expect(room.getByRole('heading', { name: 'September 2026' })).toHaveCount(2);
    await expect(room).toContainText('Approver 1');
    await expect(room).toContainText('Approver 2');
    const text = await room.innerText();
    for (const label of ['Holder A', 'Holder B', 'Holder C', 'Holder D']) {
      expect(text).toContain(label);
    }
    // Holder D accepted both transfers after the distributions ran. The outcomes were written
    // when D's payment was still waiting, so "Paid" here is the live state of the payment.
    for (const month of ['August 2026', 'September 2026']) {
      const payments = room.getByRole('table', { name: `Payments, ${month}` });
      for (const label of ['Holder A', 'Holder B', 'Holder C', 'Holder D']) {
        await expect(payments.getByRole('row', { name: new RegExp(`^${label} `) })).toContainText(
          'Paid',
        );
      }
    }
    expect(text).not.toContain('Awaiting acceptance');
    expect(text).not.toMatch(/::1220/);
    await shot(page, 'evidence-room');
  });

  await test.step('the treasurer ends access now; the auditor sees "Access ended"', async () => {
    await actAs(page, 'Treasurer');
    await navigate(page, 'Audit');
    await page.getByRole('link', { name: /Show all Q3 distributions/ }).click();
    await page.getByRole('button', { name: 'End access now' }).click();
    await page
      .getByRole('dialog', { name: 'End access now?' })
      .getByRole('button', { name: 'End access now' })
      .click();
    await expect(page.getByRole('heading', { name: /^Access ended/ })).toBeVisible();
    await shot(page, 'audit-ended-treasurer');

    await actAs(page, 'Auditor');
    await page.getByRole('button', { name: /Show all Q3 distributions/ }).click();
    await expect(page.getByText(/Access ended/).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Evidence room' })).toBeHidden();
    await shot(page, 'audit-ended-auditor');
  });
  await test.step('the landing page now replays the real September distribution', async () => {
    await page.goto('/');
    await expect(page.getByText('Latest approved distribution on this ledger')).toBeVisible();
    await expect(
      page.getByText('September 2026, 1,200 CC to 4 holders, approved 2 of 3'),
    ).toBeVisible();
    await expect(page.getByText('Example.')).toBeHidden();
    // Only the aggregate is public: no names, no party ids, no per-holder amounts.
    const body = await page.evaluate(async () => (await fetch('/api/public/showcase')).text());
    expect(JSON.parse(body)).toEqual({
      cycleLabel: 'September 2026',
      total: '1200.0000000000',
      assetSymbol: 'CC',
      payees: 4,
      approvals: { have: 2, need: 2, approvers: 3 },
    });
    await shot(page, 'landing-live-seal');
  });

  if (process.env['E2E_LIGHTHOUSE'] === '1') {
    await test.step('Lighthouse accessibility scores (E2E_LIGHTHOUSE=1)', async () => {
      const base = process.env['E2E_BASE_URL'] ?? '';
      const pages: {
        label: string;
        path: string;
        party: string | null;
        preset: 'mobile' | 'desktop';
      }[] = [
        { label: 'landing-mobile', path: '/', party: null, preset: 'mobile' },
        { label: 'landing-desktop', path: '/', party: null, preset: 'desktop' },
        { label: 'launch', path: '/launch', party: null, preset: 'mobile' },
        { label: 'overview', path: '/app/overview', party: 'Treasurer', preset: 'mobile' },
        {
          label: 'cycle-flagged',
          path: '/app/cycles/2026-09',
          party: 'Treasurer',
          preset: 'mobile',
        },
        { label: 'holder-home', path: '/holder', party: 'Holder A', preset: 'mobile' },
        { label: 'audit-workspace', path: '/auditor', party: 'Auditor', preset: 'mobile' },
      ];
      const scores: string[] = [];
      for (const target of pages) {
        if (target.party) {
          // The switcher is on the launch page and in every app header.
          await page.goto('/launch');
          await page.getByLabel('Acting as').selectOption({ label: target.party });
          await expect(async () => {
            const reply = await page.request.get('/api/session');
            const session = (await reply.json()) as { party: { displayName: string } | null };
            expect(session.party?.displayName).toBe(target.party);
          }).toPass();
        }
        const score = await lighthouseAccessibility(
          page.context(),
          `${base}${target.path}`,
          target.label,
          target.preset,
        );
        scores.push(`${target.label.padEnd(18)} ${score}`);
        process.stdout.write(`[e2e] Lighthouse ${target.label}: ${score}\n`);
      }
      process.stdout.write(`\n[e2e] Lighthouse accessibility:\n  ${scores.join('\n  ')}\n`);
    });
  }
});
