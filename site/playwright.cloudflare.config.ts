import { defineConfig } from '@playwright/test';
import { ownedBrowserOutput } from './scripts/browser-output.mjs';
if (!process.env.BABYMONKEY_TEST_PROXY) throw new Error('Use the owned production runtime runner.');
export default defineConfig({
  testDir: './e2e', testMatch: '**/cloudflare-runtime.spec.ts', fullyParallel: false, retries: 0, timeout: 90_000, reporter: 'line',
  outputDir: ownedBrowserOutput('production'),
  use: { baseURL: 'https://app.owner-domain.net', proxy: { server: process.env.BABYMONKEY_TEST_PROXY }, ignoreHTTPSErrors: true, browserName: 'chromium', colorScheme: 'light', viewport: {width:440,height:956}, screenshot: 'only-on-failure' },
});
