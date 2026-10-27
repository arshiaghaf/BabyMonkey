import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';

const require = createRequire(import.meta.url);

// Resolve through the actual consumers so hoisting cannot leave one copy unchecked.
for (const consumer of ['miniflare', 'jsdom']) {
  const consumerRequire = createRequire(require.resolve(consumer));
  const root = path.dirname(consumerRequire.resolve('undici/package.json'));

  test(`${consumer}: SRI checks case variants and the strongest digest`, () => {
    const { bytesMatch } = require(path.join(root, 'lib/web/subresource-integrity/subresource-integrity.js'));
    const body = Buffer.from('expected response');
    const digest = createHash('sha256').update(body).digest('base64');
    const wrongStrongDigest = createHash('sha512').update('different response').digest('base64');
    for (const token of ['sha256', 'SHA256', 'Sha256']) {
      assert.equal(bytesMatch(body, `${token}-${digest}`), true);
      assert.equal(bytesMatch(Buffer.from('substituted response'), `${token}-${digest}`), false);
    }
    assert.equal(bytesMatch(body, `sha256-${digest} SHA512-${wrongStrongDigest}`), false);
  });

  test(`${consumer}: EventSource bounds tiny fields and fragmented lines`, async () => {
    const { EventSourceStream } = require(path.join(root, 'lib/web/eventsource/eventsource-stream.js'));
    for (const mode of ['fields', 'chunks']) {
      const stream = new EventSourceStream({ maxEventSize: 4096 });
      let error;
      stream.on('error', value => { error = value; });
      try {
        if (mode === 'fields') stream.write(Buffer.from('data:\n'.repeat(2048)));
        else for (let i = 0; i < 2048; i++) stream.write(Buffer.from('x'));
        await new Promise(resolve => setImmediate(resolve));
        assert.match(error?.message ?? '', /EventSource message size exceeded/);
      } finally {
        stream.destroy();
      }
    }
    const ordinary = new EventSourceStream({ maxEventSize: 4096 });
    const messages = [];
    ordinary.on('data', message => messages.push(message.options.data));
    const completed = once(ordinary, 'end');
    ordinary.end(Buffer.from('data: ordinary\r\n\r\ndata: second\n\n'));
    await completed;
    assert.deepEqual(messages, ['ordinary', 'second']);
  });

  test(`${consumer}: excessive encodings and early close cannot crash the process`, () => {
    // An uncaught stream error must fail a disposable child, not the test runner.
    execFileSync(process.execPath, ['-e', `(${encodingProbe.toString()})()`, root], {
      timeout: 10_000,
      stdio: 'pipe',
    });
  });
}

async function encodingProbe() {
  const assert = require('node:assert/strict');
  const { once } = require('node:events');
  const { createServer } = require('node:net');
  const { createServer: createHttpServer } = require('node:http');
  const { gzipSync } = require('node:zlib');
  const { fetch, Client } = require(process.argv[1]);
  const broken = createServer(socket => {
    socket.once('data', () => socket.end(
      'HTTP/1.1 200 OK\r\nContent-Length: 1\r\nConnection: close\r\n' +
      `Content-Encoding: ${Array(6).fill('gzip').join(', ')}\r\n\r\n`,
    ));
  });
  const ordinary = createHttpServer((_request, response) => {
    response.writeHead(200, { 'content-encoding': 'gzip' });
    response.end(gzipSync('ordinary response'));
  });
  let client;
  let ordinaryClient;
  try {
    broken.listen(0, '127.0.0.1');
    await once(broken, 'listening');
    const url = `http://127.0.0.1:${broken.address().port}`;
    client = new Client(url);
    await assert.rejects(fetch(url, { dispatcher: client }), error => /content-encoding/.test(error.cause?.message));
    await client.close();
    // Allow the early-close stream error to surface before declaring success.
    await new Promise(resolve => setTimeout(resolve, 50));
    ordinary.listen(0, '127.0.0.1');
    await once(ordinary, 'listening');
    const ordinaryUrl = `http://127.0.0.1:${ordinary.address().port}`;
    ordinaryClient = new Client(ordinaryUrl);
    const response = await fetch(ordinaryUrl, { dispatcher: ordinaryClient });
    assert.equal(await response.text(), 'ordinary response');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await client?.destroy();
    await ordinaryClient?.destroy();
    broken.close();
    ordinary.closeAllConnections();
    ordinary.close();
  }
}
