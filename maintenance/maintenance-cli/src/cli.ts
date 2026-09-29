import process from 'node:process';

import { copyInvitationToClipboard } from './clipboard.ts';
import { createMaintenanceService } from './composition.ts';
import { MaintenanceError, publicErrorMessage } from './errors.ts';
import type { MaintenanceService } from './operations.ts';
import { registerSessionSignalHandlers, runAuthenticatedMenu } from './session.ts';
import {
  createJournalStore,
  defaultLocalPaths,
  loadConfig,
  LocalSessionLock,
  parseConfig,
  saveConfig,
  type LocalPaths,
  type MaintenanceConfig,
} from './storage.ts';
import {
  assertClosedInteractiveInvocation,
  createTextTerminal,
  readSecretBytes,
  TokenVault,
  type TextTerminal,
} from './terminal.ts';
import type { InvitationRecord, MaintenanceSnapshot, Slot } from './types.ts';

export { publicErrorMessage };

const SESSION_TIMEOUT_MS = 15 * 60 * 1000;
const QUESTION_TIMEOUT_MS = 5 * 60 * 1000;
const SECRET_TIMEOUT_MS = 2 * 60 * 1000;
const CLIPBOARD_TIMEOUT_MS = 10_000;

export interface MaintenanceCliOptions {
  paths?: LocalPaths;
  questionTimeoutMs?: number;
  secretTimeoutMs?: number;
  sessionTimeoutMs?: number;
}

const slotName = (slot: Slot): string => (
  slot === 1 ? 'Owner (slot 1)' : 'Participant (slot 2)'
);

const selectSlot = async (terminal: TextTerminal): Promise<Slot> => {
  terminal.write('1. Owner (slot 1)\n2. Participant (slot 2)\n');
  const answer = (await terminal.question('Select slot: ')).trim();
  if (answer === '1') return 1;
  if (answer === '2') return 2;
  throw new MaintenanceError('cancelled');
};

const confirmExact = async (
  terminal: TextTerminal,
  explanation: string,
  phrase: string,
): Promise<void> => {
  terminal.write(`\n${explanation}\n`);
  const answer = await terminal.question(`Type exactly "${phrase}" to continue: `);
  if (answer !== phrase) throw new MaintenanceError('cancelled');
};

const readConfigInteractively = async (
  terminal: TextTerminal,
  configPath: string,
): Promise<MaintenanceConfig> => {
  const existing = await loadConfig(configPath);
  if (existing) return existing;
  terminal.write('No local nonsecret configuration was found.\n');
  const accountId = (await terminal.question('Cloudflare account identifier: ')).trim();
  const databaseId = (await terminal.question('Cloudflare D1 database identifier: ')).trim();
  const origin = (await terminal.question('Trusted application HTTPS origin: ')).trim();
  const config = parseConfig({ schemaVersion: 1, accountId, databaseId, origin });
  const persist = (await terminal.question(
    'Save these nonsecret identifiers in the mode-600 local configuration? [y/N] ',
  )).trim().toLowerCase();
  if (persist === 'y' || persist === 'yes') await saveConfig(configPath, config);
  return config;
};

const renderStatus = (terminal: TextTerminal, snapshot: MaintenanceSnapshot): void => {
  terminal.write('\nMaintenance status\n');
  for (const principal of snapshot.principals) {
    const generation = principal.generation === null ? 'not assigned' : String(principal.generation);
    terminal.write(
      `- ${slotName(principal.slot)}: ${principal.state}; generation ${generation}; `
      + `${principal.activeSessions} active session(s)\n`,
    );
  }
  terminal.write(
    `- Notifications: ${snapshot.notification.enabled ? 'enabled' : 'disabled'} `
    + `(revision ${snapshot.notification.revision})\n`,
  );
  terminal.write(`- Outstanding unexpired invitations: ${snapshot.invitations.length}\n\n`);
};

