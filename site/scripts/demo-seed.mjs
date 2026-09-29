import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// Never reads, resets, or follows project .wrangler state. Every run owns a fresh OS scratch directory.
export async function createDemoSeed(root) {
  const config = JSON.parse(readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'));
  if (config.d1_databases?.[0]?.database_id !== '00000000-0000-0000-0000-000000000000' || config.d1_databases?.[0]?.remote !== false || config.vars?.BABYMONKEY_ORIGIN !== 'http://localhost:3000' || config.mtls_certificates || config.routes) throw new Error('Demo requires the provider-free local configuration.');
  // Refuse redirected legacy state ancestors before even allocating synthetic state.
  for (const relative of ['.wrangler', '.wrangler/state', '.wrangler/state/v3']) {
    try { const entry = await lstat(path.join(root, relative)); if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Unsafe redirected local state ancestor.'); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
  const temporaryRoot = await realpath(os.tmpdir());
  const parent = process.env.BABYMONKEY_DEMO_PARENT_STATE;
  if (parent) {
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700 || await realpath(parent) !== parent || path.dirname(parent) !== temporaryRoot || !path.basename(parent).startsWith('babymonkey-demo-run-')) throw new Error('Unsafe parent-owned demo directory.');
  }
  const stateRoot = parent ?? temporaryRoot;
  const stateDir = await mkdtemp(path.join(stateRoot, 'babymonkey-demo-'));
  const dispose = async () => {
    if (await realpath(stateDir) !== stateDir || path.dirname(stateDir) !== stateRoot || !path.basename(stateDir).startsWith('babymonkey-demo-')) throw new Error('Unsafe demo cleanup path.');
    await rm(stateDir, { recursive: true });
  };
  const run = (args) => {
    const result = spawnSync(path.join(root, 'node_modules', '.bin', 'wrangler'), [...args, '--local', '--persist-to', stateDir], { cwd: root, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false' } });
    if (result.status !== 0) throw new Error('Local D1 command failed: ' + (result.stderr || result.stdout));
  };
  try {
    run(['d1','migrations','apply','babymonkey-local']);
    const now = Date.now();
    const invitations = [1,2].map((slot) => { const token = randomBytes(32).toString('base64url'); return { slot, token, hash: createHash('sha256').update(token).digest('hex'), id: randomBytes(18).toString('base64url') }; });
    const values = invitations.map(({slot, hash, id}) => `('${id}','${hash}',${slot},'initial',NULL,${now},${now+3_600_000})`).join(',');
    run(['d1','execute','babymonkey-local','--command',`INSERT INTO invitations (invitation_id,token_hash,principal_slot,purpose,required_generation,created_at_ms,expires_at_ms) VALUES ${values}; UPDATE notification_control SET enabled=1,revision=revision+1,updated_at_ms=${now} WHERE singleton=1 AND enabled=0`]);
    return { stateDir, invitations, dispose };
  } catch (error) { await dispose(); throw error; }
}
