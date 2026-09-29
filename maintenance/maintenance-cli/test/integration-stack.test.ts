import {
  advancePrincipalGeneration,
  createInvitation,
  resetPrincipalAuthorization,
  revokeInvitation,
  revokePrincipalSessions,
  setNotificationState,
} from '../../../site/server/d1/repository.ts';
import { createD1RestDatabase, type D1RestTransport } from '../../d1-rest-adapter/src/index.ts';

import { MaintenanceService } from '../src/operations.ts';
import { createStatusReader } from '../src/status.ts';
import type {
  InvitationRecord,
  JournalEntry,
  JournalStore,
  NotificationStatus,
  PrincipalStatus,
  RepositoryApi,
  Slot,
} from '../src/types.ts';

interface RestQuery { sql: string; params?: Array<string | number | null> | undefined; }
interface RestBody {
  sql?: string;
  params?: Array<string | number | null> | undefined;
  batch?: RestQuery[];
}

class Journal implements JournalStore {
  entries: JournalEntry[] = [];
  async list(): Promise<JournalEntry[]> { return structuredClone(this.entries); }
  async replace(entry: JournalEntry): Promise<void> {
    this.entries = this.entries.filter((value) => value.invitationId !== entry.invitationId);
    this.entries.push(structuredClone(entry));
  }
  async remove(id: string): Promise<void> {
    this.entries = this.entries.filter((value) => value.invitationId !== id);
  }
}

const activePrincipal = (slot: Slot, generation: number): PrincipalStatus => ({
  slot,
  state: 'active',
  generation,
  credentialState: 'active',
  credentialGeneration: generation,
  activeSessions: 2,
  operationalReservations: 1,
});

class SyntheticRestD1 {
  readonly principals = new Map<Slot, PrincipalStatus>([
    [1, {
      slot: 1, state: 'unfilled', generation: null, credentialState: null,
      credentialGeneration: null, activeSessions: 0, operationalReservations: 0,
    }],
    [2, activePrincipal(2, 5)],
  ]);
  invitations: InvitationRecord[] = [];
  notification: NotificationStatus = { enabled: true, revision: 3 };
  nextMutationOutcome:
    | 'normal'
    | 'committed-loss'
    | 'delayed-commit'
    | 'timeout'
    | 'provider-denial' = 'normal';

  readonly transport: D1RestTransport = async (request) => {
    const body = JSON.parse(request.body) as RestBody;
    const queries = body.batch ?? [{ sql: body.sql ?? '', params: body.params }];
    const mutation = this.mutationName(queries);
    const outcome = mutation ? this.nextMutationOutcome : 'normal';
    if (mutation) this.nextMutationOutcome = 'normal';
    if (outcome === 'timeout') return new Promise<Response>(() => undefined);
    if (outcome === 'provider-denial') {
      return Response.json({ success: false, errors: [{ code: 9 }], messages: [], result: [] });
    }
    if (outcome === 'delayed-commit') {
      await new Promise((resolve) => { setTimeout(resolve, 15); });
    }

    const results = mutation
      ? this.applyMutation(mutation, queries)
      : queries.map((query) => this.read(query));
    if (outcome === 'committed-loss') throw new Error('synthetic response loss');
    return Response.json({ success: true, errors: [], messages: [], result: results });
  };

  mutationName(queries: RestQuery[]): string | null {
    const firstParam = queries[0]?.params?.[0];
    if (typeof firstParam === 'string' && firstParam.includes(':')) {
      return firstParam.split(':', 1)[0] ?? null;
    }
    if (queries[0]?.sql.includes('UPDATE sessions SET revoked_at_ms')) return 'revoke-sessions';
    return null;
  }

  applyMutation(name: string, queries: RestQuery[]) {
    const params = queries[0]?.params ?? [];
    if (name === 'create-invitation') {
      const insert = queries[1]?.params ?? [];
      const slot = insert[3] as Slot;
      const purpose = insert[4] as 'initial' | 'replacement';
      this.invitations.push({
        invitationId: String(insert[1]), tokenHash: String(insert[2]), slot, purpose,
        requiredGeneration: purpose === 'replacement' ? this.principals.get(slot)!.generation : null,
        createdAtMs: Number(insert[5]), expiresAtMs: Number(insert[6]),
        revokedAtMs: null, consumedAtMs: null,
      });
    } else if (name === 'revoke-invitation') {
      const invitation = this.invitations.find((value) => value.tokenHash === params[1]);
      if (invitation) invitation.revokedAtMs = Number(params[2]);
    } else if (name === 'reset-principal') {
      const slot = params[1] as Slot;
      const before = this.principals.get(slot)!;
      this.principals.set(slot, {
        ...before, state: 'reset', credentialState: 'revoked', activeSessions: 0,
        operationalReservations: 0,
      });
    } else if (name === 'advance-generation') {
      const slot = params[1] as Slot;
      const before = this.principals.get(slot)!;
      this.principals.set(slot, {
        ...before, generation: before.generation! + 1,
        credentialGeneration: before.generation! + 1,
        activeSessions: 0, operationalReservations: 0,
      });
    } else if (name === 'notification-state') {
      const enabled = Number(queries[1]?.params?.[0]) === 1;
      const expected = Number(queries[1]?.params?.[1]);
      this.notification = { enabled, revision: expected + 1 };
    } else if (name === 'revoke-sessions') {
      const slot = params[0] as Slot;
      this.principals.set(slot, { ...this.principals.get(slot)!, activeSessions: 0 });
    }
    return queries.map(() => ({ success: true, results: [], meta: { changes: 1 } }));
  }

