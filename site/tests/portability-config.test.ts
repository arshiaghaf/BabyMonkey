import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
const root = process.cwd();
const config = JSON.parse(readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'));
describe('local Wrangler boundary', () => {
  it('uses only isolated local D1 with no live relay or production route', () => {
    expect(config.d1_databases).toEqual([{ binding: 'DB', database_name: 'babymonkey-local', database_id: '00000000-0000-0000-0000-000000000000', remote: false }]);
    expect(config.env).toBeUndefined();
    expect(config.routes).toBeUndefined();
    expect(config.mtls_certificates).toBeUndefined();
    expect(config.vars).toEqual({ BABYMONKEY_RP_ID: 'localhost', BABYMONKEY_ORIGIN: 'http://localhost:3000' });
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
  });
});
