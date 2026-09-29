import {
  appendFlowCookie,
  createOpaqueToken,
  invitationBootstrapCookieName,
} from '@/server/identity/cookies';
import { encodeBase64url, randomBytes } from '@/server/identity/crypto';
import { noStoreHeaders } from '@/server/identity/request';

export const dynamic = 'force-dynamic';

const htmlEscape = (value: string) => value
  .replaceAll('&', '&amp;')
  .replaceAll('"', '&quot;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;');

export async function GET() {
  const flow = await createOpaqueToken();
  const csrf = await createOpaqueToken();
  const nonce = encodeBase64url(randomBytes(18));
  const script = `(() => {
    let token = location.hash.startsWith('#') ? location.hash.slice(1) : '';
    let requestBody = '';
    history.replaceState(null, '', '/invite');
    const fail = () => {
      token = '';
      requestBody = '';
      document.getElementById('status').textContent = 'That didn’t work. Please use the private invitation again.';
    };
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) { fail(); return; }
    requestBody = JSON.stringify({ token });
    token = '';
    const exchange = fetch('/api/identity/invitation', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-bm-csrf': '${csrf.raw}' },
      body: requestBody,
    });
    requestBody = '';
    exchange.then((response) => {
      if (!response.ok) throw new Error();
      location.replace('/');
    }).catch(fail);
  })();`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>A little corner</title></head>
<body><main><p id="status" role="status">Opening your private invitation…</p></main><script nonce="${htmlEscape(nonce)}">${script}</script></body></html>`;
  const headers = noStoreHeaders('text/html; charset=utf-8');
  headers.set(
    'Content-Security-Policy',
    `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  );
  headers.set('X-Frame-Options', 'DENY');
  appendFlowCookie(
    headers,
    invitationBootstrapCookieName,
    flow.raw,
    csrf.raw,
  );
  return new Response(html, { headers });
}

export function POST() {
  return new Response(null, { status: 405, headers: noStoreHeaders('text/plain') });
}
