import { expect, test } from '@playwright/test';

const states = [
  ['Ready', 'ready'],
  ['Pending', 'pending'],
  ['Confirmed', 'confirmed'],
  ['Cooldown', 'cooldown'],
  ['Failure', 'definitiveFailure'],
  ['Ambiguous', 'ambiguous'],
] as const;

const targetPhoneViewports = [
  { width: 402, height: 874 },
  { width: 440, height: 956 },
] as const;

const artworkPaths = [
  '/__preview-assets/monkey/ready-monkey.png',
  '/__preview-assets/monkey/pending-monkey.png',
  '/__preview-assets/monkey/confirmed-monkey.png',
  '/__preview-assets/monkey/cooldown-monkey.png',
  '/__preview-assets/monkey/definitive-failure-monkey.png',
  '/__preview-assets/monkey/ambiguous-outcome-monkey.png',
] as const;

test('restores the local state chooser after it is hidden', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await page.getByRole('button', { name: 'Hide preview controls' }).click();
  await expect(page.getByTestId('local-preview-controls')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show preview controls' }).click();
  await expect(page.getByTestId('local-preview-controls')).toBeVisible();
  await expect(page.getByText('No notification is sent.')).toBeVisible();
});

test('previews the public authentication states without external work', async ({ page }) => {
  const transitionRequests: string[] = [];
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  page.on('request', (request) => {
    if (['fetch', 'xhr'].includes(request.resourceType())) {
      transitionRequests.push(request.url());
    }
  });

  await page.getByRole('button', { name: 'Auth ready' }).click();
  await expect(page.locator('[data-view="public-auth-shell"]')).toHaveAttribute(
    'data-auth-state',
    'ready',
  );
  await expect(page.getByRole('heading', {
    name: 'This little corner has just one person in mind.',
  })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText(
    'Let’s make sure it’s really you.',
  );

  const action = page.getByRole('button', { name: 'Verify' });
  await expect(action).toBeEnabled();
  await action.click();
  await expect(page.locator('[data-view="public-auth-shell"]')).toHaveAttribute(
    'data-auth-state',
    'working',
  );
  await expect(page.getByRole('status')).toHaveText('Just a moment…');
  await expect(action).toBeDisabled();

  await page.getByRole('button', { name: 'Auth failure' }).click();
  await expect(page.locator('[data-view="public-auth-shell"]')).toHaveAttribute(
    'data-auth-state',
    'recoverableFailure',
  );
  await expect(page.getByRole('status')).toHaveText(
    'That didn’t work. Let’s try again.',
  );
  await expect(action).toBeEnabled();
  expect(transitionRequests).toEqual([]);
});

test('gives the public action native focus and a reduced-motion equivalent', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Auth ready' }).click();
  await page.getByRole('button', { name: 'Hide preview controls' }).click();

  const action = page.getByRole('button', { name: 'Verify' });
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(action).toBeFocused();
  const focusAndMotion = await page.evaluate(() => {
    const actionElement = document.querySelector<HTMLElement>(
      '[data-view="public-auth-shell"] button',
    )!;
    const statusElement = document.querySelector<HTMLElement>(
      '[data-view="public-auth-shell"] [role="status"] > span',
    )!;
    const actionStyles = getComputedStyle(actionElement);
    const statusStyles = getComputedStyle(statusElement);
    return {
      animationName: statusStyles.animationName,
      minHeight: actionStyles.minHeight,
      outlineStyle: actionStyles.outlineStyle,
      outlineWidth: actionStyles.outlineWidth,
    };
  });

  expect(focusAndMotion.animationName).toBe('none');
  expect(Number.parseFloat(focusAndMotion.minHeight)).toBeGreaterThanOrEqual(44);
  expect(focusAndMotion.outlineStyle).toBe('solid');
  expect(focusAndMotion.outlineWidth).toBe('3px');

  await page.keyboard.press('Enter');
  await expect(page.locator('[data-view="public-auth-shell"]')).toHaveAttribute(
    'data-auth-state',
    'working',
  );
});

