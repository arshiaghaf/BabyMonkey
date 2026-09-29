import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('ordered local D1 migrations', () => {
  it('create only two neutral structural slots and a disabled singleton', async () => {
    await applyD1Migrations(env.TEST_DB, env.TEST_MIGRATIONS);

    const slots = await env.TEST_DB.prepare(
      'SELECT slot, ordinal FROM principal_slots ORDER BY slot',
    ).all();
    expect(slots.results).toEqual([
      { slot: 1, ordinal: 1 },
      { slot: 2, ordinal: 2 },
    ]);

    for (const table of [
      'principals',
      'credentials',
      'invitations',
      'sessions',
      'operational_reservations',
      'transaction_assertions',
      'webauthn_challenges',
    ]) {
      const count = await env.TEST_DB.prepare(
        `SELECT COUNT(*) AS count FROM ${table}`,
      ).first<number>('count');
      expect(count, table).toBe(0);
    }

    const notification = await env.TEST_DB.prepare(
      'SELECT singleton, enabled, revision, updated_at_ms FROM notification_control',
    ).first();
    expect(notification).toEqual({
      singleton: 1,
      enabled: 0,
      revision: 1,
      updated_at_ms: 0,
    });

    const migrations = await env.TEST_DB.prepare(
      'SELECT name FROM d1_migrations ORDER BY id',
    ).all();
    expect(migrations.results).toEqual([
      { name: '0001_authorization_core.sql' },
      { name: '0002_invitations_and_sessions.sql' },
      { name: '0003_operational_controls.sql' },
      { name: '0004_identity_ceremonies.sql' },
      { name: '0005_protected_signal_state.sql' },
    ]);

    const principalForeignKeys = await env.TEST_DB.prepare(
      'PRAGMA foreign_key_list(principals)',
    ).all<{ table: string; from: string; to: string }>();
    expect(principalForeignKeys.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'credentials',
        from: 'credential_slot',
        to: 'principal_slot',
      }),
    ]));
    const credentialForeignKeys = await env.TEST_DB.prepare(
      'PRAGMA foreign_key_list(credentials)',
    ).all<{ table: string; from: string; to: string }>();
    expect(credentialForeignKeys.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'principals',
        from: 'principal_slot',
        to: 'slot',
      }),
    ]));
  });
});
