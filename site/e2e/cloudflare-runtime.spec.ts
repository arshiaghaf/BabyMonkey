import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Response } from '@playwright/test';
import {
  expectDevelopmentStylesExcluded,
  expectInfrastructureValuesExcluded,
  expectInfrastructureValuesExcludedFromText,
  expectProtectedArtworkExcluded,
  expectProtectedContentExcluded,
  expectProtectedContentExcludedFromText,
  expectSourceMapsExcluded,
  forbiddenPublicArtworkPaths,
} from './production-artifact-assertions';

test('serves only the public shell before local Workers authorization', async ({
  baseURL,
  context,
  page,
  request,
}) => {
  const requests: Array<{ resourceType: string; url: string }> = [];
  const failedRequests: string[] = [];
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];

  page.on('request', (browserRequest) => {
    requests.push({
      resourceType: browserRequest.resourceType(),
      url: browserRequest.url(),
    });
  });
  page.on('requestfailed', (browserRequest) => {
    failedRequests.push(browserRequest.url() + ':' + browserRequest.failure()?.errorText);
  });
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  const documentResponse = await page.goto('/');
  expect(documentResponse?.headers()['cache-control']).toContain('no-store');
  await page.waitForLoadState('networkidle');

  await expect(page).toHaveTitle('Baby Monkey');
  await expect(page.locator('[data-view="public-auth-shell"]')).toBeVisible();
  await expect(page.getByRole('heading', {
    name: 'This little corner has just one person in mind.',
  })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText(
    'Let’s make sure it’s really you.',
  );

  const action = page.getByRole('button', { name: 'Verify' });
  await expect(action).toBeEnabled();
  const html = await page.content();
  expectProtectedContentExcludedFromText(html, 'rendered Workers HTML');
  expectInfrastructureValuesExcludedFromText(html, 'rendered Workers HTML');
  await expect(page.locator('[data-view="experience"]')).toHaveCount(0);
  await expect(page.locator('[data-state]')).toHaveCount(0);
  await expect(page.getByTestId('local-preview-controls')).toHaveCount(0);

  expect(await context.cookies()).toEqual([]);
  expect(await page.evaluate(() => ({
    cookie: document.cookie,
    localStorageLength: localStorage.length,
    sessionStorageLength: sessionStorage.length,
  }))).toEqual({
    cookie: '',
    localStorageLength: 0,
    sessionStorageLength: 0,
  });

  const expectedOrigin = new URL(baseURL!).origin;
  expect(requests.every(({ url }) => new URL(url).origin === expectedOrigin)).toBe(true);
  expect(requests.some(({ url }) => new URL(url).pathname.startsWith('/api/'))).toBe(false);
  expect(
    requests.some(({ url }) => new URL(url).pathname.startsWith('/assets/monkey/')),
  ).toBe(false);
  expect(
    requests.filter(({ resourceType }) => ['fetch', 'xhr'].includes(resourceType)),
  ).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);

  const prefetchResponse = await request.get('/', {
    headers: {
      RSC: '1',
      'Next-Router-Prefetch': '1',
    },
  });
  expect(prefetchResponse.ok()).toBe(true);
  const prefetchBody = await prefetchResponse.text();
  expectProtectedContentExcludedFromText(prefetchBody, 'Workers prefetch response');
  expectInfrastructureValuesExcludedFromText(prefetchBody, 'Workers prefetch response');

  for (const assetPath of forbiddenPublicArtworkPaths) {
    const assetResponse = await request.get(assetPath);
    expect(assetResponse.status(), assetPath).toBe(404);
  }
  const knownProtectedAsset = await request.get(
    '/media/6xP9jFbD2mQvL7aWrN4tYsHkC8eZuG1o',
  );
  const unknownProtectedAsset = await request.get(
    '/media/00000000000000000000000000000000',
  );
  expect({
    body: await knownProtectedAsset.text(),
    cacheControl: knownProtectedAsset.headers()['cache-control'],
    contentType: knownProtectedAsset.headers()['content-type'],
    status: knownProtectedAsset.status(),
  }).toEqual({
    body: await unknownProtectedAsset.text(),
    cacheControl: unknownProtectedAsset.headers()['cache-control'],
    contentType: unknownProtectedAsset.headers()['content-type'],
    status: unknownProtectedAsset.status(),
  });

  const forgedMutation = await request.post('/api/interaction', {
    headers: { origin: 'https://app.owner-domain.net', 'sec-fetch-site': 'same-origin', 'x-bm-csrf': 'A'.repeat(43), 'x-bm-signal-version': 'none', cookie: `__Host-bm-session=${'A'.repeat(43)}; __Host-bm-csrf=${'A'.repeat(43)}` },
    data: { attempt: 'A'.repeat(43) },
  });
  expect(forgedMutation.status()).not.toBe(200);
  expect(forgedMutation.headers()['cache-control']).toContain('no-store');
  expectProtectedContentExcludedFromText(await forgedMutation.text(), 'forged protected mutation');

  const privateSource = '/__bm_private/6xP9jFbD2mQvL7aWrN4tYsHkC8eZuG1o.png';
  const sourceHash = createHash('sha256')
    .update(readFileSync('protected-assets/monkey/ready-monkey.png'))
    .digest('hex');
  const knownPrivateId = '6xP9jFbD2mQvL7aWrN4tYsHkC8eZuG1o.png';
  const unknownPrivateId = '00000000000000000000000000000000.png';
  const encodedPrivateAttempts = [
    [`/%5F%5Fbm_private/${knownPrivateId}`, `/%5F%5Fbm_private/${unknownPrivateId}`],
    [`/__bm_private%2F${knownPrivateId}`, `/__bm_private%2F${unknownPrivateId}`],
    [`/%2F__bm_private/${knownPrivateId}`, `/%2F__bm_private/${unknownPrivateId}`],
  ];
  for (const [knownPath, unknownPath] of encodedPrivateAttempts) {
    const [knownResponse, unknownResponse] = await Promise.all([
      request.get(knownPath),
      request.get(unknownPath),
    ]);
    const knownBody = await knownResponse.body();
    const unknownBody = await unknownResponse.body();
    expect({
      body: new TextDecoder().decode(knownBody),
      cacheControl: knownResponse.headers()['cache-control'],
      contentType: knownResponse.headers()['content-type'],
      status: knownResponse.status(),
    }, knownPath).toEqual({
      body: new TextDecoder().decode(unknownBody),
      cacheControl: unknownResponse.headers()['cache-control'],
      contentType: unknownResponse.headers()['content-type'],
      status: unknownResponse.status(),
    });
    expect(knownResponse.status(), knownPath).toBe(404);
    expect(knownResponse.headers()['cache-control'], knownPath).toContain('no-store');
    expect(createHash('sha256').update(knownBody).digest('hex'), knownPath)
      .not.toBe(sourceHash);
  }
  const optimizerAttempts = [
    `/_next/image?url=${encodeURIComponent(privateSource)}&w=640&q=75`,
    `/_next/image?url=${encodeURIComponent(encodeURIComponent(privateSource))}&w=640&q=75`,
    `/_next/image?url=${encodeURIComponent('/__bm_private/00000000000000000000000000000000.png')}&w=640&q=75`,
    `/%5Fnext/image?url=${encodeURIComponent(privateSource)}&w=640&q=75`,
  ];
  for (const optimizerPath of optimizerAttempts) {
    const response = await request.get(optimizerPath);
    const body = await response.body();
    expect(response.status(), optimizerPath).toBe(404);
    expect(response.headers()['cache-control'], optimizerPath).toContain('no-store');
    expect(new TextDecoder().decode(body), optimizerPath).toBe('Not found');
    expect(createHash('sha256').update(body).digest('hex'), optimizerPath)
      .not.toBe(sourceHash);
  }
});

