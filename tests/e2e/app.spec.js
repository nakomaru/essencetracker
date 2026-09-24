// Run with: npm run test:e2e
import { test, expect } from '@playwright/test';

const PRIORITY_KEY = 'endfield_priorities_v5';

async function open(page) {
  await page.goto('/');
  await page.locator('.card').first().waitFor();
}

async function seed(page, priorities) {
  await page.goto('/');
  await page.evaluate(([key, value]) => localStorage.setItem(key, JSON.stringify(value)), [PRIORITY_KEY, priorities]);
  await page.reload();
  await page.locator('.card').first().waitFor();
}

const card = (page, name) => page.locator(`.card[data-name="${name}"]`);
const detail = (page) => page.locator('#detail');

// A worker runs one test at a time, so one list per worker is enough.
let errors = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('response', (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.url()}`));
});

test.afterEach(() => {
  expect(errors, 'console, page or network errors').toEqual([]);
});

test('renders every weapon with its icon', async ({ page }) => {
  await open(page);
  await expect(page.locator('.card')).toHaveCount(80);
  await page.waitForLoadState('networkidle');
  const broken = await page.$$eval('.wicon img', (imgs) => imgs.filter((i) => i.complete && i.naturalWidth === 0).length);
  expect(broken).toBe(0);
});

test('saved selections survive a weapon rename', async ({ page }) => {
  await seed(page, { 'Contingent Measure': 2, Wedge: 0 });
  await expect(card(page, 'Prominent Edge')).toHaveAttribute('data-p', '2');
  await expect(card(page, 'Wedge')).toHaveAttribute('data-p', '0');
  await expect(card(page, 'Farsight')).toHaveAttribute('data-p', '1');
  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), PRIORITY_KEY);
  expect(saved).not.toHaveProperty('Contingent Measure');
});

test('clicking cycles track, priority, skip', async ({ page }) => {
  await open(page);
  const wedge = card(page, 'Wedge');
  await expect(wedge).toHaveAttribute('data-p', '1');
  await wedge.click();
  await expect(wedge).toHaveAttribute('data-p', '2');
  await wedge.click();
  await expect(wedge).toHaveAttribute('data-p', '0');
  await wedge.click();
  await expect(wedge).toHaveAttribute('data-p', '1');
});

test('starring a weapon keeps only engravings that drop it', async ({ page }) => {
  await open(page);
  await card(page, 'Lone Barge').click();
  const rows = page.locator('.result');
  await expect(rows.first()).toBeVisible();
  const names = await rows.evaluateAll((rs) => rs.map((r) => r.querySelector('.hit[data-p="2"] .hit-name')?.textContent));
  expect(names.every((n) => n === 'Lone Barge')).toBe(true);
});

test('results paginate', async ({ page }) => {
  await open(page);
  await expect(page.locator('.result')).toHaveCount(50);
  await page.click('#more');
  expect(await page.locator('.result').count()).toBeGreaterThan(50);
});

test('detail dialog closes with Escape, backdrop and the back button', async ({ page }) => {
  await open(page);
  await page.locator('.result').first().click();
  await expect(detail(page)).toHaveAttribute('open', '');
  await page.keyboard.press('Escape');
  await expect(detail(page)).not.toHaveAttribute('open', '');
  expect(await page.evaluate(() => history.state?.detail)).toBeFalsy();

  await page.locator('.result').nth(1).click();
  await page.mouse.click(5, 5);
  await expect(detail(page)).not.toHaveAttribute('open', '');

  await page.locator('.result').nth(2).click();
  await page.goBack();
  await expect(detail(page)).not.toHaveAttribute('open', '');
  await expect(page.locator('.card').first()).toBeVisible();
});

test('3-star weapon with its skill fixed needs only its attribute', async ({ page }) => {
  await open(page);
  const skipAll = await page.$$eval('.card', (cs) => Object.fromEntries(cs.map((c) => [c.dataset.name, 0])));
  await seed(page, { ...skipAll, 'Tarr 11': 1, 'Lone Barge': 1 });
  const row = page.locator('.result', { has: page.locator('.stat.skill.fixed', { hasText: /^Assault$/ }) }).first();
  await row.click();
  await expect(detail(page).locator('tr', { hasText: 'Tarr 11' }).locator('.roll')).toHaveText('Main Attribute');
});

test('search matches stats and former names', async ({ page }) => {
  await open(page);
  await page.fill('#search', 'twilight');
  const count = await page.locator('.card').count();
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThan(80);
  await page.fill('#search', 'contingent');
  await expect(page.locator('.card')).toHaveCount(1);
});

test('rarity filter hides weapons', async ({ page }) => {
  await open(page);
  await page.click('[data-rarity="3"]');
  await expect(page.locator('.card.r3')).toHaveCount(0);
});

test('location filter applies and persists', async ({ page }) => {
  await open(page);
  await page.click('.locations summary');
  await page.click('[data-region="Wuling"][data-on="false"]');
  const regions = () => page.locator('.result .loc-region').evaluateAll((e) => [...new Set(e.map((x) => x.textContent))]);
  expect(await regions()).toEqual(['Valley IV']);
  await page.reload();
  await page.locator('.result').first().waitFor();
  expect(await regions()).toEqual(['Valley IV']);
});

const confirmDialog = (page) => page.locator('#confirm');

test('reset restores defaults after confirmation', async ({ page }) => {
  await seed(page, { 'Tarr 11': 2, Wedge: 0 });
  await page.click('[data-bulk="reset"]');
  await expect(confirmDialog(page).locator('.confirm-count')).toHaveText('2 weapons will change:');
  await page.click('#confirm-ok');
  await expect(card(page, 'Tarr 11')).toHaveAttribute('data-p', '0');
  await expect(card(page, 'Wedge')).toHaveAttribute('data-p', '1');
});

test('empty state when nothing is tracked', async ({ page }) => {
  await open(page);
  await page.click('[data-bulk="skip"]');
  await page.click('#confirm-ok');
  await expect(page.locator('#results')).toContainText('Nothing is tracked');
});

for (const action of ['track', 'skip', 'unstar', 'reset']) {
  test(`${action} asks first and changes nothing when canceled or dismissed`, async ({ page }) => {
    await seed(page, { Wedge: 2, 'Lone Barge': 0, 'Tarr 11': 1 });
    const before = await page.$$eval('.card', (cs) => cs.map((c) => c.dataset.p).join());
    await page.click(`[data-bulk="${action}"]`);
    await expect(confirmDialog(page)).toHaveAttribute('open', '');
    await page.click('#confirm-cancel');
    await page.click(`[data-bulk="${action}"]`);
    await page.keyboard.press('Escape');
    await expect(confirmDialog(page)).not.toHaveAttribute('open', '');
    expect(await page.$$eval('.card', (cs) => cs.map((c) => c.dataset.p).join())).toBe(before);
  });
}

test('Escape after a confirmed action does not repeat it', async ({ page }) => {
  await seed(page, { Wedge: 2 });
  await page.click('[data-bulk="unstar"]');
  await page.click('#confirm-ok');
  await expect(card(page, 'Wedge')).toHaveAttribute('data-p', '1');
  await card(page, 'Wedge').click();
  await page.click('[data-bulk="unstar"]');
  await page.keyboard.press('Escape');
  await expect(card(page, 'Wedge')).toHaveAttribute('data-p', '2');
});

test('confirm lists changes and only offers Close when nothing would change', async ({ page }) => {
  await seed(page, { Wedge: 2 });
  await page.click('[data-bulk="unstar"]');
  await expect(confirmDialog(page).locator('.confirm-list li')).toHaveText(['Wedge → tracked']);
  await page.click('#confirm-ok');
  await page.click('[data-bulk="unstar"]');
  await expect(confirmDialog(page).locator('.confirm-count')).toHaveText('No weapons would change.');
  await expect(page.locator('#confirm-ok')).toBeHidden();
  await expect(page.locator('#confirm-cancel')).toHaveText('Close');
});

test('track and skip only touch weapons the filter shows', async ({ page }) => {
  await open(page);
  await page.fill('#search', 'wedge');
  await page.click('[data-bulk="skip"]');
  await expect(confirmDialog(page).locator('.confirm-list li')).toHaveCount(1);
  await page.click('#confirm-ok');
  await page.fill('#search', '');
  await expect(card(page, 'Wedge')).toHaveAttribute('data-p', '0');
  await expect(card(page, 'Lone Barge')).toHaveAttribute('data-p', '1');
});

test.describe('phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('tabs switch panes without horizontal scroll', async ({ page }) => {
    await open(page);
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await expect(page.locator('.result').first()).toBeHidden();
    await page.click('.pane-tabs [data-pane="matches"]');
    await expect(page.locator('.result').first()).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
  });
});
