import 'server-only';

import { resolveSessionAuthority } from '@/server/d1/identity-repository';
import { hashOpaqueCookie, sessionCookieName } from './cookies';
import { getIdentityDatabase } from './runtime';

export async function resolveRequestAuthority(request: Request) {
  const db = getIdentityDatabase();
  const sessionHash = await hashOpaqueCookie(request, sessionCookieName);
  if (!db || !sessionHash) return { authorized: false } as const;
  return resolveSessionAuthority(db, sessionHash, Date.now());
}