test('warms every state asset on direct entry without preload warnings', async ({ page }) => {
  const finishedArtwork = new Set<string>();
  const imageRequests: string[] = [];
  const preloadWarnings: string[] = [];
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (artworkPaths.includes(pathname as (typeof artworkPaths)[number])) {
      imageRequests.push(pathname);
    }
  });
  page.on('console', (message) => {
    if (
      message.type() === 'warning' &&
      message.text().includes('preloaded using link preload but not used')
    ) {
      preloadWarnings.push(message.text());
    }
  });
  page.on('requestfinished', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (artworkPaths.includes(pathname as (typeof artworkPaths)[number])) {
      finishedArtwork.add(pathname);
    }
  });

  await page.goto('/');

  await expect(page.locator('[data-view="experience"]')).toHaveAttribute('data-state', 'ready');
  await expect.poll(() => finishedArtwork.size).toBe(artworkPaths.length);
  expect(new Set(imageRequests)).toEqual(new Set(artworkPaths));
  await expect(page.locator('link[rel="preload"][as="image"]')).toHaveCount(1);
  await expect(page.locator('link[rel="preload"][as="image"]')).toHaveAttribute(
    'href',
    '/__preview-assets/monkey/ready-monkey.png',
  );
  expect(preloadWarnings).toEqual([]);
});

test('renders all six states with one fixed monkey control and no external calls', async ({ page }) => {
  const finishedArtwork = new Set<string>();
  const requests: string[] = [];
  const transitionRequests: string[] = [];
  let transitionsStarted = false;
  page.on('request', (request) => {
    requests.push(request.url());
    if (
      transitionsStarted &&
      ['fetch', 'image', 'xhr'].includes(request.resourceType())
    ) {
      transitionRequests.push(request.url());
    }
  });
  page.on('requestfinished', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (artworkPaths.includes(pathname as (typeof artworkPaths)[number])) {
      finishedArtwork.add(pathname);
    }
  });

  await page.goto('/');
  const pageOrigin = new URL(page.url()).origin;
  await expect.poll(() => finishedArtwork.size).toBe(artworkPaths.length);
  await expect(page).toHaveTitle('Baby Monkey');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    'href',
    '/apple-touch-icon.png',
  );
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    'sizes',
    '180x180',
  );
  transitionsStarted = true;
  for (const [index, [label, state]] of states.entries()) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator('[data-state]')).toHaveAttribute('data-state', state);
    const monkeyControlName =
      state === 'pending'
        ? 'Reveal whether the little monkey was sent'
        : 'Ask the recipient to reach out gently';
    await expect(
      page.getByRole('button', { name: monkeyControlName }),
    ).toHaveCount(1);
    await expect(page.locator('[data-artwork-layer="current"]')).toHaveAttribute(
      'data-artwork-state',
      state,
    );
    await expect(page.locator('[data-artwork-layer="current"]')).toHaveAttribute(
      'alt',
      '',
    );

    if (index > 0) {
      await expect(page.locator('[data-artwork-layer="departing"]')).toHaveCount(1);
    }

    await page.waitForTimeout(220);
    await expect(page.locator('[data-artwork-layer="departing"]')).toHaveCount(0);
    await expect(page.locator('main img')).toHaveCount(1);
  }

  expect(requests.every((url) => new URL(url).origin === pageOrigin)).toBe(true);
  expect(requests.some((url) => new URL(url).pathname.startsWith('/api/'))).toBe(false);
  expect(transitionRequests).toEqual([]);
});

test('reveals a settled pending result on a second monkey tap', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const transitionRequests: string[] = [];
  page.on('request', (request) => {
    if (['fetch', 'xhr'].includes(request.resourceType())) {
      transitionRequests.push(request.url());
    }
  });

  await page.getByRole('button', { name: 'Ready', exact: true }).click();
  await expect(page.locator('[data-state]')).toHaveAttribute('data-state', 'ready');
  await page
    .getByRole('button', { name: 'Ask the recipient to reach out gently' })
    .click();
  await expect(page.locator('[data-state]')).toHaveAttribute('data-state', 'pending');
  await expect(page.getByText('Tap the little monkey again.')).toBeVisible();
  const revealResult = page.getByRole('button', {
    name: 'Reveal whether the little monkey was sent',
  });
  await expect(revealResult).toBeEnabled();
  await revealResult.click();
  await expect(page.locator('[data-state]')).toHaveAttribute('data-state', 'confirmed');
  await expect(page.getByText('Your little monkey was sent.')).toBeVisible();
  expect(transitionRequests).toEqual([]);
});

