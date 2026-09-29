import type { D1DatabaseLike, PrincipalSlot } from '../../../site/server/d1/types.ts';

export type Slot = PrincipalSlot;
export type InvitationPurpose = 'initial' | 'replacement';

export interface PrincipalStatus {
  slot: Slot;
  state: 'unfilled' | 'active' | 'reset';
  generation: number | null;
  credentialState: 'active' | 'revoked' | null;
  credentialGeneration: number | null;
  activeSessions: number;
  operationalReservations: number;
}

export interface InvitationRecord {
  invitationId: string;
  tokenHash: string;
  slot: Slot;
  purpose: InvitationPurpose;
  requiredGeneration: number | null;
  createdAtMs: number;
  expiresAtMs: number;
  revokedAtMs: number | null;
  consumedAtMs: number | null;
}

export interface NotificationStatus {
  enabled: boolean;
  revision: number;
}

export interface MaintenanceSnapshot {
  principals: [PrincipalStatus, PrincipalStatus];
  invitations: InvitationRecord[];
  notification: NotificationStatus;
}

export interface StatusReader {
  readSnapshot(nowMs: number): Promise<MaintenanceSnapshot>;
  readPrincipal(slot: Slot, nowMs: number): Promise<PrincipalStatus>;
  readInvitationById(invitationId: string): Promise<InvitationRecord | null>;
  readOutstandingInvitations(slot: Slot, nowMs: number): Promise<InvitationRecord[]>;
  readNotification(): Promise<NotificationStatus>;
}

export interface RepositoryApi {
  createInvitation(db: D1DatabaseLike, input: {
    invitationId: string;
    tokenHash: string;
    slot: Slot;
    purpose: InvitationPurpose;
    createdAtMs: number;
    expiresAtMs: number;
  }): Promise<boolean>;
  revokeInvitation(
    db: D1DatabaseLike,
    tokenHash: string,
    revokedAtMs: number,
  ): Promise<boolean>;
  resetPrincipalAuthorization(
    db: D1DatabaseLike,
    slot: Slot,
    nowMs: number,
  ): Promise<boolean>;
  advancePrincipalGeneration(
    db: D1DatabaseLike,
    slot: Slot,
    nowMs: number,
  ): Promise<boolean>;
  revokePrincipalSessions(
    db: D1DatabaseLike,
    slot: Slot,
    revokedAtMs: number,
  ): Promise<{ confirmed: true; revoked: number } | { confirmed: false }>;
  setNotificationState(db: D1DatabaseLike, input: {
    enabled: boolean;
    expectedRevision: number;
    updatedAtMs: number;
  }): Promise<boolean>;
}

export interface JournalEntry {
  invitationId: string;
  tokenHash: string;
  slot: Slot;
  purpose: InvitationPurpose;
  createdAtMs: number;
  expiresAtMs: number;
  state: 'pending' | 'committed' | 'presented';
}

export interface JournalStore {
  list(): Promise<JournalEntry[]>;
  replace(entry: JournalEntry): Promise<void>;
  remove(invitationId: string): Promise<void>;
}

export interface InvitationPresentation {
  invitationId: string;
  url: string;
}