const selectInvitation = async (
  terminal: TextTerminal,
  service: MaintenanceService,
): Promise<InvitationRecord> => {
  const invitations = (await service.readStatus()).invitations;
  if (invitations.length === 0) throw new MaintenanceError('invitation-unavailable');
  terminal.write('\nOutstanding invitations\n');
  invitations.forEach((invitation, index) => {
    terminal.write(
      `${index + 1}. I-${index + 1} — ${slotName(invitation.slot)}, ${invitation.purpose}, `
      + `expires ${new Date(invitation.expiresAtMs).toISOString()}\n`,
    );
  });
  const answer = Number((await terminal.question('Select opaque invitation handle: ')).trim());
  if (!Number.isInteger(answer) || answer < 1 || answer > invitations.length) {
    throw new MaintenanceError('cancelled');
  }
  return invitations[answer - 1];
};

const createInvitationAction = async (
  terminal: TextTerminal,
  service: MaintenanceService,
  sessionSignal: AbortSignal,
): Promise<void> => {
  const slot = await selectSlot(terminal);
  await confirmExact(
    terminal,
    `Create a 24-hour invitation for ${slotName(slot)}. The raw token will be shown once.`,
    `CREATE INVITATION FOR SLOT ${slot}`,
  );
  const presentation = await service.createInvitation(slot);
  try {
    terminal.write('\nInvitation committed and reconciled. Displaying once:\n');
    terminal.write(`${presentation.url}\n`);
    await service.markInvitationPresented(presentation.invitationId);
    const copy = (await terminal.question(
      'Copy this invitation explicitly to the macOS clipboard? Clipboard secrecy is not guaranteed. [y/N] ',
    )).trim().toLowerCase();
    if (copy === 'y' || copy === 'yes') {
      await copyInvitationToClipboard(presentation.url, {
        signal: sessionSignal,
        timeoutMs: CLIPBOARD_TIMEOUT_MS,
      });
      terminal.write('Copied by explicit request.\n');
    }
  } finally {
    presentation.url = '';
  }
};

const runMenuAction = async (
  choice: string,
  terminal: TextTerminal,
  service: MaintenanceService,
  sessionSignal: AbortSignal,
): Promise<boolean> => {
  if (choice === '1') {
    renderStatus(terminal, await service.readStatus());
  } else if (choice === '2') {
    await createInvitationAction(terminal, service, sessionSignal);
  } else if (choice === '3') {
    const selected = await selectInvitation(terminal, service);
    await confirmExact(
      terminal,
      `Revoke the selected ${selected.purpose} invitation for ${slotName(selected.slot)}.`,
      `REVOKE SELECTED INVITATION FOR SLOT ${selected.slot}`,
    );
    await service.revokeInvitation(selected);
    terminal.write('Invitation revocation confirmed.\n');
  } else if (choice === '4') {
    const slot = await selectSlot(terminal);
    await confirmExact(
      terminal,
      `Reset ${slotName(slot)}: revoke credential authorization, sessions, and operational state.`,
      `RESET SLOT ${slot} AND REVOKE ITS AUTHORIZATION`,
    );
    await service.resetPrincipal(slot);
    terminal.write('Principal reset confirmed.\n');
  } else if (choice === '5') {
    const slot = await selectSlot(terminal);
    await confirmExact(
      terminal,
      `Advance ${slotName(slot)} by exactly one authorization generation and revoke its sessions.`,
      `ADVANCE SLOT ${slot} BY ONE GENERATION`,
    );
    await service.advanceGeneration(slot);
    terminal.write('Monotonic generation advancement confirmed.\n');
  } else if (choice === '6') {
    const slot = await selectSlot(terminal);
    await confirmExact(
      terminal,
      `Revoke every active session for ${slotName(slot)} only.`,
      `REVOKE ALL SESSIONS FOR SLOT ${slot}`,
    );
    await service.revokePrincipalSessions(slot);
    terminal.write('Session revocation confirmed.\n');
  } else if (choice === '7') {
    const current = (await service.readStatus()).notification;
    const enabled = !current.enabled;
    const consequence = enabled
      ? 'Re-enable notification delivery deliberately.'
      : 'Disable notification delivery.';
    await confirmExact(
      terminal,
      `${consequence} Current revision: ${current.revision}.`,
      `${enabled ? 'ENABLE' : 'DISABLE'} NOTIFICATIONS AT REVISION ${current.revision}`,
    );
    await service.setNotifications(enabled, current.revision);
    terminal.write(`Notifications ${enabled ? 'enabled' : 'disabled'} at the next revision.\n`);
  } else if (choice === '8') {
    return false;
  } else {
    throw new MaintenanceError('cancelled');
  }
  return true;
};

