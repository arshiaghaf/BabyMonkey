import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveRequestAuthority } from '@/server/identity/authority';
import { noStoreHeaders } from '@/server/identity/request';
import { getProtectedAssetBinding } from '@/server/identity/runtime';
import {
  isProtectedAssetId,
  protectedAssetFiles,
} from '@/server/protected/presentation';

export const dynamic = 'force-dynamic';

const unavailable = () => new Response('Not found', {
  status: 404,
  headers: noStoreHeaders('text/plain; charset=utf-8'),
});

async function loadAsset(assetId: keyof typeof protectedAssetFiles) {
  const binding = getProtectedAssetBinding();
  if (process.env.NODE_ENV !== 'development' && binding) {
    const response = await binding.fetch(
      new Request(`https://assets.invalid/__bm_private/${assetId}.png`),
    );
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
  }
  try {
    return await readFile(path.join(
      process.cwd(),
      'protected-assets',
      'monkey',
      protectedAssetFiles[assetId],
    ));
  } catch {
    return null;
  }
}

async function serve(
  request: Request,
  context: { params: Promise<{ assetId: string }> },
  includeBody: boolean,
) {
  const authority = await resolveRequestAuthority(request);
  if (!authority.authorized) return unavailable();
  const { assetId } = await context.params;
  if (!isProtectedAssetId(assetId)) return unavailable();
  const bytes = await loadAsset(assetId);
  if (!bytes) return unavailable();
  const headers = noStoreHeaders('image/png');
  headers.set('Content-Length', String(bytes.byteLength));
  return new Response(includeBody ? bytes : null, { headers });
}

export function GET(
  request: Request,
  context: { params: Promise<{ assetId: string }> },
) {
  return serve(request, context, true);
}

export function HEAD(
  request: Request,
  context: { params: Promise<{ assetId: string }> },
) {
  return serve(request, context, false);
}
