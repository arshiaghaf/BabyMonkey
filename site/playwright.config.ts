import { defineConfig } from '@playwright/test';
import { ownedBrowserOutput } from './scripts/browser-output.mjs';

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['**/production.spec.ts', '**/cloudflare-runtime.spec.ts', '**/demo.spec.ts'],
  outputDir: ownedBrowserOutput('preview'),
  fullyParallel: false,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:3000',
    browserName: 'chromium',
    colorScheme: 'light',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    reuseExistingServer: false,
    timeout: 60_000,
    url: 'http://127.0.0.1:3000',
  },
});
