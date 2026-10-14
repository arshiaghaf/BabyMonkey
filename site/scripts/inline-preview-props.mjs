import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// OpenNext 1.20.7 omits Next 16.4's required preview-props.json from
// loadManifest inlining. Remove this adjustment when a released adapter
// includes it: https://github.com/opennextjs/opennextjs-cloudflare/pull/1356
// Keep the real build-specific draft-mode keys in the server bundle only.
export function inlinePreviewProps(bundle, manifest) {
  const keys = ['previewModeId', 'previewModeSigningKey', 'previewModeEncryptionKey'];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || Object.keys(manifest).length !== keys.length
      || keys.some((key) => typeof manifest[key] !== 'string' || !manifest[key])) {
    throw new Error('Unexpected preview props manifest shape.');
  }
  const failure = /throw new Error\(`Unexpected loadManifest\(\$\{([\w$]+)\}\) call!`\)/g;
  const matches = [...bundle.matchAll(failure)];
  if (matches.length !== 1 || /\.endsWith\(["']\/server\/preview-props\.json["']\)/.test(bundle)) {
    throw new Error('OpenNext manifest inlining changed; review or remove the compatibility adjustment.');
  }
  const parameter = matches[0][1];
  const branch = `if (${parameter}.endsWith("/server/preview-props.json")) return ${JSON.stringify(manifest)};`;
  return bundle.replace(failure, (original) => `${branch}${original}`);
}

async function main() {
  const next = JSON.parse(await readFile('node_modules/next/package.json', 'utf8'));
  const adapter = JSON.parse(await readFile('node_modules/@opennextjs/cloudflare/package.json', 'utf8'));
  if (next.version !== '16.4.1' || adapter.version !== '1.20.7') {
    throw new Error('Review preview props compatibility before changing Next.js or OpenNext versions.');
  }
  const handler = '.open-next/server-functions/default/handler.mjs';
  const manifest = JSON.parse(await readFile('.next/server/preview-props.json', 'utf8'));
  const bundle = await readFile(handler, 'utf8');
  await writeFile(handler, inlinePreviewProps(bundle, manifest));
  console.log('Required preview props inlined into the server handler.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
