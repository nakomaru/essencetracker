import { defineConfig } from '@playwright/test';

const PORT = 8765;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  use: {
    baseURL: `http://127.0.0.1:${PORT}/`,
    // The installed Chrome, so no Playwright browser download is needed.
    channel: 'chrome',
  },
  webServer: {
    command: `node tools/serve.js ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
  },
});
