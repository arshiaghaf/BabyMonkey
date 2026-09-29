import { test, expect, type Browser, type BrowserContext, type CDPSession } from '@playwright/test';
async function makeVirtualUser(browser: Browser): Promise<{ context: BrowserContext; page: Awaited<ReturnType<BrowserContext['newPage']>>; authenticatorId: string; client: CDPSession }> {
  const context = await browser.newContext({ baseURL: 'http://localhost:3000' });
  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  await client.send('WebAuthn.enable');
  const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: false,
  }});
  return { context, page, authenticatorId, client };
}
test('two synthetic users enroll independently and the fixed signal uses fake local delivery', async ({ browser }) => {
  const expectedResult = process.env.BABYMONKEY_TEST_OUTCOME === 'ambiguous' ? 'Your little monkey may already be on its way.' : process.env.BABYMONKEY_TEST_OUTCOME === 'definitive-failure' ? 'Nothing was sent yet.' : 'Your little monkey was sent.';
  const firstToken = process.env.BABYMONKEY_DEMO_INVITE_1;
  const secondToken = process.env.BABYMONKEY_DEMO_INVITE_2;
  expect(firstToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(secondToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const first = await makeVirtualUser(browser);
  const second = await makeVirtualUser(browser);
  let interactions = 0;
  let secondInteractions = 0;
  first.page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/interaction') interactions++; });
  second.page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/interaction') secondInteractions++; });
  try {
    const anonymous = await browser.newContext({ baseURL: 'http://localhost:3000' });
    const anonymousResponse = await anonymous.request.get('/');
    expect(await anonymousResponse.text()).not.toContain('No words needed. Send your little monkey.');
    expect((await anonymous.request.post('/api/interaction', { data: {} })).status()).not.toBe(200);
    expect((await anonymous.request.get('/media/6xP9jFbD2mQvL7aWrN4tYsHkC8eZuG1o')).status()).toBe(404);
    await anonymous.close();

    const enroll = async (user: typeof first, token: string, cancelFirst: boolean) => {
      await user.page.goto(`/invite#${token}`);
      await user.page.waitForURL('/');
      expect(user.page.url()).not.toContain(token);
      await expect(user.page.getByRole('button', { name: 'Verify' })).toBeEnabled();
      if (cancelFirst) {
        await user.page.getByRole('button', { name: 'Verify' }).click();
        await user.page.reload();
        await expect(user.page.getByRole('button', { name: 'Verify' })).toBeEnabled();
      }
      await user.client.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId: user.authenticatorId, enabled: true });
      await user.page.getByRole('button', { name: 'Verify' }).click();
      await expect(user.page.locator('[data-view="experience"]')).toHaveAttribute('data-state', 'ready');
      await user.page.reload();
      await expect(user.page.locator('[data-view="experience"]')).toHaveAttribute('data-state', 'ready');
    };
    await enroll(first, firstToken!, true);
    expect((await first.context.request.get('/media/6xP9jFbD2mQvL7aWrN4tYsHkC8eZuG1o')).status()).toBe(200);
    expect((await first.context.request.get('/__preview-assets/monkey/ready-monkey.png')).status()).toBe(404);
    const reused = await browser.newContext({ baseURL: 'http://localhost:3000' });
    const reusePage = await reused.newPage();
    await reusePage.goto(`/invite#${firstToken}`);
    await expect(reusePage.getByText('That didn’t work. Please use the private invitation again.')).toBeVisible();
    await reused.close();
    await enroll(second, secondToken!, false);

    expect(interactions).toBe(0);
    expect(secondInteractions).toBe(0);
    await first.page.getByRole('button', { name: 'Ask the recipient to reach out gently' }).click();
    await expect(first.page.getByRole('button', { name: 'Reveal whether the little monkey was sent' })).toBeEnabled();
    const beforeReveal = interactions;
    await first.page.getByRole('button', { name: 'Reveal whether the little monkey was sent' }).click();
    await expect(first.page.getByText(expectedResult)).toBeVisible();
    expect(interactions).toBe(beforeReveal);

    await first.page.getByRole('button', { name: 'Sign out' }).click();
    await expect(first.page.getByRole('button', { name: 'Verify' })).toBeEnabled();
    await first.page.getByRole('button', { name: 'Verify' }).click();
    await expect(first.page.locator('[data-view="experience"]')).toBeVisible();
    await second.page.getByRole('button', { name: 'Ask the recipient to reach out gently' }).click();
    await expect(second.page.getByRole('button', { name: 'Reveal whether the little monkey was sent' })).toBeEnabled();
    await second.page.getByRole('button', { name: 'Reveal whether the little monkey was sent' }).click();
    await expect(second.page.getByText(expectedResult)).toBeVisible();
    expect(secondInteractions).toBe(1);
    await second.page.getByRole('button', { name: 'Sign out' }).click();
    await expect(second.page.getByRole('button', { name: 'Verify' })).toBeEnabled();
    await second.page.getByRole('button', { name: 'Verify' }).click();
    await expect(second.page.locator('[data-view="experience"]')).toBeVisible();
  } finally { await Promise.allSettled([first.context.close(), second.context.close()]); }
});