const menu = `
1. Read minimal maintenance status
2. Create an initial or replacement invitation for one fixed slot
3. Revoke one outstanding invitation
4. Reset one principal's authorization and revoke that slot's sessions
5. Advance one active principal's authorization generation
6. Revoke all active sessions for one principal
7. Disable or deliberately re-enable notifications
8. Exit
`;

export const runMaintenanceCli = async (
  options: MaintenanceCliOptions = {},
): Promise<void> => {
  assertClosedInteractiveInvocation({
    argv: process.argv,
    env: process.env,
    stdinIsTty: process.stdin.isTTY === true,
    stdoutIsTty: process.stdout.isTTY === true,
    stderrIsTty: process.stderr.isTTY === true,
  });

  const session = new AbortController();
  let vault: TokenVault | null = null;
  const abort = () => {
    vault?.destroy();
    session.abort();
  };
  let sessionTimedOut = false;
  const timer = setTimeout(() => {
    sessionTimedOut = true;
    abort();
  }, options.sessionTimeoutMs ?? SESSION_TIMEOUT_MS);
  const removeSignalHandlers = registerSessionSignalHandlers(process, abort);
  let terminal: TextTerminal | null = createTextTerminal(
    process.stdin,
    process.stdout,
    process.stderr,
    session.signal,
    options.questionTimeoutMs ?? QUESTION_TIMEOUT_MS,
  );
  const paths = options.paths ?? defaultLocalPaths();
  const lock = new LocalSessionLock(paths.lockPath, { onLost: abort });
  try {
    await lock.acquire();
    const config = await readConfigInteractively(terminal, paths.configPath);
    terminal.close();
    terminal = null;
    const tokenBytes = await readSecretBytes(process.stdin, process.stdout, {
      timeoutMs: options.secretTimeoutMs ?? SECRET_TIMEOUT_MS,
      signal: session.signal,
    });
    vault = new TokenVault(tokenBytes);
    terminal = createTextTerminal(
      process.stdin,
      process.stdout,
      process.stderr,
      session.signal,
      options.questionTimeoutMs ?? QUESTION_TIMEOUT_MS,
    );
    const service = createMaintenanceService(
      config,
      vault,
      createJournalStore(paths.journalPath),
      session.signal,
    );
    const recovered = await service.recoverInvitationJournal();
    if (recovered.revoked > 0) {
      terminal.write(
        `Revoked ${recovered.revoked} committed invitation(s) that were never presented.\n`,
      );
    }
    for (const slot of recovered.quarantinedSlots) {
      terminal.write(
        `Invitation creation for slot ${slot} remains quarantined pending reconciliation or expiry.\n`,
      );
    }
    const authenticatedTerminal = terminal;
    await runAuthenticatedMenu({
      menu,
      runAction: async (choice) => runMenuAction(
        choice,
        authenticatedTerminal,
        service,
        session.signal,
      ),
      signal: session.signal,
      terminal: authenticatedTerminal,
      token: vault,
    });
    if (session.signal.aborted) {
      throw new MaintenanceError(sessionTimedOut ? 'session-timeout' : 'cancelled');
    }
  } finally {
    vault?.destroy();
    session.abort();
    clearTimeout(timer);
    terminal?.close();
    await lock.release();
    removeSignalHandlers();
  }
};
