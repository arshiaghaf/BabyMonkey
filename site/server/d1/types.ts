export type PrincipalSlot = 1 | 2;
export type InvitationPurpose = 'initial' | 'replacement';

export type D1Bindable = ArrayBuffer | ArrayBufferView | string | number | null;

export interface D1ResultLike<T = Record<string, unknown>> {
  success?: boolean;
  results?: T[];
  meta?: {
    changes?: number;
  };
}

export interface D1PreparedStatementLike {
  bind(...values: D1Bindable[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatementLike[],
  ): Promise<D1ResultLike<T>[]>;
}

export interface SyntheticCredential {
  identifier: ArrayBuffer | ArrayBufferView;
  verificationMaterial: ArrayBuffer | ArrayBufferView;
}

export interface InvitationEligibility {
  eligible: boolean;
  invitationId?: string;
}

export interface NotificationEligibility {
  eligible: boolean;
  revision?: number;
}

export type PrincipalSessionRevocationResult =
  | { confirmed: true; revoked: number }
  | { confirmed: false };

export interface CleanupResult {
  invitations: number;
  sessions: number;
  operationalReservations: number;
}
