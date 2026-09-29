import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';

import type { D1DatabaseLike } from '../../../site/server/d1/types.ts';


import { MaintenanceError } from './errors.ts';
import type {
  InvitationPresentation,
  InvitationRecord,
  JournalEntry,
  JournalStore,
  MaintenanceSnapshot,
  PrincipalStatus,
  RepositoryApi,
  Slot,
  StatusReader,
} from './types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

const samePrincipalCore = (left: PrincipalStatus, right: PrincipalStatus): boolean => (
  left.slot === right.slot
  && left.state === right.state
  && left.generation === right.generation
  && left.credentialState === right.credentialState
  && left.credentialGeneration === right.credentialGeneration
);

const sameInvitationIdentity = (entry: JournalEntry, record: InvitationRecord): boolean => (
  entry.invitationId === record.invitationId
  && entry.tokenHash === record.tokenHash
  && entry.slot === record.slot
  && entry.purpose === record.purpose
  && entry.createdAtMs === record.createdAtMs
  && entry.expiresAtMs === record.expiresAtMs
);

const sameInvitationRecord = (left: InvitationRecord, right: InvitationRecord): boolean => (
  left.invitationId === right.invitationId
  && left.tokenHash === right.tokenHash
  && left.slot === right.slot
  && left.purpose === right.purpose
  && left.requiredGeneration === right.requiredGeneration
  && left.createdAtMs === right.createdAtMs
  && left.expiresAtMs === right.expiresAtMs
  && left.revokedAtMs === right.revokedAtMs
  && left.consumedAtMs === right.consumedAtMs
);

const samePrincipal = (left: PrincipalStatus, right: PrincipalStatus): boolean => (
  samePrincipalCore(left, right)
  && left.activeSessions === right.activeSessions
  && left.operationalReservations === right.operationalReservations
);

const invokeOnce = async (operation: () => Promise<unknown>): Promise<void> => {
  try {
    await operation();
  } catch {
    // Repository outcomes are never treated as authoritative. The fixed read follows.
  }
};

export interface MaintenanceServiceOptions {
  db: D1DatabaseLike;
  status: StatusReader;
  repository: RepositoryApi;
  journal: JournalStore;
  invitationOrigin: string;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}

export class MaintenanceService {
  readonly #db: D1DatabaseLike;
  readonly #status: StatusReader;
  readonly #repository: RepositoryApi;
  readonly #journal: JournalStore;
  readonly #invitationOrigin: string;
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Buffer;

  constructor(options: MaintenanceServiceOptions) {
    this.#db = options.db;
    this.#status = options.status;
    this.#repository = options.repository;
    this.#journal = options.journal;
    this.#invitationOrigin = options.invitationOrigin;
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? nodeRandomBytes;
  }

  readStatus(): Promise<MaintenanceSnapshot> {
    return this.#status.readSnapshot(this.#now());
  }

