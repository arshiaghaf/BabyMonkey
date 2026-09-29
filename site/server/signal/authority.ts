import 'server-only';

import { readSignalObservation } from '@/server/d1/signal-repository';
import { hashOpaqueCookie, sessionCookieName } from '@/server/identity/cookies';
import { getIdentityDatabase } from '@/server/identity/runtime';

export async function resolveRequestSignalSnapshot(request: Request) {
  const db = getIdentityDatabase();
  const sessionHash = await hashOpaqueCookie(request, sessionCookieName);
  if (!db || !sessionHash) return { available: false } as const;
  const observation = await readSignalObservation(db, {
    sessionHash,
    nowMs: Date.now(),
  });
  return observation.snapshot.available
    ? { ...observation.snapshot, version: observation.version }
    : observation.snapshot;
}
