import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import createNextServer from 'next';
import { createDemoSeed } from './demo-seed.mjs';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const artworkRoot = path.join(projectRoot, 'protected-assets', 'monkey');
const artworkPrefix = '/__preview-assets/monkey/';
const filenamePattern = /^[a-z0-9-]+\.png$/;

function readOption(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const hostname = readOption('--hostname', '127.0.0.1');
const port = Number.parseInt(readOption('--port', '3000'), 10);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('The development preview requires a valid --port value.');
}

function sendNotFound(response) {
  response.writeHead(404, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
  });
  response.end('Not found');
}

async function serveProtectedPreviewAsset(request, response, requestUrl) {
  if (!['GET', 'HEAD'].includes(request.method ?? '')) {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end();
    return;
  }

  let filename;
  try {
    filename = decodeURIComponent(requestUrl.pathname.slice(artworkPrefix.length));
  } catch {
    sendNotFound(response);
    return;
  }

  if (!filenamePattern.test(filename)) {
    sendNotFound(response);
    return;
  }

  const assetPath = path.join(artworkRoot, filename);
  let assetStats;
  try {
    assetStats = await stat(assetPath);
  } catch {
    sendNotFound(response);
    return;
  }

  if (!assetStats.isFile()) {
    sendNotFound(response);
    return;
  }

  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Length': assetStats.size,
    'Content-Type': 'image/png',
    'X-Content-Type-Options': 'nosniff',
  });

  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  await pipeline(createReadStream(assetPath), response);
}

let nextRequestHandler;
const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(
      request.url ?? '/',
      `http://${hostname}:${port}`,
    );

    if (process.env.BABYMONKEY_LOCAL_DEMO !== '1' && requestUrl.pathname.startsWith(artworkPrefix)) {
      await serveProtectedPreviewAsset(request, response, requestUrl);
      return;
    }

    if (!nextRequestHandler) { response.writeHead(503); response.end(); return; }
    await nextRequestHandler(request, response);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});

// Bind before any seeding, Next preparation, or product request. Occupied port fails immediately.
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, hostname, resolve); });
let seed;
let pendingSeed;
let app;
async function close() {
  await new Promise((resolve) => server.close(resolve));
  await app?.close();
  await pendingSeed?.catch(() => undefined);
  await seed?.dispose();
  process.exit(0);
}
process.once('SIGINT', close);
process.once('SIGTERM', close);
try {
  if (process.env.BABYMONKEY_LOCAL_DEMO === '1') {
    if (port !== 3000 || hostname !== '127.0.0.1') throw new Error('Demo uses the exact local origin.');
    pendingSeed = createDemoSeed(projectRoot);
    seed = await pendingSeed;
    process.env.BABYMONKEY_DEMO_STATE = seed.stateDir;
  }
  app = createNextServer({ dev: true, dir: projectRoot, hostname, httpServer: server, port, turbopack: true });
  await app.prepare();
  nextRequestHandler = app.getRequestHandler();
  console.log(`Development preview ready at http://${hostname}:${port}`);
  if (seed) {
    console.log('Fresh disposable synthetic invitations (one hour; keep in this terminal):');
    for (const {slot, token} of seed.invitations) console.log(`Slot ${slot}: http://localhost:3000/invite#${token}`);
    process.send?.({ ready: true, tokens: seed.invitations.map(({token}) => token) });
  }
} catch (error) {
  server.close();
  await app?.close();
  await seed?.dispose();
  throw error;
}
