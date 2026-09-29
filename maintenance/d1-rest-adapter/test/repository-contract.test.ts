import { describe, expect, it, vi } from 'vitest';

import {
  clearInvitationPendingClaim,
  readNotificationEligibility,
  revokePrincipalSessions,
  setNotificationState,
  validateInvitationEligibility,
  validateSession,
} from '../../../site/server/d1/repository.ts';
import { createD1RestDatabase, type D1RestTransport } from '../src/index.ts';

const response = (results: unknown[]) => new Response(JSON.stringify({
  success: true,
  errors: [],
  messages: [],
  result: results,
}), { status: 200, headers: { 'content-type': 'application/json' } });

describe('authoritative repository compatibility', () => {
  it('preserves first, run, and batch success contracts without adding a caller', async () => {
    const replies = [
      response([{ success: true, results: [{ invitationId: 'synthetic_invitation' }], meta: { changes: 0 } }]),
      response([{ success: true, results: [{ authorized: 1 }], meta: { changes: 0 } }]),
      response([{ success: true, results: [], meta: { changes: 1 } }]),
      response([{ success: true, results: [], meta: { changes: 2 } }]),
      response([{ success: true, results: [{ enabled: 1, revision: 7 }], meta: { changes: 0 } }]),
      response([
        { success: true, results: [], meta: { changes: 1 } },
        { success: true, results: [], meta: { changes: 1 } },
        { success: true, results: [], meta: { changes: 1 } },
        { success: true, results: [], meta: { changes: 1 } },
      ]),
    ];
    const transport = vi.fn<D1RestTransport>(async () => replies.shift()!);
    const db = createD1RestDatabase({ transport });

    await expect(validateInvitationEligibility(db, {
      tokenHash: 'a'.repeat(64),
      slot: 1,
      purpose: 'initial',
      nowMs: 1,
    })).resolves.toEqual({ eligible: true, invitationId: 'synthetic_invitation' });
    await expect(validateSession(db, 'b'.repeat(64), 1)).resolves.toBe(true);
    await expect(clearInvitationPendingClaim(
      db,
      'c'.repeat(64),
      'd'.repeat(64),
    )).resolves.toBe(true);
    await expect(revokePrincipalSessions(db, 1, 2)).resolves.toEqual({
      confirmed: true,
      revoked: 2,
    });
    await expect(readNotificationEligibility(db)).resolves.toEqual({
      eligible: true,
      revision: 7,
    });
    await expect(setNotificationState(db, {
      enabled: false,
      expectedRevision: 7,
      updatedAtMs: 3,
    })).resolves.toBe(true);
    expect(transport).toHaveBeenCalledTimes(6);
  });

  it('makes ambiguous and malformed adapter outcomes fail closed in the repository', async () => {
    const malformed: D1RestTransport = async () => response([
      { success: true, results: [{ authorized: 1 }] },
    ]);
    const transportLoss: D1RestTransport = async () => {
      throw new Error('synthetic response loss after possible commit');
    };

    await expect(validateSession(
      createD1RestDatabase({ transport: malformed }),
      'e'.repeat(64),
      1,
    )).resolves.toBe(false);
    await expect(setNotificationState(
      createD1RestDatabase({ transport: transportLoss }),
      { enabled: true, expectedRevision: 1, updatedAtMs: 2 },
    )).resolves.toBe(false);
  });
});
