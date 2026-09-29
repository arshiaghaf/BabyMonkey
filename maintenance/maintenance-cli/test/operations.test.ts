import { createHash } from 'node:crypto';

import type { D1DatabaseLike } from '../../../site/server/d1/types.ts';

import { MaintenanceError } from '../src/errors.ts';
import { MaintenanceService } from '../src/operations.ts';
import type {
  InvitationRecord,
  JournalEntry,
  JournalStore,
  NotificationStatus,
  PrincipalStatus,
  RepositoryApi,
  Slot,
  StatusReader,
} from '../src/types.ts';

const now = 1_800_000_000_000;
const dummyDb = {} as D1DatabaseLike;

const principal = (
  slot: Slot,
  state: PrincipalStatus['state'],
  generation: number | null = null,
): PrincipalStatus => ({
  slot,
  state,
  generation,
  credentialState: state === 'active' ? 'active' : state === 'reset' ? 'revoked' : null,
  credentialGeneration: generation,
  activeSessions: state === 'unfilled' ? 0 : 2,
  operationalReservations: state === 'unfilled' ? 0 : 1,
});

class MemoryJournal implements JournalStore {
  entries: JournalEntry[] = [];
  async list(): Promise<JournalEntry[]> { return structuredClone(this.entries); }
  async replace(entry: JournalEntry): Promise<void> {
    this.entries = this.entries.filter((value) => value.invitationId !== entry.invitationId);
    this.entries.push(structuredClone(entry));
  }
  async remove(invitationId: string): Promise<void> {
    this.entries = this.entries.filter((value) => value.invitationId !== invitationId);
  }
}

interface MutableState {
  principals: Map<Slot, PrincipalStatus>;
  invitations: InvitationRecord[];
  notification: NotificationStatus;
}

const makeHarness = (states?: Partial<MutableState>) => {
  const state: MutableState = {
    principals: states?.principals ?? new Map([
      [1, principal(1, 'unfilled')],
      [2, principal(2, 'active', 4)],
    ]),
    invitations: states?.invitations ?? [],
    notification: states?.notification ?? { enabled: true, revision: 7 },
  };
  const journal = new MemoryJournal();
  const status: StatusReader = {
    async readSnapshot() {
      return {
        principals: [structuredClone(state.principals.get(1)!), structuredClone(state.principals.get(2)!)],
        invitations: structuredClone(state.invitations.filter(
          (value) => value.revokedAtMs === null && value.consumedAtMs === null && value.expiresAtMs > now,
        )),
        notification: { ...state.notification },
      };
    },
    async readPrincipal(slot) { return structuredClone(state.principals.get(slot)!); },
    async readInvitationById(id) {
      return structuredClone(state.invitations.find((value) => value.invitationId === id) ?? null);
    },
    async readOutstandingInvitations(slot) {
      return structuredClone(state.invitations.filter((value) => (
        value.slot === slot && value.revokedAtMs === null && value.consumedAtMs === null
        && value.expiresAtMs > now
      )));
    },
    async readNotification() { return { ...state.notification }; },
  };
  const repository: RepositoryApi = {
    async createInvitation(_db, input) {
      state.invitations.push({
        ...input,
        requiredGeneration: input.purpose === 'replacement'
          ? state.principals.get(input.slot)!.generation
          : null,
        revokedAtMs: null,
        consumedAtMs: null,
      });
      return false;
    },
    async revokeInvitation(_db, hash, revokedAtMs) {
      const match = state.invitations.find((value) => value.tokenHash === hash);
      if (match) match.revokedAtMs = revokedAtMs;
      return false;
    },
    async resetPrincipalAuthorization(_db, slot) {
      const before = state.principals.get(slot)!;
      state.principals.set(slot, {
        ...before,
        state: 'reset', credentialState: 'revoked', activeSessions: 0, operationalReservations: 0,
      });
      return false;
    },
    async advancePrincipalGeneration(_db, slot) {
      const before = state.principals.get(slot)!;
      state.principals.set(slot, {
        ...before,
        generation: before.generation! + 1,
        credentialGeneration: before.generation! + 1,
        activeSessions: 0,
        operationalReservations: 0,
      });
      return false;
    },
    async revokePrincipalSessions(_db, slot) {
      const before = state.principals.get(slot)!;
      state.principals.set(slot, { ...before, activeSessions: 0 });
      return { confirmed: false };
    },
    async setNotificationState(_db, input) {
      state.notification = { enabled: input.enabled, revision: input.expectedRevision + 1 };
      return false;
    },
  };
  const service = new MaintenanceService({
    db: dummyDb,
    invitationOrigin: 'https://app.owner.org',
    status,
    repository,
    journal,
    now: () => now,
    randomBytes: (size) => Buffer.alloc(size, size === 18 ? 0x11 : 0x22),
  });
  return { state, status, repository, journal, service };
};