test('keeps recovery outcomes distinct before returning to pending', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await page.getByRole('button', { name: 'Failure', exact: true }).click();
  await page.getByRole('button', { name: 'Hide preview controls' }).click();
  await expect(page.getByText('Nothing was sent yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('[data-state]')).toHaveAttribute('data-state', 'pending');

  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Ambiguous', exact: true }).click();
  await page.getByRole('button', { name: 'Hide preview controls' }).click();
  await expect(
    page.getByText('Send a little friend after it, just to be sure.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Send a little friend' }).click();
  await expect(page.locator('[data-state]')).toHaveAttribute('data-state', 'pending');
});

test('crossfades state copy and artwork without animating the top header', async ({ page }) => {
  await page.setViewportSize({ width: 440, height: 956 });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Ready', exact: true }).click();
  await page.waitForTimeout(950);

  await page.getByRole('button', { name: 'Pending', exact: true }).click();
  await expect(page.locator('[data-state]')).toHaveAttribute('data-state', 'pending');

  const motion = await page.evaluate(() => {
    const readAnimation = (selector: string) => {
      const styles = getComputedStyle(document.querySelector<HTMLElement>(selector)!);
      return {
        duration: Number.parseFloat(styles.animationDuration),
        name: styles.animationName,
      };
    };

    return {
      currentArtwork: readAnimation('[data-artwork-layer="current"]'),
      departingArtwork: readAnimation('[data-artwork-layer="departing"]'),
      message: readAnimation('.state-message'),
      topHeader: readAnimation('.rosewater-header'),
    };
  });

  expect(motion.currentArtwork.name).toContain('artwork-fade-in');
  expect(motion.currentArtwork.duration).toBeCloseTo(0.2);
  expect(motion.departingArtwork.name).toContain('artwork-fade-out');
  expect(motion.departingArtwork.duration).toBeCloseTo(0.2);
  expect(motion.message.name).toContain('state-content-enter');
  expect(motion.message.duration).toBeCloseTo(0.4);
  expect(motion.topHeader.name).not.toContain('state-content-enter');

  await page.waitForTimeout(220);
  await expect(page.locator('[data-artwork-layer="departing"]')).toHaveCount(0);
  await expect(page.locator('[data-artwork-layer="current"]')).toHaveAttribute(
    'data-artwork-state',
    'pending',
  );
});

test('lets the confirmed petals linger after the artwork settles', async ({ page }) => {
  await page.setViewportSize({ width: 440, height: 956 });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Confirmed', exact: true }).click();

  const firstPetal = page.locator('.confirmation-petals span').first();
  const overlayLayer = await page.locator('.confirmation-petals').evaluate(
    (element) => getComputedStyle(element).zIndex,
  );
  const artworkLayer = await page
    .locator('[data-artwork-layer="current"]')
    .evaluate((element) => getComputedStyle(element).zIndex);
  expect(Number.parseInt(overlayLayer, 10)).toBeGreaterThan(
    Number.parseInt(artworkLayer, 10),
  );
  const duration = await firstPetal.evaluate(
    (element) => getComputedStyle(element).animationDuration,
  );
  expect(Number.parseFloat(duration)).toBeCloseTo(2);

  await page.waitForTimeout(700);
  const lingeringOpacity = await firstPetal.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).opacity),
  );
  expect(lingeringOpacity).toBeGreaterThan(0.6);
});

test('uses one shared visual treatment for both recovery actions', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  const recoveryStyle = async () =>
    page.locator('.recovery-control').evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
        borderRadius: style.borderRadius,
        boxShadow: style.boxShadow,
        color: style.color,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        minHeight: style.minHeight,
        minWidth: style.minWidth,
      };
    });

  await page.getByRole('button', { name: 'Failure', exact: true }).click();
  const definitiveStyle = await recoveryStyle();
  await expect(page.locator('.recovery-control')).toHaveAttribute(
    'class',
    'recovery-control',
  );

  await page.getByRole('button', { name: 'Ambiguous', exact: true }).click();
  await expect(page.locator('.recovery-control')).toHaveAttribute(
    'class',
    'recovery-control',
  );
  expect(await recoveryStyle()).toEqual(definitiveStyle);
});

