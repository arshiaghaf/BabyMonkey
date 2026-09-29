import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { build } from 'esbuild';

const packageRoot = path.resolve(import.meta.dirname, '..');
const fixtureSource = path.join(packageRoot, 'test', 'fixtures', 'tty-lifecycle.ts');
const ptyDriver = path.join(packageRoot, 'test', 'fixtures', 'pty-driver.tcl');
let fixtureBuildDirectory = '';
let fixture = '';
const sensitiveEnvironmentNames = [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_API_KEY',
  'CF_API_TOKEN',
  'CF_API_KEY',
  'CLOUDFLARE_TOKEN',
  'WRANGLER_API_TOKEN',
] as const;

interface Scenario {
  pauseAfterHiddenPrompt?: boolean;
  questionTimeoutMs?: number;
  secretTimeoutMs?: number;
  sessionTimeoutMs?: number;
  existingConfig?: boolean;
  unsafeConfig?: boolean;
}

interface PtySession {
  child: ChildProcessWithoutNullStreams;
  directory: string;
  waitFor(text: string, count?: number): Promise<void>;
  finish(): Promise<{ code: number | null; output: string }>;
}

const activeChildren = new Set<ChildProcessWithoutNullStreams>();
const activeDirectories = new Set<string>();

beforeAll(async () => {
  fixtureBuildDirectory = await mkdtemp(path.join(os.tmpdir(), 'babymonkey-tty-build-'));
  await chmod(fixtureBuildDirectory, 0o700);
  fixture = path.join(fixtureBuildDirectory, 'tty-lifecycle.mjs');
  await build({
    absWorkingDir: packageRoot,
    alias: {
      'server-only': path.join(packageRoot, 'src', 'server-only.ts'),
    },
    bundle: true,
    entryPoints: [fixtureSource],
    format: 'esm',
    legalComments: 'none',
    minify: false,
    outfile: fixture,
    packages: 'bundle',
    platform: 'node',
    sourcemap: false,
    target: 'node22',
  });
});

afterAll(async () => {
  await rm(fixtureBuildDirectory, { recursive: true });
});

const killProcessGroup = (child: ChildProcessWithoutNullStreams): void => {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // The process group may already have exited between the checks.
  }
};

afterEach(async () => {
  for (const child of activeChildren) killProcessGroup(child);
  await Promise.all(
    [...activeDirectories].map((directory) => rm(directory, { recursive: true })),
  );
  activeChildren.clear();
  activeDirectories.clear();
});

const createSession = async (scenario: Scenario = {}): Promise<PtySession> => {
  if (process.platform !== 'darwin') {
    throw new Error('The maintenance CLI PTY suite requires its supported macOS runtime.');
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'babymonkey-tty-'));
  activeDirectories.add(directory);
  await chmod(directory, 0o700);
  await writeFile(path.join(directory, 'scenario.json'), JSON.stringify({
    pauseAfterHiddenPrompt: scenario.pauseAfterHiddenPrompt,
    questionTimeoutMs: scenario.questionTimeoutMs ?? 2_000,
    secretTimeoutMs: scenario.secretTimeoutMs ?? 2_000,
    sessionTimeoutMs: scenario.sessionTimeoutMs ?? 4_000,
  }), { mode: 0o600 });
  if (scenario.existingConfig) {
    await writeFile(path.join(directory, 'maintenance.json'), JSON.stringify({
      schemaVersion: 1,
      accountId: 'a'.repeat(32),
      databaseId: '12345678-1234-4123-8123-123456789abc',
      origin: 'https://app.owner.org',
    }), { mode: scenario.unsafeConfig ? 0o644 : 0o600 });
  }

  const environment = { ...process.env };
  for (const name of sensitiveEnvironmentNames) delete environment[name];
  const child = spawn('/usr/bin/expect', [
    ptyDriver,
    process.execPath,
    fixture,
  ], {
    cwd: directory,
    detached: true,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  activeChildren.add(child);
  let captured = '';
  const append = (chunk: Buffer): void => { captured += chunk.toString('utf8'); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);

  return {
    child,
    directory,
    async waitFor(text, count = 1): Promise<void> {
      const deadline = Date.now() + 2_000;
      while (captured.split(text).length - 1 < count) {
        if (child.exitCode !== null) throw new Error(`PTY exited before ${text}`);
        if (Date.now() >= deadline) throw new Error(`PTY did not reach ${text}`);
        await new Promise((resolve) => { setTimeout(resolve, 10); });
      }
    },
    async finish(): Promise<{ code: number | null; output: string }> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const code = await Promise.race([
          new Promise<number | null>((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', resolve);
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              killProcessGroup(child);
              reject(new Error('PTY process did not exit cleanly'));
            }, 3_000);
          }),
        ]);
        return { code, output: captured };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        activeChildren.delete(child);
        activeDirectories.delete(directory);
        await rm(directory, { recursive: true });
      }
    },
  };
};

