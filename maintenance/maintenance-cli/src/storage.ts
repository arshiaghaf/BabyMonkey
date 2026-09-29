import { validProductionOrigin } from '../../../site/trusted-origin.mjs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:fs';
import {
  chmod,
  mkdir,
  lstat,
  open,
  rename,
  unlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MaintenanceError } from './errors.ts';
import type { JournalEntry, JournalStore } from './types.ts';

const MAX_LOCAL_FILE_BYTES = 64 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export interface MaintenanceConfig {
  schemaVersion: 1;
  accountId: string;
  databaseId: string;
  origin: string;
}

export interface LocalPaths {
  configPath: string;
  journalPath: string;
  lockPath: string;
}

export const defaultLocalPaths = (): LocalPaths => ({
  configPath: path.join(os.homedir(), '.config', 'babymonkey', 'maintenance.json'),
  journalPath: path.join(os.homedir(), '.local', 'state', 'babymonkey', 'invitation-journal.json'),
  lockPath: path.join(os.homedir(), '.local', 'state', 'babymonkey', 'maintenance.lock'),
});

const ownUid = (): number => {
  if (typeof process.getuid !== 'function') {
    throw new MaintenanceError('configuration-permissions');
  }
  return process.getuid();
};

const safeDirectory = async (directory: string, create: boolean): Promise<boolean> => {
  let created = false;
  if (create) {
    try {
      await lstat(directory);
    } catch (error) {
      if (!(isNodeError(error) && error.code === 'ENOENT')) {
        throw new MaintenanceError('configuration-permissions');
      }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      created = true;
    }
  }
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if (!create && isNodeError(error) && error.code === 'ENOENT') return false;
    throw new MaintenanceError('configuration-permissions');
  }
  if (
    info.isSymbolicLink()
    || !info.isDirectory()
    || info.uid !== ownUid()
    || (info.mode & 0o777) !== 0o700
  ) {
    throw new MaintenanceError('configuration-permissions');
  }
  if (created) await chmod(directory, 0o700);
  return true;
};

const readSafeFile = async (filePath: string): Promise<string | null> => {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw new MaintenanceError('configuration-permissions');
  }
  try {
    const info = await handle.stat();
    if (
      !info.isFile()
      || info.uid !== ownUid()
      || (info.mode & 0o777) !== 0o600
      || info.size > MAX_LOCAL_FILE_BYTES
    ) {
      throw new MaintenanceError('configuration-permissions');
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
};

const writeSafeFile = async (filePath: string, contents: string): Promise<void> => {
  const directory = path.dirname(filePath);
  await safeDirectory(directory, true);
  await readSafeFile(filePath);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW,
      0o600,
    );
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filePath);
    await chmod(filePath, 0o600);
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw new MaintenanceError('configuration-permissions');
  }
};

const isNodeError = (error: unknown): error is NodeJS.ErrnoException => (
  error instanceof Error && 'code' in error
);

const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean => (
  Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

export const parseConfig = (value: unknown): MaintenanceConfig => {
  if (
    !isRecord(value)
    || !exactKeys(value, ['schemaVersion', 'accountId', 'databaseId', 'origin'])
    || value.schemaVersion !== 1
    || typeof value.accountId !== 'string'
    || !/^[0-9a-f]{32}$/.test(value.accountId)
    || typeof value.databaseId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.databaseId)
    || !validProductionOrigin(value.origin)
  ) {
    throw new MaintenanceError('configuration-invalid');
  }
  return {
    schemaVersion: 1,
    accountId: value.accountId,
    databaseId: value.databaseId,
    origin: value.origin,
  };
};

export const loadConfig = async (filePath: string): Promise<MaintenanceConfig | null> => {
  if (!await safeDirectory(path.dirname(filePath), false)) return null;
  const contents = await readSafeFile(filePath);
  if (contents === null) return null;
  try {
    return parseConfig(JSON.parse(contents));
  } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    throw new MaintenanceError('configuration-invalid');
  }
};

export const saveConfig = async (
  filePath: string,
  config: MaintenanceConfig,
): Promise<void> => writeSafeFile(filePath, `${JSON.stringify(config, null, 2)}\n`);

const parseJournalEntry = (value: unknown): JournalEntry => {
  if (
    !isRecord(value)
    || !exactKeys(value, [
      'invitationId', 'tokenHash', 'slot', 'purpose', 'createdAtMs',
      'expiresAtMs', 'state',
    ])
    || typeof value.invitationId !== 'string'
    || value.invitationId.length < 16
    || typeof value.tokenHash !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.tokenHash)
    || (value.slot !== 1 && value.slot !== 2)
    || (value.purpose !== 'initial' && value.purpose !== 'replacement')
    || typeof value.createdAtMs !== 'number'
    || !Number.isInteger(value.createdAtMs)
    || value.createdAtMs < 0
    || typeof value.expiresAtMs !== 'number'
    || !Number.isInteger(value.expiresAtMs)
    || value.expiresAtMs <= value.createdAtMs
    || (value.state !== 'pending'
      && value.state !== 'committed'
      && value.state !== 'presented')
  ) {
    throw new MaintenanceError('configuration-invalid');
  }
  return {
    invitationId: value.invitationId,
    tokenHash: value.tokenHash,
    slot: value.slot,
    purpose: value.purpose,
    createdAtMs: value.createdAtMs,
    expiresAtMs: value.expiresAtMs,
    state: value.state,
  };
};