test('supports keyboard focus, Enter, and Space', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const monkey = page.getByRole('button', { name: 'Ask the recipient to reach out gently' });

  await page.getByRole('button', { name: 'Pending', exact: true }).click();
  await expect(page.locator('[data-state]')).toHaveAttribute('data-state', 'pending');
  await page.getByRole('button', { name: 'Ready', exact: true }).click();
  await expect(page.locator('[data-state]')).toHaveAttribute('data-state', 'ready');
  await page.getByRole('button', { name: 'Hide preview controls' }).click();
  for (let index = 0; index < 4 && !(await monkey.evaluate((element) => document.activeElement === element)); index += 1) {
    await page.keyboard.press('Tab');
  }
  await expect(monkey).toBeFocused();
  const focusStyle = await monkey.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outlineColor: style.outlineColor,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });
  expect(focusStyle).toEqual({
    outlineColor: 'rgb(123, 41, 79)',
    outlineStyle: 'solid',
    outlineWidth: '3px',
  });
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-state]')).toHaveAttribute('data-state', 'pending');
  await expect(page.getByText('Tap the little monkey again.')).toBeVisible();
  await page.keyboard.press('Space');
  await expect(page.locator('[data-state]')).toHaveAttribute('data-state', 'confirmed');

  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Pending', exact: true }).click();
  await expect(page.locator('[data-state]')).toHaveAttribute('data-state', 'pending');
  await page.getByRole('button', { name: 'Ready', exact: true }).click();
  await expect(page.locator('[data-state]')).toHaveAttribute('data-state', 'ready');
  await page.getByRole('button', { name: 'Hide preview controls' }).click();
  for (let index = 0; index < 4 && !(await monkey.evaluate((element) => document.activeElement === element)); index += 1) {
    await page.keyboard.press('Tab');
  }
  await page.keyboard.press('Space');
  await expect(page.locator('[data-state]')).toHaveAttribute('data-state', 'pending');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-state]')).toHaveAttribute('data-state', 'confirmed');
});

test('collapses nonessential motion when reduced motion is requested', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Confirmed', exact: true }).click();
  await expect(page.locator('[data-state]')).toHaveAttribute('data-state', 'confirmed');

  const petalAnimationDuration = await page
    .locator('.confirmation-petals span')
    .first()
    .evaluate((element) => getComputedStyle(element).animationDuration);
  const controlTransitionDuration = await page
    .locator('.monkey-control')
    .evaluate((element) => getComputedStyle(element).transitionDuration);

  expect(Number.parseFloat(petalAnimationDuration)).toBe(0);
  expect(Number.parseFloat(controlTransitionDuration)).toBe(0);

  await page.getByRole('button', { name: 'Cooldown', exact: true }).click();
  const reducedStateMotion = await page.evaluate(() => ({
    artwork: getComputedStyle(
      document.querySelector<HTMLElement>('[data-artwork-layer="current"]')!,
    ).animationDuration,
    message: getComputedStyle(
      document.querySelector<HTMLElement>('.state-message')!,
    ).animationDuration,
  }));
  expect(Number.parseFloat(reducedStateMotion.artwork)).toBe(0);
  expect(Number.parseFloat(reducedStateMotion.message)).toBe(0);

  await expect(page.locator('[data-state]')).toHaveAttribute('data-state', 'cooldown');
  const mainEntranceDuration = await page
    .locator('[data-view="experience"] > .rosewater-stage')
    .evaluate((element) => getComputedStyle(element).animationDuration);
  expect(Number.parseFloat(mainEntranceDuration)).toBe(0);
});

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 664 },
  { width: 390, height: 844 },
  { width: 402, height: 874 },
  { width: 430, height: 932 },
  { width: 440, height: 956 },
  { width: 1440, height: 900 },
]) {
  test(`fits ready artwork at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Ready', exact: true }).click();
    await expect(page.locator('[data-state]')).toHaveAttribute('data-state', 'ready');
    await page.getByRole('button', { name: 'Hide preview controls' }).click();

    const layout = await page.evaluate(() => {
      const image = document.querySelector<HTMLImageElement>('main img');
      const hint = document.querySelector<HTMLElement>('.interaction-hint');
      const rect = image?.getBoundingClientRect();
      const hintRect = hint?.getBoundingClientRect();
      return {
        clientWidth: document.documentElement.clientWidth,
        hintRect: hintRect && {
          bottom: hintRect.bottom,
          left: hintRect.left,
          right: hintRect.right,
          top: hintRect.top,
        },
        naturalHeight: image?.naturalHeight,
        naturalWidth: image?.naturalWidth,
        rect: rect && {
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          top: rect.top,
        },
        scrollWidth: document.documentElement.scrollWidth,
      };
    });

    expect(layout.scrollWidth).toBe(layout.clientWidth);
    expect(layout.rect).not.toBeNull();
    expect(layout.naturalWidth).toBeGreaterThanOrEqual(
      (layout.rect!.right - layout.rect!.left) * 2,
    );
    expect(layout.naturalHeight).toBe(layout.naturalWidth);
    expect(layout.rect!.left).toBeGreaterThanOrEqual(0);
    expect(layout.rect!.right).toBeLessThanOrEqual(viewport.width);
    expect(layout.rect!.top).toBeGreaterThanOrEqual(0);
    expect(layout.rect!.bottom).toBeLessThanOrEqual(viewport.height);
    expect(layout.hintRect).not.toBeNull();
    expect(layout.hintRect!.left).toBeGreaterThanOrEqual(0);
    expect(layout.hintRect!.right).toBeLessThanOrEqual(viewport.width);
    expect(layout.hintRect!.top).toBeGreaterThanOrEqual(layout.rect!.bottom);
    expect(layout.hintRect!.bottom).toBeLessThanOrEqual(viewport.height);
  });
}

for (const viewport of targetPhoneViewports) {
  test(`keeps ready copy to two message lines at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Ready', exact: true }).click();
    await expect(page.locator('[data-state]')).toHaveAttribute('data-state', 'ready');
    await page.getByRole('button', { name: 'Hide preview controls' }).click();

    const readyCopy = await page.evaluate(() => {
      const countLines = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) return null;
        const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
        return Math.round(element.getBoundingClientRect().height / lineHeight);
      };

      return {
        hint: countLines('.interaction-hint'),
        hasSubtitle: document.querySelector('.state-message p') !== null,
        title: countLines('.state-message h1'),
        titleColor: getComputedStyle(
          document.querySelector<HTMLElement>('.state-message h1')!,
        ).color,
        titleWeight: getComputedStyle(
          document.querySelector<HTMLElement>('.state-message h1')!,
        ).fontWeight,
      };
    });

    expect(readyCopy).toEqual({
      hasSubtitle: false,
      hint: 1,
      title: 2,
      titleColor: 'rgb(74, 31, 53)',
      titleWeight: '500',
    });
  });
}

