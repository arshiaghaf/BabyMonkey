import { createCloudflareTransport } from '../src/transport.ts';
import { TokenVault } from '../src/terminal.ts';

describe('fixed Cloudflare transport', () => {
  it('constructs the one fixed query endpoint and keeps authorization out of errors', async () => {
    const secret = randomBytes(24).toString('base64url');
    const vault = new TokenVault(Buffer.from(secret));
    const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const inputUrl = typeof input === 'string'
        ? input
        : input instanceof URL ? input.href : input.url;
      calls.push({ input: inputUrl, init });
      throw new Error('provider denial');
    };
    const transport = createCloudflareTransport({
      schemaVersion: 1,
      accountId: 'a'.repeat(32),
      databaseId: '12345678-1234-4123-8123-123456789abc',
      origin: 'https://app.owner.org',
    }, vault, new AbortController().signal, fetcher);
    await expect(transport({
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      signal: new AbortController().signal,
    })).rejects.toThrow('provider denial');
    expect(calls[0]?.input).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/d1/database/12345678-1234-4123-8123-123456789abc/query`,
    );
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: `Bearer ${secret}` });
    expect(JSON.stringify(calls[0])).not.toContain('provider denial');
    vault.destroy();
  });
});
import { randomBytes } from 'node:crypto';
