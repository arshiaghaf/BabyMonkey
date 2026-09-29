import { validProductionEnvironment } from './worker-config';
// The generated OpenNext entry exists only after `npm run build:cloudflare`.
// @ts-expect-error generated build artifact
import openNextWorker from './.open-next/worker.js';

const unavailable = () => new Response('Not found', {
  status: 404,
  headers: {
    'Cache-Control': 'no-store, max-age=0',
    'Content-Type': 'text/plain; charset=utf-8',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  },
});

const decodePathname = (pathname: string) => {
  let decoded = pathname;
  for (let depth = 0; depth < 2; depth += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
};

const isPrivateAssetOrImageOptimizer = (pathname: string) => {
  const decoded = decodePathname(pathname);
  const normalized = `/${decoded.replace(/^\/+/, '')}`;
  return normalized.startsWith('/__bm_private/')
    || normalized === '/_next/image'
    || normalized.startsWith('/_next/image/');
};

const worker = {
  fetch(request: Request, env: unknown, context: ExecutionContext) {
    if (isPrivateAssetOrImageOptimizer(new URL(request.url).pathname) || !validProductionEnvironment(env)) {
      return unavailable();
    }
    return openNextWorker.fetch(request, env, context);
  },
};

export default worker;
