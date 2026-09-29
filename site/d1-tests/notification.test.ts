import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import {
  readNotificationEligibility,
  setNotificationState,
} from '@/server/d1/repository';
import type { D1DatabaseLike } from '@/server/d1/types';
import { db } from './helpers';

describe('fail-closed notification control', () => {
  it('denies malformed, missing, disabled, raced, and unreadable state', async () => {
    expect(await readNotificationEligibility(db)).toEqual({ eligible: false });

    const race = await Promise.all([
      setNotificationState(db, {
        enabled: true,
        expectedRevision: 1,
        updatedAtMs: 100,
      }),
      setNotificationState(db, {
        enabled: false,
        expectedRevision: 1,
        updatedAtMs: 101,
      }),
    ]);
    expect(race.filter(Boolean)).toHaveLength(1);

    const current = await env.TEST_DB.prepare(
      'SELECT enabled, revision FROM notification_control WHERE singleton = 1',
    ).first<{ enabled: number; revision: number }>();
    expect(current?.revision).toBe(2);
    if (current?.enabled === 0) {
      expect(await setNotificationState(db, {
        enabled: true,
        expectedRevision: 2,
        updatedAtMs: 200,
      })).toBe(true);
    }
    const enabled = await readNotificationEligibility(db);
    expect(enabled.eligible).toBe(true);
    expect(enabled.revision).toBeGreaterThanOrEqual(2);

    expect(await setNotificationState(db, {
      enabled: false,
      expectedRevision: enabled.revision!,
      updatedAtMs: 300,
    })).toBe(true);
    expect(await readNotificationEligibility(db)).toEqual({ eligible: false });

    const malformedDb = {
      prepare: () => ({
        bind() { return this; },
        first: async () => ({ enabled: 2, revision: 'bad' }),
        run: async () => ({ success: true }),
      }),
      batch: async () => [],
    } as D1DatabaseLike;
    expect(await readNotificationEligibility(malformedDb)).toEqual({ eligible: false });

    const missingDb = {
      prepare: () => ({
        bind() { return this; },
        first: async () => null,
        run: async () => ({ success: true }),
      }),
      batch: async () => [],
    } as D1DatabaseLike;
    expect(await readNotificationEligibility(missingDb)).toEqual({ eligible: false });

    const unreadableDb = {
      prepare: () => {
        throw new Error('synthetic local D1 failure');
      },
      batch: async () => [],
    } as unknown as D1DatabaseLike;
    expect(await readNotificationEligibility(unreadableDb)).toEqual({ eligible: false });

    await env.TEST_DB.prepare('DROP TABLE notification_control').run();
    expect(await readNotificationEligibility(db)).toEqual({ eligible: false });
  });
});
