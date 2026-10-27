// Run with: npm run test:e2e
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(new URL('../../data.json', import.meta.url), 'utf8'));
const PRIORITY_KEY = 'endfield_priorities_v6';
const LEGACY_PRIORITY_KEY = 'endfield_priorities_v5';
const LEGACY_EXCLUDED_KEY = 'endfield_excluded_locations_v1';

const weaponId = (name) => data.weapons.find((w) => w.name === name).id;
const announced = data.weapons.filter((w) => w.announced);

async function open(page) {
  await page.goto('/');
  await page.locator('.card').first().waitFor();
}

// Loads the app with only `entries`, a list of [key, value] pairs, in localStorage.
async function store(page, entries) {
  await page.goto('/');
  await page.evaluate((e) => {
    localStorage.clear();
    for (const [key, value] of e) localStorage.setItem(key, JSON.stringify(value));
  }, entries);
  await page.reload();
  await page.locator('.card').first().waitFor();
}

// Seeds priorities given by weapon name.
const seed = (page, byName) =>
  store(page, [[PRIORITY_KEY, Object.fromEntries(Object.entries(byName).map(([n, p]) => [weaponId(n), p]))]]);

const card = (page, name) => page.locator(`.card[data-id="${weaponId(name)}"]`);
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
  await expect(page.locator('.card')).toHaveCount(data.weapons.length);
  await page.waitForLoadState('networkidle');
  const broken = await page.$$eval('.wicon img', (imgs) => imgs.filter((i) => i.complete && i.naturalWidth === 0).length);
  expect(broken).toBe(0);
});

test('selections saved by name, including former names, carry over to ids', async ({ page }) => {
  await store(page, [
    [LEGACY_PRIORITY_KEY, { 'Contingent Measure': 2, Wedge: 0 }],
    [LEGACY_EXCLUDED_KEY, ['North Wuling Exclusion Zone']],
  ]);
  await expect(card(page, 'Prominent Edge')).toHaveAttribute('data-p', '2');
  await expect(card(page, 'Wedge')).toHaveAttribute('data-p', '0');
  await expect(card(page, 'Farsight')).toHaveAttribute('data-p', '1');
  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), PRIORITY_KEY);
  expect(saved[weaponId('Prominent Edge')]).toBe(2);
  await page.click('.locations summary');
  await expect(page.locator('[data-location="world_energy_point_group11"]')).toHaveAttribute('aria-pressed', 'false');
});

test('announced weapons are marked and can be filtered out', async ({ page }) => {
  test.skip(announced.length === 0, 'no announced weapons in the data');
  await open(page);
  const cards = page.locator('.card.announced');
  await expect(cards).toHaveCount(announced.length);
  await expect(cards.first().locator('.tag-announced')).toHaveText('Announced');
  await expect(cards.first().locator('.tag-announced')).toHaveAttribute('title', /^Announced, not yet released/);
  // The card tooltip is the skill effect, or says the text is not out yet.
  await expect(cards.first()).toHaveAttribute('title', announced[0].effect ?? 'Skill text not published yet.');
  await page.click('#announced-filter button');
  await expect(cards).toHaveCount(0);
  await expect(page.locator('.card')).toHaveCount(data.weapons.length - announced.length);
});

test('rarity chips cover released weapons and the Announced chip covers announced ones', async ({ page }) => {
  test.skip(announced.length === 0, 'no announced weapons in the data');
  await open(page);
  for (const r of [6, 5, 4, 3]) await page.click(`[data-rarity="${r}"]`);
  await expect(page.locator('.card')).toHaveCount(announced.length);
  await expect(page.locator('.card:not(.announced)')).toHaveCount(0);

  // Skip shown then touches exactly the announced weapons.
  await page.click('[data-bulk="skip"]');
  await expect(page.locator('.confirm-list li')).toHaveCount(announced.length);
  await page.click('#confirm-cancel');

  const rarity = announced[0].rarity;
  await page.click(`[data-rarity="${rarity}"]`);
  const released = data.weapons.filter((w) => !w.announced && w.rarity === rarity).length;
  await expect(page.locator('.card')).toHaveCount(released + announced.length);
});

test('footer names the game data source and its date', async ({ page }) => {
  await open(page);
  await expect(page.locator('#source')).toContainText(`as of ${data.source.date}`);
  await expect(page.locator('#source a')).toHaveAttribute('href', new RegExp(data.source.commit));
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
  // Closing calls history.back(), which settles asynchronously.
  await expect.poll(() => page.evaluate(() => history.state?.detail)).toBeFalsy();

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
  const skipAll = Object.fromEntries(data.weapons.map((w) => [w.name, 0]));
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
  expect(count).toBeLessThan(data.weapons.length);
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
