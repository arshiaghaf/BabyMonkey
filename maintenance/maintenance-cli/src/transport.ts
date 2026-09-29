import type { D1RestTransport } from '../../d1-rest-adapter/src/index.ts';

import type { MaintenanceConfig } from './storage.ts';
import type { TokenVault } from './terminal.ts';

export type FetchImplementation = typeof fetch;

export const createCloudflareTransport = (
  config: MaintenanceConfig,
  token: TokenVault,
  sessionSignal: AbortSignal,
  fetchImplementation: FetchImplementation = fetch,
): D1RestTransport => {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}/query`;
  return async (request) => {
    let authorization: string | undefined = token.authorizationHeader();
    try {
      return await fetchImplementation(endpoint, {
        method: request.method,
        redirect: 'manual',
        headers: {
          ...request.headers,
          authorization,
        },
        body: request.body,
        signal: AbortSignal.any([request.signal, sessionSignal]),
      });
    } finally {
      authorization = undefined;
    }
  };
};