describe('MaintenanceService', () => {
  it('reconciles a committed invitation even when the repository returns false', async () => {
    const { service, state, journal } = makeHarness();
    const presentation = await service.createInvitation(1);
    expect(presentation.url).toMatch(/^https:\/\/app\.owner\.org\/invite#[A-Za-z0-9_-]{43}$/);
    expect(state.invitations).toHaveLength(1);
    expect(state.invitations[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    const rawToken = presentation.url.split('#')[1];
    if (rawToken === undefined) throw new Error('missing invitation fragment');
    expect(state.invitations[0]?.tokenHash).toBe(
      createHash('sha256').update(rawToken, 'utf8').digest('hex'),
    );
    expect(JSON.stringify(journal.entries)).not.toContain(presentation.url.split('#')[1]);
    expect(journal.entries[0]?.state).toBe('committed');
    await service.markInvitationPresented(presentation.invitationId);
    expect(journal.entries).toEqual([]);
  });

  it('refuses filled-slot initial creation and duplicate outstanding invitations', async () => {
    const filled = makeHarness();
    await expect(filled.service.createInvitation(2)).rejects.toMatchObject({ code: 'invitation-unavailable' });
    const duplicate = makeHarness({
      invitations: [{
        invitationId: 'existing-invitation', tokenHash: 'a'.repeat(64), slot: 1,
        purpose: 'initial', requiredGeneration: null, createdAtMs: now - 1,
        expiresAtMs: now + 1_000, revokedAtMs: null, consumedAtMs: null,
      }],
    });
    await expect(duplicate.service.createInvitation(1)).rejects.toMatchObject({ code: 'invitation-unavailable' });
  });

  it('creates replacement invitations only for a reset stable slot', async () => {
    const harness = makeHarness({ principals: new Map([
      [1, principal(1, 'reset', 9)], [2, principal(2, 'active', 3)],
    ]) });
    const presentation = await harness.service.createInvitation(1);
    expect(harness.state.invitations[0]?.purpose).toBe('replacement');
    expect(presentation.url).toContain('#');
  });

  it('revokes a committed orphan on restart without retaining a raw token', async () => {
    const harness = makeHarness();
    const presentation = await harness.service.createInvitation(1);
    presentation.url = '';
    expect(await harness.service.recoverInvitationJournal()).toEqual({
      quarantinedSlots: [],
      revoked: 1,
    });
    expect(harness.state.invitations[0]?.revokedAtMs).toBe(now);
    expect(harness.journal.entries).toEqual([]);
  });

  it('retains an unexpired pending journal after an ambiguous absent read', async () => {
    const harness = makeHarness();
    await harness.journal.replace({
      invitationId: 'prepared-invitation', tokenHash: 'c'.repeat(64), slot: 1,
      purpose: 'initial', createdAtMs: now - 10, expiresAtMs: now + 1_000,
      state: 'pending',
    });
    expect(await harness.service.recoverInvitationJournal()).toEqual({
      quarantinedSlots: [1],
      revoked: 0,
    });
    expect(harness.journal.entries).toHaveLength(1);
    await expect(harness.service.createInvitation(1)).rejects.toMatchObject({
      code: 'invitation-unavailable',
    });
    await expect(harness.service.readStatus()).resolves.toBeDefined();
    await expect(harness.service.resetPrincipal(2)).resolves.toBeUndefined();
    await expect(harness.service.setNotifications(false, 7)).resolves.toBeUndefined();
  });

  it('clears an absent pending journal only after its invitation can no longer be usable', async () => {
    const harness = makeHarness();
    await harness.journal.replace({
      invitationId: 'expired-prepared-invitation', tokenHash: 'd'.repeat(64), slot: 1,
      purpose: 'initial', createdAtMs: now - 1_000, expiresAtMs: now,
      state: 'pending',
    });
    expect(await harness.service.recoverInvitationJournal()).toEqual({
      quarantinedSlots: [],
      revoked: 0,
    });
    expect(harness.journal.entries).toEqual([]);
    const presentation = await harness.service.createInvitation(1);
    expect(presentation.invitationId).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('revokes a late invitation commit retained by its pending journal', async () => {
    const harness = makeHarness();
    const delayed: Array<Parameters<RepositoryApi['createInvitation']>[1]> = [];
    harness.repository.createInvitation = async (_db, input) => {
      delayed.push(structuredClone(input));
      throw new Error('synthetic response loss before delayed commit');
    };
    await expect(harness.service.createInvitation(1)).rejects.toMatchObject({
      code: 'mutation-not-confirmed',
    });
    expect(harness.journal.entries[0]?.state).toBe('pending');
    const input = delayed[0];
    if (!input) throw new Error('missing delayed input');
    harness.state.invitations.push({
      ...input,
      requiredGeneration: null,
      revokedAtMs: null,
      consumedAtMs: null,
    });
    expect(await harness.service.recoverInvitationJournal()).toEqual({
      quarantinedSlots: [],
      revoked: 1,
    });
    expect(harness.state.invitations[0]?.revokedAtMs).toBe(now);
    expect(harness.journal.entries).toEqual([]);
  });

  it('clears a matching consumed invitation left committed after presentation', async () => {
    const harness = makeHarness();
    await harness.service.createInvitation(1);
    harness.state.invitations[0].consumedAtMs = now;
    expect(await harness.service.recoverInvitationJournal()).toEqual({
      quarantinedSlots: [],
      revoked: 0,
    });
    expect(harness.state.invitations[0]?.revokedAtMs).toBeNull();
    expect(harness.journal.entries).toEqual([]);
  });

  it('blocks a consumed invitation that was never committed for presentation', async () => {
    const harness = makeHarness();
    await harness.service.createInvitation(1);
    const entry = harness.journal.entries[0];
    if (!entry) throw new Error('missing journal entry');
    await harness.journal.replace({ ...entry, state: 'pending' });
    harness.state.invitations[0].consumedAtMs = now;
    await expect(harness.service.recoverInvitationJournal()).rejects.toMatchObject({ code: 'contradictory-state' });
  });

  it('confirms reset, generation, session, and notification mutations per principal', async () => {
    const harness = makeHarness();
    const otherBefore = structuredClone(harness.state.principals.get(1));
    await harness.service.resetPrincipal(2);
    expect(harness.state.principals.get(2)).toMatchObject({ state: 'reset', activeSessions: 0 });
    expect(harness.state.principals.get(1)).toEqual(otherBefore);

    harness.state.principals.set(2, principal(2, 'active', 8));
    await harness.service.advanceGeneration(2);
    expect(harness.state.principals.get(2)).toMatchObject({ generation: 9, credentialGeneration: 9 });

    harness.state.principals.set(2, principal(2, 'active', 9));
    await harness.service.revokePrincipalSessions(2);
    expect(harness.state.principals.get(2)?.activeSessions).toBe(0);

    await harness.service.setNotifications(false, 7);
    expect(harness.state.notification).toEqual({ enabled: false, revision: 8 });
  });

  it('fails closed on an unchanged ambiguous mutation and a stale revision', async () => {
    const harness = makeHarness();
    harness.repository.resetPrincipalAuthorization = async () => false;
    await expect(harness.service.resetPrincipal(2)).rejects.toMatchObject({ code: 'mutation-not-confirmed' });

    harness.repository.setNotificationState = async () => {
      harness.state.notification = { enabled: false, revision: 12 };
      return true;
    };
    await expect(harness.service.setNotifications(false, 7)).rejects.toMatchObject({ code: 'contradictory-state' });
  });

  it('never exposes unexpected provider errors', async () => {
    const harness = makeHarness();
    harness.repository.advancePrincipalGeneration = async () => {
      throw new Error('Bearer secret-provider-payload');
    };
    await expect(harness.service.advanceGeneration(2)).rejects.toEqual(
      new MaintenanceError('mutation-not-confirmed'),
    );
  });
});