export const createJournalStore = (filePath: string): JournalStore => {
  const read = async (): Promise<JournalEntry[]> => {
    if (!await safeDirectory(path.dirname(filePath), false)) return [];
    const contents = await readSafeFile(filePath);
    if (contents === null) return [];
    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch {
      throw new MaintenanceError('configuration-invalid');
    }
    if (
      !isRecord(value)
      || !exactKeys(value, ['schemaVersion', 'entries'])
      || value.schemaVersion !== 1
      || !Array.isArray(value.entries)
    ) {
      throw new MaintenanceError('configuration-invalid');
    }
    const entries = value.entries.map(parseJournalEntry);
    if (new Set(entries.map((entry) => entry.invitationId)).size !== entries.length) {
      throw new MaintenanceError('configuration-invalid');
    }
    return entries;
  };

  const write = async (entries: JournalEntry[]): Promise<void> => {
    await writeSafeFile(filePath, `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`);
  };

  return {
    list: read,
    async replace(entry): Promise<void> {
      const entries = (await read()).filter(
        (candidate) => candidate.invitationId !== entry.invitationId,
      );
      entries.push(entry);
      await write(entries);
    },
    async remove(invitationId): Promise<void> {
      const entries = await read();
      const remaining = entries.filter((entry) => entry.invitationId !== invitationId);
      if (remaining.length !== entries.length) await write(remaining);
    },
  };
};

const LOCK_READY_MARKER = 'babymonkey-lock-ready\n';
const LOCK_ACQUIRE_TIMEOUT_MS = 1_000;
const LOCK_RELEASE_TIMEOUT_MS = 1_000;
const LOCKF_TEMPFAIL = 75;

const ensureAdvisoryLockFile = async (filePath: string): Promise<void> => {
  if (await readSafeFile(filePath) !== null) return;
  let handle;
  try {
    handle = await open(
      filePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | NOFOLLOW,
      0o600,
    );
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      await readSafeFile(filePath);
      return;
    }
    throw new MaintenanceError('configuration-permissions');
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const startAdvisoryLockHolder = async (
  filePath: string,
): Promise<ChildProcessWithoutNullStreams> => new Promise((resolve, reject) => {
  const holder = spawn(
    '/usr/bin/lockf',
    ['-k', '-s', '-t', '0', filePath, '/bin/cat'],
    { env: {}, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  holder.stderr.resume();
  let output = '';
  let settled = false;
  const timer = setTimeout(() => {
    fail(new MaintenanceError('configuration-permissions'), true);
  }, LOCK_ACQUIRE_TIMEOUT_MS);

  const cleanup = (): void => {
    clearTimeout(timer);
    holder.off('error', onError);
    holder.off('exit', onExit);
    holder.stdin.off('error', onStdinError);
    holder.stdout.off('data', onData);
  };
  const fail = (error: MaintenanceError, terminate: boolean): void => {
    if (settled) return;
    settled = true;
    cleanup();
    if (terminate) holder.kill('SIGTERM');
    reject(error);
  };
  const onError = (): void => {
    fail(new MaintenanceError('configuration-permissions'), false);
  };
  const onExit = (code: number | null): void => {
    fail(
      new MaintenanceError(code === LOCKF_TEMPFAIL ? 'lock-held' : 'configuration-permissions'),
      false,
    );
  };
  const onStdinError = (): void => {
    fail(new MaintenanceError('configuration-permissions'), true);
  };
  const onData = (chunk: Buffer): void => {
    output += chunk.toString('utf8');
    if (output !== LOCK_READY_MARKER) return;
    settled = true;
    cleanup();
    resolve(holder);
  };

  holder.once('error', onError);
  holder.once('exit', onExit);
  holder.stdin.once('error', onStdinError);
  holder.stdout.on('data', onData);
  holder.stdin.write(LOCK_READY_MARKER);
});

interface LocalSessionLockOptions {
  onLost?: () => void;
}

export class LocalSessionLock {
  readonly filePath: string;
  readonly #onLost: () => void;
  #holder: ChildProcessWithoutNullStreams | null = null;

  constructor(filePath: string, options: LocalSessionLockOptions = {}) {
    this.filePath = filePath;
    this.#onLost = options.onLost ?? (() => undefined);
  }

  async acquire(): Promise<void> {
    const directory = path.dirname(this.filePath);
    await safeDirectory(directory, true);
    await ensureAdvisoryLockFile(this.filePath);
    const holder = await startAdvisoryLockHolder(this.filePath);
    holder.stdin.on('error', () => undefined);
    holder.stdout.on('error', () => undefined);
    this.#holder = holder;
    holder.once('exit', () => {
      if (this.#holder !== holder) return;
      this.#holder = null;
      this.#onLost();
    });
  }

  async release(): Promise<void> {
    const holder = this.#holder;
    if (holder === null) return;
    this.#holder = null;
    const exited = new Promise<void>((resolve) => {
      if (holder.exitCode !== null || holder.signalCode !== null) {
        resolve();
        return;
      }
      holder.once('exit', () => {
        resolve();
      });
    });
    holder.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => {
              reject(new MaintenanceError('configuration-permissions'));
            },
            LOCK_RELEASE_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      holder.kill('SIGKILL');
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
