import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createJournalStore,
  loadConfig,
  LocalSessionLock,
  parseConfig,
  saveConfig,
} from '../src/storage.ts';

const temporary: string[] = [];

const tempDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'babymonkey-maintenance-test-'));
  temporary.push(directory);
  await chmod(directory, 0o700);
  return directory;
};

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('local nonsecret storage', () => {
  it('accepts only the exact nonsecret config shape and writes mode 600', async () => {
    const config = parseConfig({
      schemaVersion: 1,
      accountId: 'a'.repeat(32),
      databaseId: '12345678-1234-4123-8123-123456789abc',
      origin: 'https://app.owner.org',
    });
    expect(() => parseConfig({ ...config, token: 'not-allowed' })).toThrow(/invalid/);
    const directory = await tempDirectory();
    const file = path.join(directory, 'config.json');
    await saveConfig(file, config);
    expect(await loadConfig(file)).toEqual(config);
    const mode = (await import('node:fs/promises')).stat(file).then((value) => value.mode & 0o777);
    await expect(mode).resolves.toBe(0o600);
  });

  it.each(['https://127.0.0.1','https://[::1]','https://localhost','https://app..owner.net','https://app.example','https://app.invalid','https://app.test','https://app.local','https://app.owner.net/','https://app.owner.net:443','https://APP.owner.net'])('rejects unusable invitation origin %s before saving configuration', (origin) => {
    expect(() => parseConfig({schemaVersion:1, accountId:'a'.repeat(32),databaseId:'12345678-1234-4123-8123-123456789abc',origin})).toThrow(/invalid/);
  });

  it('rejects unsafe existing directory and file permissions', async () => {
    const directory = await tempDirectory();
    const file = path.join(directory, 'config.json');
    await writeFile(file, JSON.stringify({
      schemaVersion: 1,
      accountId: 'a'.repeat(32),
      databaseId: '12345678-1234-4123-8123-123456789abc',
      origin: 'https://app.owner.org',
    }), { mode: 0o644 });
    await expect(loadConfig(file)).rejects.toMatchObject({ code: 'configuration-permissions' });
    await chmod(file, 0o600);
    await chmod(directory, 0o755);
    await expect(loadConfig(file)).rejects.toMatchObject({ code: 'configuration-permissions' });
  });

  it('rejects a symlinked application directory', async () => {
    const parent = await tempDirectory();
    const target = await tempDirectory();
    const linked = path.join(parent, 'babymonkey');
    await symlink(target, linked, 'dir');
    await expect(loadConfig(path.join(linked, 'config.json'))).rejects.toMatchObject({
      code: 'configuration-permissions',
    });
  });

  it('persists only a hash-only recovery journal', async () => {
    const directory = await tempDirectory();
    const file = path.join(directory, 'journal.json');
    const journal = createJournalStore(file);
    await journal.replace({
      invitationId: 'synthetic-invitation-id',
      tokenHash: 'b'.repeat(64),
      slot: 1,
      purpose: 'initial',
      createdAtMs: 10,
      expiresAtMs: 20,
      state: 'pending',
    });
    const contents = await readFile(file, 'utf8');
    expect(contents).toContain('tokenHash');
    expect(contents).not.toContain('rawToken');
    expect(await journal.list()).toHaveLength(1);
    await journal.remove('synthetic-invitation-id');
    expect(await journal.list()).toEqual([]);
  });

  it('publishes and releases the session lock atomically', async () => {
    const directory = await tempDirectory();
    const lock = new LocalSessionLock(path.join(directory, 'maintenance.lock'));
    await lock.acquire();
    const competing = new LocalSessionLock(lock.filePath);
    await expect(competing.acquire()).rejects.toMatchObject({ code: 'lock-held' });
    await lock.release();
    await competing.acquire();
    await competing.release();
  });

  it('allows only one contender to recover a persisted crash-stale lock file', async () => {
    const directory = await tempDirectory();
    const filePath = path.join(directory, 'maintenance.lock');
    await writeFile(filePath, '{"pid":101,"createdAtMs":10}\n', { mode: 0o600 });
    const first = new LocalSessionLock(filePath);
    const second = new LocalSessionLock(filePath);
    const results = await Promise.allSettled([first.acquire(), second.acquire()]);
    const winnerIndex = results.findIndex((result) => result.status === 'fulfilled');
    const loserIndex = results.findIndex((result) => result.status === 'rejected');
    expect(winnerIndex).toBeGreaterThanOrEqual(0);
    expect(loserIndex).toBeGreaterThanOrEqual(0);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results[loserIndex]).toMatchObject({
      reason: { code: 'lock-held' },
    });

    const locks = [first, second];
    await locks[winnerIndex]?.release();
    await locks[loserIndex]?.acquire();
    await locks[loserIndex]?.release();
  });
});
