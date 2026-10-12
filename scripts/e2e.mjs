// Browser walkthrough of the real app (real API, ML service and Postgres; no mocks). Used by `npm run release:gate`.
// Needs Chromium: set PLAYWRIGHT_CHROMIUM to its path (or let playwright-core find one).
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const axeSource = () => readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');

/** @param {{ base: string, email: string, password: string }} options */
export async function runE2E({ base, email, password }) {
  const steps = [];
  const check = (name, ok, detail = '') => { steps.push({ name, ok: Boolean(ok), detail }); if (!ok) throw new Error(`E2E step failed: ${name} ${detail}`); };
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined, args: ['--no-proxy-server'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/401|favicon/.test(m.text())) errors.push(m.text()); });
  try {
    // sign-in
    await page.goto(base);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('alert').filter({ hasText: /incorrect/i }).waitFor({ timeout: 10000 });
    check('wrong password is refused', true);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByText('Start monitoring a brand').waitFor();
    check('admin signs in and sees the empty state', true);

    // demo brand: scan, measure
    await page.getByRole('button', { name: 'Add demo brand' }).click();
    await page.getByText('Northstar is a fictional brand').waitFor();
    check('demo brand is labelled as demo data', await page.locator('h1').getByText('DEMO DATA').isVisible());
    await page.getByRole('button', { name: /Scan now/ }).click();
    await page.getByText(/Last scan: succeeded/).waitFor({ timeout: 120000 });
    const evaluation = await page.getByText(/Against the demo labels/).innerText();
    check('demo scan catches every planted fake with no false positives', /caught 16 of 16/.test(evaluation) && /0 false positives/.test(evaluation), evaluation);

    // findings and review
    await page.getByRole('link', { name: 'Findings' }).click();
    await page.locator('tbody tr').first().waitFor();
    const rows = await page.locator('tbody tr').count();
    check('findings list is populated', rows >= 10, `${rows} rows`);
    await page.locator('tbody tr').first().click();
    const dialog = page.getByRole('dialog', { name: 'Finding detail' });
    await dialog.getByText('Why it was flagged').waitFor();
    check('drawer takes keyboard focus', await dialog.evaluate((el) => el === document.activeElement));
    check('official needs a note', await dialog.getByRole('button', { name: 'Mark official' }).isDisabled());
    await dialog.getByLabel('Note').fill('Looks like a clone of the support account');
    await dialog.getByRole('button', { name: 'Confirm impersonation' }).click();
    await dialog.getByText(/New → Confirmed impersonation/).waitFor();
    check('review decision is recorded in the audit trail', true);
    await page.keyboard.press('Escape');
    check('Escape closes the drawer', await dialog.isHidden());

    // sources
    await page.getByRole('link', { name: 'Source health' }).click();
    const tiktok = page.getByRole('article', { name: 'TikTok' });
    await tiktok.waitFor();
    check('unsupported platforms are listed as unsupported', /Not supported/.test(await tiktok.innerText()));

    // live brand: nothing is seeded
    await page.getByRole('button', { name: 'Live brand' }).click();
    await page.getByLabel('Brand name').fill('Gate Test Pay');
    await page.getByLabel('Official domain', { exact: true }).fill('gatetestpay.example.com');
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await page.getByLabel('Handle').fill('@gatetestpay');
    await page.getByRole('button', { name: 'Create brand' }).click();
    await page.getByRole('heading', { name: /Gate Test Pay/ }).waitFor();
    await page.getByText('No scans yet').waitFor();
    check('live brand shows LIVE, with no findings and no scans (nothing seeded)', (await page.locator('h1').getByText('LIVE').isVisible()) && (await page.getByText('No open findings.').isVisible()) && (await page.getByText('No scans yet').isVisible()));
    await page.getByRole('link', { name: 'Brand profile' }).click();
    await page.getByRole('group', { name: /Official social accounts/ }).waitFor();
    check('a typed-in account is Unverified, not trusted', /Unverified/.test(await page.getByRole('group', { name: /Official social accounts/ }).innerText()));

    // accessibility in the real browser (WCAG 2 A/AA, including contrast)
    const source = axeSource();
    for (const hash of ['overview/1', 'findings/1', 'scans/1', 'sources/1', 'brand/2', 'users/1']) {
      await page.goto(`${base}/#${hash}`);
      await page.waitForTimeout(800);
      await page.evaluate(source);
      const violations = await page.evaluate(() => window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa'] }).then((r) => r.violations.map((v) => `${v.id}: ${v.nodes[0].target.join(' ')}`)));
      check(`no WCAG A/AA violations on ${hash.split('/')[0]}`, violations.length === 0, violations.join('; '));
    }

    // mobile layout
    await page.setViewportSize({ width: 390, height: 800 });
    for (const hash of ['overview/1', 'findings/1', 'sources/1', 'brand/2']) {
      await page.goto(`${base}/#${hash}`);
      await page.waitForTimeout(600);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`${hash.split('/')[0]} fits a 390 px screen`, overflow <= 1, `${overflow}px over`);
    }
    await page.setViewportSize({ width: 1400, height: 900 });

    // sign out ends the session
    await page.getByRole('button', { name: /Sign out/ }).click();
    await page.getByRole('form', { name: 'Sign in' }).waitFor();
    check('sign out returns to the sign-in form', true);
    check('no browser errors during the walkthrough', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
  }
  return steps;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [base, email, password] = process.argv.slice(2);
  runE2E({ base, email, password }).then((steps) => { for (const s of steps) console.log(`${s.ok ? 'PASS' : 'FAIL'}  ${s.name}`); }, (e) => { console.error(e.message); process.exit(1); });
}