  async createInvitation(slot: Slot): Promise<InvitationPresentation> {
    const nowMs = this.#now();
    if ((await this.#journal.list()).some((entry) => entry.slot === slot)) {
      throw new MaintenanceError('invitation-unavailable');
    }
    const principal = await this.#status.readPrincipal(slot, nowMs);
    const purpose = this.#invitationPurpose(principal);
    if ((await this.#status.readOutstandingInvitations(slot, nowMs)).length !== 0) {
      throw new MaintenanceError('invitation-unavailable');
    }

    const invitationIdBytes = this.#randomBytes(18);
    const tokenBytes = this.#randomBytes(32);
    let token = '';
    try {
      if (invitationIdBytes.length !== 18 || tokenBytes.length < 32) {
        throw new MaintenanceError('contradictory-state');
      }
      const invitationId = invitationIdBytes.toString('base64url');
      token = tokenBytes.toString('base64url');
      const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex').toLowerCase();
      const entry: JournalEntry = {
        invitationId,
        tokenHash,
        slot,
        purpose,
        createdAtMs: nowMs,
        expiresAtMs: nowMs + DAY_MS,
        state: 'pending',
      };
      await this.#journal.replace(entry);
      await invokeOnce(() => this.#repository.createInvitation(this.#db, entry));

      const exact = await this.#status.readInvitationById(invitationId);
      if (!exact) {
        throw new MaintenanceError('mutation-not-confirmed');
      }
      if (
        !sameInvitationIdentity(entry, exact)
        || (purpose === 'replacement' && exact.requiredGeneration !== principal.generation)
        || exact.revokedAtMs !== null
        || exact.consumedAtMs !== null
      ) {
        throw new MaintenanceError('contradictory-state');
      }

      const outstanding = await this.#status.readOutstandingInvitations(slot, this.#now());
      if (outstanding.length !== 1 || outstanding[0]?.invitationId !== invitationId) {
        await invokeOnce(() => this.#repository.revokeInvitation(
          this.#db,
          tokenHash,
          this.#now(),
        ));
        const revoked = await this.#status.readInvitationById(invitationId);
        if (!revoked || revoked.revokedAtMs === null || revoked.consumedAtMs !== null) {
          throw new MaintenanceError('contradictory-state');
        }
        await this.#journal.remove(invitationId);
        throw new MaintenanceError('contradictory-state');
      }

      await this.#journal.replace({ ...entry, state: 'committed' });
      return {
        invitationId,
        url: `${this.#invitationOrigin}/invite#${token}`,
      };
    } finally {
      invitationIdBytes.fill(0);
      tokenBytes.fill(0);
      token = '';
    }
  }

  async markInvitationPresented(invitationId: string): Promise<void> {
    const entries = await this.#journal.list();
    const entry = entries.find((candidate) => candidate.invitationId === invitationId);
    if (!entry || entry.state !== 'committed') {
      throw new MaintenanceError('contradictory-state');
    }
    await this.#journal.replace({ ...entry, state: 'presented' });
    await this.#journal.remove(invitationId);
  }

  async recoverInvitationJournal(): Promise<{
    quarantinedSlots: Slot[];
    revoked: number;
  }> {
    const entries = await this.#journal.list();
    const quarantinedSlots = new Set<Slot>();
    let revoked = 0;
    for (const entry of entries) {
      if (entry.state === 'presented') {
        await this.#journal.remove(entry.invitationId);
        continue;
      }
      const exact = await this.#status.readInvitationById(entry.invitationId);
      if (!exact) {
        if (entry.expiresAtMs <= this.#now()) {
          await this.#journal.remove(entry.invitationId);
          continue;
        }
        quarantinedSlots.add(entry.slot);
        continue;
      }
      if (!sameInvitationIdentity(entry, exact)) {
        throw new MaintenanceError('contradictory-state');
      }
      if (exact.consumedAtMs !== null) {
        if (entry.state !== 'committed') {
          throw new MaintenanceError('contradictory-state');
        }
        await this.#journal.remove(entry.invitationId);
        continue;
      }
      if (exact.revokedAtMs === null) {
        await invokeOnce(() => this.#repository.revokeInvitation(
          this.#db,
          entry.tokenHash,
          this.#now(),
        ));
      }
      const after = await this.#status.readInvitationById(entry.invitationId);
      if (
        !after
        || !sameInvitationIdentity(entry, after)
        || after.revokedAtMs === null
        || after.consumedAtMs !== null
      ) {
        throw new MaintenanceError('mutation-not-confirmed');
      }
      await this.#journal.remove(entry.invitationId);
      revoked += 1;
    }
    return {
      quarantinedSlots: [...quarantinedSlots].sort(),
      revoked,
    };
  }

  async revokeInvitation(selected: InvitationRecord): Promise<void> {
    const nowMs = this.#now();
    const before = await this.#status.readInvitationById(selected.invitationId);
    if (
      !before
      || !sameInvitationRecord(before, selected)
      || before.revokedAtMs !== null
      || before.consumedAtMs !== null
      || before.expiresAtMs <= nowMs
    ) {
      throw new MaintenanceError('invitation-unavailable');
    }
    await invokeOnce(() => this.#repository.revokeInvitation(
      this.#db,
      before.tokenHash,
      nowMs,
    ));
    const after = await this.#status.readInvitationById(before.invitationId);
    if (
      !after
      || after.invitationId !== before.invitationId
      || after.tokenHash !== before.tokenHash
      || after.slot !== before.slot
      || after.purpose !== before.purpose
      || after.requiredGeneration !== before.requiredGeneration
      || after.createdAtMs !== before.createdAtMs
      || after.expiresAtMs !== before.expiresAtMs
      || after.consumedAtMs !== null
    ) {
      throw new MaintenanceError('contradictory-state');
    }
    if (after.revokedAtMs === null) throw new MaintenanceError('mutation-not-confirmed');
  }

