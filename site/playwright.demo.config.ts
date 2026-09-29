import { defineConfig } from '@playwright/test';
import { ownedBrowserOutput } from './scripts/browser-output.mjs';
export default defineConfig({
  testDir: './e2e', testMatch: '**/demo.spec.ts', fullyParallel: false, retries: 0, reporter: 'line', timeout: 90_000,
  use: { baseURL: 'http://localhost:3000', browserName: 'chromium', colorScheme: 'light' },
  outputDir: ownedBrowserOutput('demo'),
});
