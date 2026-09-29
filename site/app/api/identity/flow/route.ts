import {
  appendFlowCookie,
  createOpaqueToken,
  ceremonyFlowCookieName,
} from '@/server/identity/cookies';
import { noStoreHeaders } from '@/server/identity/request';

export const dynamic = 'force-dynamic';

export async function GET() {
  const flow = await createOpaqueToken();
  const csrf = await createOpaqueToken();
  const headers = noStoreHeaders('application/json');
  appendFlowCookie(headers, ceremonyFlowCookieName, flow.raw, csrf.raw);
  return new Response(JSON.stringify({ csrf: csrf.raw }), { headers });
}

export function POST() {
  return new Response(null, { status: 405, headers: noStoreHeaders('text/plain') });
}