test('excludes protected UI and source maps from OpenNext artifacts', async () => {
  await expectProtectedArtworkExcluded('.open-next/assets');
  await expectDevelopmentStylesExcluded('.open-next/assets/_next/static');
  await expectInfrastructureValuesExcluded('.open-next/assets/_next/static');
  await expectProtectedContentExcluded('.open-next/assets/_next/static');
  await expectSourceMapsExcluded('.open-next/assets/_next/static');
});

test('completes local cancellation, registration, authentication, and sign-out with a virtual passkey', async ({
  browser,
  baseURL,
  page,
  request,
}) => {
  const invitation = process.env.BABYMONKEY_TEST_INVITATION;
  expect(invitation).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  const invitationRequests: Array<{ method: string; url: string }> = [];
  const identityResponseCacheHeaders: string[] = [];
  page.on('request', (request) => {
    invitationRequests.push({ method: request.method(), url: request.url() });
  });
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.startsWith('/api/identity/')) {
      identityResponseCacheHeaders.push(response.headers()['cache-control'] ?? '');
    }
  });

  const unauthenticatedArtwork = await request.get(
    '/media/6xP9jFbD2mQvL7aWrN4tYsHkC8eZuG1o',
  );
  expect(unauthenticatedArtwork.status()).toBe(404);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const client = await page.context().newCDPSession(page);
  await client.send('WebAuthn.enable');
  const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: false,
    },
  });

  await page.goto(`/invite#${invitation}`);
  await page.waitForURL('/');
  expect(page.url()).not.toContain(invitation!);
  expect(invitationRequests.filter(({ url }) => (
    new URL(url).pathname === '/api/identity/invitation'
  ))).toHaveLength(1);
  expect(invitationRequests.every(({ url }) => !url.includes(invitation!))).toBe(true);
  await expect(page.getByRole('button', { name: 'Verify' })).toBeEnabled();

  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.locator('[data-auth-state="working"]')).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-auth-state="ready"]')).toBeVisible();

  await client.send('WebAuthn.setAutomaticPresenceSimulation', {
    authenticatorId,
    enabled: true,
  });
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.locator('[data-view="experience"]')).toHaveAttribute('data-state', 'ready');
  let releaseScripts!: () => void;
  const scriptsReleased = new Promise<void>((resolve) => { releaseScripts = resolve; });
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() === 'script') await scriptsReleased;
    await route.continue();
  });
  let authorizedDocument: Response | null = null;
  try {
    authorizedDocument = await page.reload({ waitUntil: 'commit' });
    await expect(page.locator('[data-view="experience"]')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByRole('button', {
      name: 'Ask the recipient to reach out gently',
    })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeDisabled();
    expect(invitationRequests.filter(({ url }) => new URL(url).pathname === '/api/interaction')).toHaveLength(0);
  } finally {
    releaseScripts();
    await page.unrouteAll({ behavior: 'wait' });
  }
  await expect(page.getByRole('button', {
    name: 'Ask the recipient to reach out gently',
  })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeEnabled();
  expect(authorizedDocument?.headers()['cache-control']).toContain('no-store');
  await expect(page.locator('[data-view="experience"]')).toHaveAttribute('data-state', 'ready');
  expect(identityResponseCacheHeaders.length).toBeGreaterThanOrEqual(4);
  expect(identityResponseCacheHeaders.every((value) => value.includes('no-store'))).toBe(true);
  expect((await page.context().cookies()).map(({ name }) => name)).toEqual(
    expect.arrayContaining(['__Host-bm-session', '__Host-bm-csrf']),
  );

  const protectedImage = page.locator('img').first();
  await expect(protectedImage).toBeVisible();
  expect(await protectedImage.getAttribute('src')).toMatch(/^\/media\//u);
  const internalAssetStatus = await page.evaluate(async () => (
    await fetch('/__bm_private/6xP9jFbD2mQvL7aWrN4tYsHkC8eZuG1o.png')
  ).status);
  expect(internalAssetStatus).toBe(404);

  await page.context().clearCookies();
  await page.reload();
  await expect(page.locator('[data-auth-state="ready"]')).toBeVisible();
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.locator('[data-view="experience"]')).toHaveAttribute('data-state', 'ready');

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const monkeyAction = page.getByRole('button', {
    name: 'Ask the recipient to reach out gently',
  });
  await expect(monkeyAction).toBeEnabled();
  await expect(page.locator('.rosewater-header')).toHaveCSS('animation-duration', '0.78s');
  await expect(page.locator('.rosewater-stage')).toHaveCSS('animation-duration', '0.9s');
  const mobilePresentation = await page.locator('[data-view="experience"]').evaluate((view) => {
    const heading = view.querySelector<HTMLElement>('h1')!;
    return {
      headingLineHeight: Number.parseFloat(getComputedStyle(heading).lineHeight),
    };
  });
  expect(mobilePresentation.headingLineHeight).toBeCloseTo(40.04, 1);

  await page.setViewportSize({ width: 1440, height: 900 });
  const desktopPresentation = await page.locator('[data-view="experience"]').evaluate((view) => {
    const heading = view.querySelector<HTMLElement>('h1')!;
    const image = view.querySelector<HTMLElement>('main img')!.getBoundingClientRect();
    const hint = view.querySelector<HTMLElement>('main p')!.getBoundingClientRect();
    return {
      headingLineHeight: Number.parseFloat(getComputedStyle(heading).lineHeight),
      hint: {
        bottom: hint.bottom,
        left: hint.left,
        right: hint.right,
        top: hint.top,
      },
      image: {
        bottom: image.bottom,
        left: image.left,
        right: image.right,
        top: image.top,
      },
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  expect(desktopPresentation.headingLineHeight).toBeCloseTo(49.4, 1);
  expect(desktopPresentation.scrollWidth).toBe(1440);
  expect(desktopPresentation.image.top).toBeGreaterThanOrEqual(0);
  expect(desktopPresentation.image.bottom).toBeLessThanOrEqual(900);
  expect(desktopPresentation.image.left).toBeGreaterThanOrEqual(0);
  expect(desktopPresentation.image.right).toBeLessThanOrEqual(1440);
  expect(desktopPresentation.hint.top).toBeGreaterThanOrEqual(
    desktopPresentation.image.bottom,
  );
  expect(desktopPresentation.hint.bottom).toBeLessThanOrEqual(900);
  expect(desktopPresentation.hint.left).toBeGreaterThanOrEqual(0);
  expect(desktopPresentation.hint.right).toBeLessThanOrEqual(1440);

  await page.setViewportSize({ width: 440, height: 956 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('[data-view="experience"]')).toBeVisible();
  await expect(page.locator('.rosewater-header')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.rosewater-stage')).toHaveCSS('animation-name', 'none');

  const interactionCount = () => invitationRequests.filter(({ url }) => (
    new URL(url).pathname === '/api/interaction'
  )).length;
  const beforeSignal = interactionCount();
  expect(beforeSignal).toBe(0);
  await page.getByRole('button', { name: 'Ask the recipient to reach out gently' }).click();
  await expect(page.getByText('Sending your little monkey…')).toBeVisible();
  const revealFailure = page.getByRole('button', {
    name: 'Reveal whether the little monkey was sent',
  });
  await expect(revealFailure).toBeEnabled();
  expect(interactionCount()).toBe(beforeSignal + 1);
  await revealFailure.click();
  await expect(page.getByText('Nothing was sent yet.')).toBeVisible();
  expect(interactionCount()).toBe(beforeSignal + 1);

  let loseFirstRetryResponse = true;
  await page.route('**/api/interaction', async (route) => {
    if (loseFirstRetryResponse) {
      loseFirstRetryResponse = false;
      await route.fetch();
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('button', {
    name: 'Reveal whether the little monkey was sent',
  })).toBeEnabled();
  expect(interactionCount()).toBe(beforeSignal + 3);
  await page.unroute('**/api/interaction');

  await page.route('**/api/identity/signout', async (route) => {
    await route.fetch();
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL('/');
  await expect(page.locator('[data-auth-state="ready"]')).toBeVisible();
  await page.unroute('**/api/identity/signout');

  await page.goBack();
  await expect(page.locator('[data-view="experience"]')).toHaveCount(0);
  await page.goto('/');
  await expect(page.locator('[data-auth-state="ready"]')).toBeVisible();
  const isolated = await browser.newContext({ baseURL, ignoreHTTPSErrors: true, proxy: { server: process.env.BABYMONKEY_TEST_PROXY! } });
  const unauthorizedRsc = await isolated.request.get('/', {
    headers: { RSC: '1', 'Next-Router-Prefetch': '1' },
  });
  expectProtectedContentExcludedFromText(
    await unauthorizedRsc.text(),
    'post-sign-out unauthorized RSC response',
  );
  await isolated.close();
  await page.screenshot({ path: '/tmp/babymonkey-production-public.png' });
  await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
});
