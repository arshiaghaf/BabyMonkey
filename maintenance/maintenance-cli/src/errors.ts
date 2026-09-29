export type MaintenanceErrorCode =
  | 'cancelled'
  | 'clipboard-failed'
  | 'configuration-invalid'
  | 'configuration-permissions'
  | 'contradictory-state'
  | 'invitation-unavailable'
  | 'lock-held'
  | 'mutation-not-confirmed'
  | 'noninteractive'
  | 'secret-input-failed'
  | 'sensitive-input-rejected'
  | 'session-timeout'
  | 'status-unavailable';

const messages: Record<MaintenanceErrorCode, string> = {
  cancelled: 'The maintenance session was cancelled.',
  'clipboard-failed': 'The explicit clipboard copy did not complete.',
  'configuration-invalid': 'The local maintenance configuration is invalid.',
  'configuration-permissions': 'The local maintenance file permissions are unsafe.',
  'contradictory-state': 'Authoritative state is contradictory; this action is blocked.',
  'invitation-unavailable': 'An invitation cannot be created for that slot now.',
  'lock-held': 'Another local BabyMonkey maintenance session is active.',
  'mutation-not-confirmed': 'The requested change was not confirmed; it was not retried.',
  noninteractive: 'BabyMonkey maintenance requires one attached interactive TTY.',
  'secret-input-failed': 'The Cloudflare token was not accepted from the attached TTY.',
  'sensitive-input-rejected': 'Sensitive argv or environment input is not accepted.',
  'session-timeout': 'The bounded maintenance session timed out.',
  'status-unavailable': 'Authoritative maintenance status is unavailable.',
};

export class MaintenanceError extends Error {
  readonly code: MaintenanceErrorCode;

  constructor(code: MaintenanceErrorCode) {
    super(messages[code]);
    this.name = 'MaintenanceError';
    this.code = code;
  }
}

export const publicErrorMessage = (error: unknown): string => (
  error instanceof MaintenanceError
    ? error.message
    : 'BabyMonkey maintenance stopped safely after an unexpected local error.'
);