  async resetPrincipal(slot: Slot): Promise<void> {
    const nowMs = this.#now();
    const before = await this.#status.readPrincipal(slot, nowMs);
    if (!this.#isActive(before)) throw new MaintenanceError('contradictory-state');
    await invokeOnce(() => this.#repository.resetPrincipalAuthorization(this.#db, slot, nowMs));
    const after = await this.#status.readPrincipal(slot, this.#now());
    if (
      after.state === 'reset'
      && after.generation === before.generation
      && after.credentialState === 'revoked'
      && after.credentialGeneration === before.credentialGeneration
      && after.activeSessions === 0
      && after.operationalReservations === 0
    ) return;
    if (samePrincipal(before, after)) throw new MaintenanceError('mutation-not-confirmed');
    throw new MaintenanceError('contradictory-state');
  }

  async advanceGeneration(slot: Slot): Promise<void> {
    const nowMs = this.#now();
    const before = await this.#status.readPrincipal(slot, nowMs);
    if (!this.#isActive(before)) throw new MaintenanceError('contradictory-state');
    await invokeOnce(() => this.#repository.advancePrincipalGeneration(this.#db, slot, nowMs));
    const after = await this.#status.readPrincipal(slot, this.#now());
    if (
      after.state === 'active'
      && after.generation === before.generation! + 1
      && after.credentialState === 'active'
      && after.credentialGeneration === after.generation
      && after.activeSessions === 0
      && after.operationalReservations === 0
    ) return;
    if (samePrincipal(before, after)) throw new MaintenanceError('mutation-not-confirmed');
    throw new MaintenanceError('contradictory-state');
  }

  async revokePrincipalSessions(slot: Slot): Promise<void> {
    const nowMs = this.#now();
    const before = await this.#status.readPrincipal(slot, nowMs);
    if (before.state === 'unfilled') throw new MaintenanceError('contradictory-state');
    await invokeOnce(() => this.#repository.revokePrincipalSessions(this.#db, slot, nowMs));
    const after = await this.#status.readPrincipal(slot, this.#now());
    if (
      samePrincipalCore(before, after)
      && after.activeSessions === 0
      && after.operationalReservations === before.operationalReservations
    ) return;
    if (samePrincipal(before, after)) {
      throw new MaintenanceError('mutation-not-confirmed');
    }
    throw new MaintenanceError('contradictory-state');
  }

  async setNotifications(enabled: boolean, expectedRevision: number): Promise<void> {
    const nowMs = this.#now();
    const before = await this.#status.readNotification();
    if (before.revision !== expectedRevision) {
      throw new MaintenanceError('contradictory-state');
    }
    if (before.enabled === enabled) return;
    await invokeOnce(() => this.#repository.setNotificationState(this.#db, {
      enabled,
      expectedRevision: before.revision,
      updatedAtMs: nowMs,
    }));
    const after = await this.#status.readNotification();
    if (after.enabled === enabled && after.revision === before.revision + 1) return;
    if (after.enabled === before.enabled && after.revision === before.revision) {
      throw new MaintenanceError('mutation-not-confirmed');
    }
    throw new MaintenanceError('contradictory-state');
  }

  #invitationPurpose(principal: PrincipalStatus): 'initial' | 'replacement' {
    if (principal.state === 'unfilled') return 'initial';
    if (
      principal.state === 'reset'
      && principal.credentialState === 'revoked'
      && principal.generation !== null
      && principal.credentialGeneration === principal.generation
    ) return 'replacement';
    throw new MaintenanceError('invitation-unavailable');
  }

  #isActive(principal: PrincipalStatus): boolean {
    return principal.state === 'active'
      && principal.generation !== null
      && principal.credentialState === 'active'
      && principal.credentialGeneration === principal.generation;
  }
}
