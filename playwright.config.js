import { defineConfig } from '@playwright/test';

const PORT = 8765;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  // Playwright's headless Chromium, installed by npm install. Installed Chrome (channel: 'chrome')
  // makes a failed Windows logon on every launch, and a parallel run trips account lockout.
  use: {
    baseURL: `http://127.0.0.1:${PORT}/`,
  },
  webServer: {
    command: `node tools/serve.js ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
  },
});
