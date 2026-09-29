import {
  advancePrincipalGeneration,
  createInvitation,
  resetPrincipalAuthorization,
  revokeInvitation,
  revokePrincipalSessions,
  setNotificationState,
} from '../../../site/server/d1/repository.ts';
import { createD1RestDatabase } from '../../d1-rest-adapter/src/index.ts';

import { MaintenanceService } from './operations.ts';
import { createStatusReader } from './status.ts';
import type { JournalStore, RepositoryApi } from './types.ts';
import type { MaintenanceConfig } from './storage.ts';
import type { TokenVault } from './terminal.ts';
import { createCloudflareTransport } from './transport.ts';

const repository: RepositoryApi = {
  advancePrincipalGeneration,
  createInvitation,
  resetPrincipalAuthorization,
  revokeInvitation,
  revokePrincipalSessions,
  setNotificationState,
};

export const createMaintenanceService = (
  config: MaintenanceConfig,
  token: TokenVault,
  journal: JournalStore,
  sessionSignal: AbortSignal,
): MaintenanceService => {
  const db = createD1RestDatabase({
    transport: createCloudflareTransport(config, token, sessionSignal),
    timeoutMs: 30_000,
  });
  return new MaintenanceService({
    db,
    invitationOrigin: config.origin,
    status: createStatusReader(db),
    repository,
    journal,
  });
};