for (const viewport of targetPhoneViewports) {
  test(`shares exact title line spacing at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const metrics: Record<string, { lineCount: number; lineHeight: string }> = {};
    for (const stateLabel of ['Ready', 'Pending', 'Cooldown']) {
      await page.getByRole('button', { name: stateLabel, exact: true }).click();
      await expect(page.locator('[data-state]')).toBeVisible();
      metrics[stateLabel] = await page.locator('.state-message h1').evaluate((element) => {
        const style = getComputedStyle(element);
        const lineHeight = Number.parseFloat(style.lineHeight);
        return {
          lineCount: Math.round(element.getBoundingClientRect().height / lineHeight),
          lineHeight: style.lineHeight,
        };
      });
    }

    expect(metrics.Ready.lineCount).toBe(2);
    expect(metrics.Pending.lineCount).toBe(2);
    expect(metrics.Cooldown.lineCount).toBe(1);
    expect(
      new Set(Object.values(metrics).map(({ lineHeight }) => lineHeight)).size,
    ).toBe(1);
  });
}

for (const viewport of targetPhoneViewports) {
  test(`fits copy-heavy states at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    for (const stateLabel of ['Confirmed', 'Failure', 'Ambiguous']) {
      await page.getByRole('button', { name: stateLabel, exact: true }).click();
      await expect(page.locator('[data-state]')).toBeVisible();

      const layout = await page.evaluate(() => {
        const selectors = ['.state-message', '.monkey-control', '.recovery-control'];
        const bounds = selectors.flatMap((selector) =>
          Array.from(document.querySelectorAll<HTMLElement>(selector), (element) => {
            const rect = element.getBoundingClientRect();
            return {
              bottom: rect.bottom,
              left: rect.left,
              right: rect.right,
              top: rect.top,
            };
          }),
        );

        return {
          bounds,
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        };
      });

      expect(layout.scrollWidth).toBe(layout.clientWidth);
      expect(layout.bounds.length).toBeGreaterThanOrEqual(2);
      for (const bounds of layout.bounds) {
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(viewport.width);
        expect(bounds.top).toBeGreaterThanOrEqual(0);
        expect(bounds.bottom).toBeLessThanOrEqual(viewport.height);
      }
    }
  });
}