const syntheticToken = (): string => randomBytes(32).toString('base64url');

const assertSecretAbsent = (output: string, secret: string): void => {
  if (output.includes(secret)) throw new Error('The synthetic token was echoed.');
};

const assertCleanSuccess = (
  result: { code: number | null; output: string },
  secret: string,
): void => {
  expect(result.code).toBe(0);
  expect(result.output).toContain('TTY_STATE_RESTORED');
  expect(result.output).toContain('TOKEN_VAULT_DESTROYED');
  assertSecretAbsent(result.output, secret);
};

describe.skipIf(process.platform !== 'darwin')('real attached-TTY lifecycle', () => {
  it('accepts immediate menu input after hidden token entry with existing configuration', async () => {
    const session = await createSession({ existingConfig: true });
    const secret = syntheticToken();
    await session.waitFor('Cloudflare D1 Write token: ');
    session.child.stdin.write(`${secret}\n8\n`);
    const result = await session.finish();
    assertCleanSuccess(result, secret);
    expect(result.output).toContain('Choose 1-8: ');
  });

  it('accepts delayed menu input after hidden token entry', async () => {
    const session = await createSession({ existingConfig: true });
    const secret = syntheticToken();
    await session.waitFor('Cloudflare D1 Write token: ');
    session.child.stdin.write(`${secret}\n`);
    await session.waitFor('Choose 1-8: ');
    await new Promise((resolve) => { setTimeout(resolve, 150); });
    session.child.stdin.write('8\n');
    assertCleanSuccess(await session.finish(), secret);
  });

  it('handles first-run configuration before hidden token and menu input', async () => {
    const session = await createSession();
    const secret = syntheticToken();
    await session.waitFor('Cloudflare account identifier: ');
    session.child.stdin.write(`${'b'.repeat(32)}\n`);
    await session.waitFor('Cloudflare D1 database identifier: ');
    session.child.stdin.write('87654321-4321-4321-8321-cba987654321\n');
    await session.waitFor('Trusted application HTTPS origin: ');
    session.child.stdin.write('https://app.owner.org\n');
    await session.waitFor('Save these nonsecret identifiers');
    session.child.stdin.write('y\n');
    await session.waitFor('Cloudflare D1 Write token: ');
    session.child.stdin.write(`${secret}\n`);
    await session.waitFor('Choose 1-8: ');
    session.child.stdin.write('8\n');
    const result = await session.finish();
    assertCleanSuccess(result, secret);
  });

  it('cancels hidden token entry without echo and restores the terminal', async () => {
    const session = await createSession({ existingConfig: true });
    const secretPrefix = syntheticToken();
    await session.waitFor('Cloudflare D1 Write token: ');
    session.child.stdin.write(`${secretPrefix}\u0003`);
    const result = await session.finish();
    expect(result.code).toBe(1);
    expect(result.output).toContain('maintenance session was cancelled');
    expect(result.output).toContain('TTY_STATE_RESTORED');
    assertSecretAbsent(result.output, secretPrefix);
  });

  it('restores the terminal after menu-question timeout', async () => {
    const session = await createSession({
      existingConfig: true,
      questionTimeoutMs: 150,
      sessionTimeoutMs: 2_000,
    });
    const secret = syntheticToken();
    await session.waitFor('Cloudflare D1 Write token: ');
    session.child.stdin.write(`${secret}\n`);
    await session.waitFor('Choose 1-8: ');
    const result = await session.finish();
    expect(result.code).toBe(1);
    expect(result.output).toContain('bounded maintenance session timed out');
    expect(result.output).toContain('TTY_STATE_RESTORED');
    assertSecretAbsent(result.output, secret);
  });

  it('restores the terminal after the overall session timeout', async () => {
    const session = await createSession({
      existingConfig: true,
      questionTimeoutMs: 2_000,
      sessionTimeoutMs: 150,
    });
    const secret = syntheticToken();
    await session.waitFor('Cloudflare D1 Write token: ');
    session.child.stdin.write(`${secret}\n`);
    await session.waitFor('Choose 1-8: ');
    const result = await session.finish();
    expect(result.code).toBe(1);
    expect(result.output).toContain('maintenance session was cancelled');
    expect(result.output).toContain('TTY_STATE_RESTORED');
    assertSecretAbsent(result.output, secret);
  });

  it('restores the terminal after hidden-token timeout', async () => {
    const session = await createSession({
      existingConfig: true,
      secretTimeoutMs: 150,
      sessionTimeoutMs: 2_000,
    });
    await session.waitFor('Cloudflare D1 Write token: ');
    const result = await session.finish();
    expect(result.code).toBe(1);
    expect(result.output).toContain('bounded maintenance session timed out');
    expect(result.output).toContain('TTY_STATE_RESTORED');
  });

  it('restores the terminal after a menu action failure', async () => {
    const session = await createSession({ existingConfig: true });
    const secret = syntheticToken();
    await session.waitFor('Cloudflare D1 Write token: ');
    session.child.stdin.write(`${secret}\n`);
    await session.waitFor('Choose 1-8: ');
    session.child.stdin.write('99\n');
    const result = await session.finish();
    expect(result.code).toBe(1);
    expect(result.output).toContain('maintenance session was cancelled');
    expect(result.output).toContain('TTY_STATE_RESTORED');
    assertSecretAbsent(result.output, secret);
  });

  it('restores the terminal after a termination signal at the menu', async () => {
    const session = await createSession({ existingConfig: true });
    const secret = syntheticToken();
    await session.waitFor('Cloudflare D1 Write token: ');
    session.child.stdin.write(`${secret}\n`);
    await session.waitFor('Choose 1-8: ');
    session.child.stdin.write('\u001c');
    const result = await session.finish();
    expect(result.code).toBe(1);
    expect(result.output).toContain('maintenance session was cancelled');
    expect(result.output).toContain('TTY_STATE_RESTORED');
    assertSecretAbsent(result.output, secret);
  });

  it('restores the terminal and releases the lock after initialization failure', async () => {
    const session = await createSession({ existingConfig: true, unsafeConfig: true });
    const result = await session.finish();
    expect(result.code).toBe(1);
    expect(result.output).toContain('local maintenance file permissions are unsafe');
    expect(result.output).toContain('TTY_STATE_RESTORED');
  });

  it('writes only owner-readable nonsecret configuration', async () => {
    const session = await createSession();
    const secret = syntheticToken();
    await session.waitFor('Cloudflare account identifier: ');
    session.child.stdin.write(`${'c'.repeat(32)}\n`);
    await session.waitFor('Cloudflare D1 database identifier: ');
    session.child.stdin.write('abcdef12-3456-4456-8456-abcdef123456\n');
    await session.waitFor('Trusted application HTTPS origin: ');
    session.child.stdin.write('https://app.owner.org\n');
    await session.waitFor('Save these nonsecret identifiers');
    session.child.stdin.write('y\n');
    await session.waitFor('Cloudflare D1 Write token: ');
    session.child.stdin.write(`${secret}\n8\n`);
    const configPath = path.join(session.directory, 'maintenance.json');
    const contents = await readFile(configPath, 'utf8');
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    assertSecretAbsent(contents, secret);
    const result = await session.finish();
    assertCleanSuccess(result, secret);
  });
});