  read(query: RestQuery) {
    const sql = query.sql;
    const params = query.params ?? [];
    let results: Array<Record<string, unknown>> = [];
    if (sql.includes('FROM principal_slots') && sql.includes('WHERE ps.slot')) {
      const value = this.principals.get(params[1] as Slot)!;
      results = [{
        slot: value.slot,
        principalState: value.state === 'unfilled' ? null : value.state,
        generation: value.generation,
        credentialState: value.credentialState,
        credentialGeneration: value.credentialGeneration,
        activeSessions: value.activeSessions,
        operationalReservations: value.operationalReservations,
      }];
    } else if (sql.includes('FROM invitations') && sql.includes('invitation_id =')) {
      const value = this.invitations.find((candidate) => candidate.invitationId === params[0]);
      if (value) results = [this.invitationRow(value)];
    } else if (sql.includes('FROM invitations') && sql.includes('principal_slot =')) {
      results = this.invitations
        .filter((value) => (
          value.slot === params[0] && value.revokedAtMs === null
          && value.consumedAtMs === null && value.expiresAtMs > Number(params[1])
        ))
        .map((value) => this.invitationRow(value));
    } else if (sql.includes('FROM notification_control')) {
      results = [{ enabled: this.notification.enabled ? 1 : 0, revision: this.notification.revision }];
    }
    return { success: true, results, meta: { changes: 0 } };
  }

  invitationRow(value: InvitationRecord): Record<string, unknown> {
    return {
      invitationId: value.invitationId, tokenHash: value.tokenHash, slot: value.slot,
      purpose: value.purpose, requiredGeneration: value.requiredGeneration,
      createdAtMs: value.createdAtMs, expiresAtMs: value.expiresAtMs,
      revokedAtMs: value.revokedAtMs, consumedAtMs: value.consumedAtMs,
    };
  }
}

const repository: RepositoryApi = {
  advancePrincipalGeneration,
  createInvitation,
  resetPrincipalAuthorization,
  revokeInvitation,
  revokePrincipalSessions,
  setNotificationState,
};

const createHarness = () => {
  const remote = new SyntheticRestD1();
  const journal = new Journal();
  const db = createD1RestDatabase({ transport: remote.transport, timeoutMs: 5 });
  const service = new MaintenanceService({
    db,
    invitationOrigin: 'https://app.owner.org',
    status: createStatusReader(db),
    repository,
    journal,
    now: () => 1_800_000_000_000,
    randomBytes: (size) => Buffer.alloc(size, size),
  });
  return { remote, service, journal };
};

describe('exact adapter and repository stack', () => {
  it('reconciles every fixed repository mutation through the REST adapter', async () => {
    const { remote, service } = createHarness();
    remote.nextMutationOutcome = 'committed-loss';
    const invitation = await service.createInvitation(1);
    await service.markInvitationPresented(invitation.invitationId);
    await service.revokeInvitation(remote.invitations[0]);

    await service.resetPrincipal(2);
    remote.principals.set(2, activePrincipal(2, 5));
    await service.advanceGeneration(2);
    remote.principals.set(2, activePrincipal(2, 6));
    await service.revokePrincipalSessions(2);
    await service.setNotifications(false, 3);

    expect(remote.invitations[0]?.revokedAtMs).not.toBeNull();
    expect(remote.principals.get(2)).toMatchObject({ activeSessions: 0 });
    expect(remote.notification).toEqual({ enabled: false, revision: 4 });
  });

  it.each(['provider-denial', 'timeout'] as const)(
    'fails closed and does not retry after %s',
    async (outcome) => {
      const { remote, service } = createHarness();
      remote.nextMutationOutcome = outcome;
      await expect(service.resetPrincipal(2)).rejects.toMatchObject({ code: 'mutation-not-confirmed' });
      expect(remote.principals.get(2)).toMatchObject({ state: 'active', generation: 5 });
      expect(remote.nextMutationOutcome).toBe('normal');
    },
  );

  it('keeps a provider-denied invitation guarded because its commit outcome is unknown', async () => {
    const { remote, service, journal } = createHarness();
    remote.nextMutationOutcome = 'provider-denial';
    await expect(service.createInvitation(1)).rejects.toMatchObject({ code: 'mutation-not-confirmed' });
    expect(journal.entries[0]?.state).toBe('pending');
    await expect(service.createInvitation(1)).rejects.toMatchObject({ code: 'invitation-unavailable' });
  });

  it('revokes an invitation that commits after the exact adapter times out', async () => {
    const { remote, service, journal } = createHarness();
    remote.nextMutationOutcome = 'delayed-commit';
    await expect(service.createInvitation(1)).rejects.toMatchObject({ code: 'mutation-not-confirmed' });
    expect(journal.entries[0]?.state).toBe('pending');
    expect(remote.invitations).toEqual([]);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(remote.invitations).toHaveLength(1);
    expect(await service.recoverInvitationJournal()).toEqual({
      quarantinedSlots: [],
      revoked: 1,
    });
    expect(remote.invitations[0]?.revokedAtMs).not.toBeNull();
    expect(journal.entries).toEqual([]);
  });
});
