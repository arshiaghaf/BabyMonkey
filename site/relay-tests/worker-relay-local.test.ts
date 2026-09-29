import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMTLSDeliveryBoundary } from '@/server/signal/mtls-delivery-boundary';

interface HarnessDescriptor {
  port: string;
  root_certificate: string;
  client_certificate: string;
  client_private_key: string;
}

const activeChildren = new Set<ReturnType<typeof spawn>>();

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForDescriptor(
  descriptorPath: string,
  childExit: Promise<{ code: number | null; output: string }>,
) {
  // A fresh isolated Go build cache may need longer than 10 seconds on hosted runners.
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    try {
      await access(descriptorPath);
      return;
    } catch {
      const earlyExit = await Promise.race([
        childExit.then((result) => ({ exited: true as const, result })),
        delay(10).then(() => ({ exited: false as const })),
      ]);
      if (earlyExit.exited) {
        throw new Error(`Go harness exited before readiness: ${earlyExit.result.code}\n${earlyExit.result.output}`);
      }
    }
  }
  throw new Error('Timed out waiting for local Go relay harness.');
}

function createSyntheticMTLSBinding(descriptor: HarnessDescriptor): Pick<Fetcher, 'fetch'> {
  return {
    async fetch(request: Request) {
      const requestURL = new URL(request.url);
      const requestBody = new Uint8Array(await request.arrayBuffer());
      return await new Promise<Response>((resolve, reject) => {
        const outgoing = https.request({
          hostname: '127.0.0.1',
          port: Number.parseInt(descriptor.port, 10),
          servername: requestURL.hostname,
          path: `${requestURL.pathname}${requestURL.search}`,
          method: request.method,
          headers: {
            ...Object.fromEntries(request.headers.entries()),
            host: requestURL.hostname,
            'accept-encoding': 'synthetic-transport-encoding',
            'cf-connecting-ip': 'synthetic-visitor-address',
            'cf-worker': 'synthetic-worker-metadata',
            'x-real-ip': 'synthetic-real-address',
            'x-trace': 'synthetic-trace-metadata',
          },
          ca: descriptor.root_certificate,
          cert: descriptor.client_certificate,
          key: descriptor.client_private_key,
          rejectUnauthorized: true,
          agent: false,
        }, (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.on('end', () => {
            resolve(new Response(Buffer.concat(chunks), {
              status: incoming.statusCode ?? 500,
              headers: incoming.headers as Record<string, string>,
            }));
          });
          incoming.on('error', reject);
        });
        const abort = () => outgoing.destroy(new DOMException('aborted', 'AbortError'));
        if (request.signal.aborted) abort();
        else request.signal.addEventListener('abort', abort, { once: true });
        outgoing.on('error', reject);
        outgoing.end(requestBody);
      });
    },
  } as Pick<Fetcher, 'fetch'>;
}

async function runMode(mode: string) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'babymonkey-relay-e2e-'));
  const descriptorPath = path.join(temporaryDirectory, 'descriptor.json');
  const goCache = process.env.BABYMONKEY_GO_CACHE
    ?? path.join(temporaryDirectory, 'go-cache');
  const child = spawn('go', [
    'test',
    '-run',
    '^TestWorkerAdapterHarness$',
    '-count=1',
    './internal/relay',
  ], {
    cwd: path.resolve(process.cwd(), '../relay'),
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      NODE_ENV: 'test',
      GOCACHE: goCache,
      GOENV: 'off',
      GOPROXY: 'off',
      GOSUMDB: 'off',
      GOTOOLCHAIN: 'local',
      BABYMONKEY_E2E_DESCRIPTOR: descriptorPath,
      BABYMONKEY_E2E_MODE: mode,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeChildren.add(child);
  let output = '';
  child.stdout?.on('data', (chunk) => { output += String(chunk); });
  child.stderr?.on('data', (chunk) => { output += String(chunk); });
  const childExit = new Promise<{ code: number | null; output: string }>((resolve) => {
    child.once('exit', (code) => {
      activeChildren.delete(child);
      resolve({ code, output });
    });
  });
  try {
    await waitForDescriptor(descriptorPath, childExit);
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as HarnessDescriptor;
    const boundary = createMTLSDeliveryBoundary(
      createSyntheticMTLSBinding(descriptor),
      `https://relay.invalid:${descriptor.port}`,
    );
    if (!boundary) throw new Error('Local relay origin was rejected.');
    const outcome = await boundary.deliver(new AbortController().signal);
    await writeFile(`${descriptorPath}.done`, '', { mode: 0o600 });
    const completed = await childExit;
    expect(completed.code, completed.output).toBe(0);
    expect(completed.output).not.toMatch(
      /BEGIN (?:CERTIFICATE|EC PRIVATE KEY)|telegram_destination|telegram_bot_token|fixed_message|replay_key/iu,
    );
    return outcome;
  } finally {
    if (child.exitCode === null) {
      try {
        await writeFile(`${descriptorPath}.done`, '', { mode: 0o600 });
      } catch {
        child.kill('SIGTERM');
      }
      await Promise.race([childExit, delay(2_000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

afterEach(() => {
  for (const child of activeChildren) child.kill('SIGKILL');
  activeChildren.clear();
  vi.restoreAllMocks();
});

describe('Worker adapter and Go relay local interoperability', () => {
  it.each([
    ['confirmed', 'confirmed'],
    ['definitive', 'definitive-failure'],
    ['ambiguous', 'ambiguous'],
    ['timeout', 'ambiguous'],
    ['malformed', 'ambiguous'],
  ] as const)('maps the synthetic Telegram %s path to %s', async (mode, expected) => {
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    await expect(runMode(mode)).resolves.toBe(expected);
    expect(globalFetch).not.toHaveBeenCalled();
  });
});
