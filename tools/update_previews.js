// Regenerates the README screenshots in images/. Run with: npm run previews
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { serve } from './serve.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8766;
const PAGE_URL = `http://127.0.0.1:${PORT}/`;
const data = JSON.parse(readFileSync(`${ROOT}data.json`, 'utf8'));
const STARRED = ['Amaranthine Tassel', 'Phantom Pain'].map((name) => data.weapons.find((w) => w.name === name).id);

const server = await serve(PORT);
try {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  await page.goto(PAGE_URL);
  await page.locator('.card').first().waitFor();
  for (const id of STARRED) await page.click(`.card[data-id="${id}"]`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: `${ROOT}images/preview_main.png` });
  await page.locator('.result').first().click();
  await page.screenshot({ path: `${ROOT}images/preview_detail.png` });
  await browser.close();
} finally {
  server.close();
}
