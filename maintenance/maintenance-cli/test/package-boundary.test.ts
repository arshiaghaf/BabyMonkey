import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

describe('closed package boundary', () => {
  it('has no executable bin, runtime dependency, generic command, or arbitrary SQL input', async () => {
    const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(packageJson.bin).toBeUndefined();
    expect(packageJson.dependencies).toBeUndefined();
    const cli = await readFile(path.join(root, 'src/cli.ts'), 'utf8');
    expect(cli).not.toMatch(/--(?:sql|query|token|url|command)|process\.argv\[2\]/);
    expect(cli).not.toContain('http.createServer');
    expect(cli).not.toContain('listen(');
  });

  it('acquires the session lock before shared configuration access', async () => {
    const cli = await readFile(path.join(root, 'src/cli.ts'), 'utf8');
    const lockAcquisition = cli.indexOf('await lock.acquire()');
    const configurationAccess = cli.indexOf('await readConfigInteractively(');
    expect(lockAcquisition).toBeGreaterThanOrEqual(0);
    expect(configurationAccess).toBeGreaterThanOrEqual(0);
    expect(lockAcquisition).toBeLessThan(configurationAccess);
  });

  it('composes every mutation from the landed repository exports', async () => {
    const composition = await readFile(path.join(root, 'src/composition.ts'), 'utf8');
    for (const operation of [
      'createInvitation', 'revokeInvitation', 'resetPrincipalAuthorization',
      'advancePrincipalGeneration', 'revokePrincipalSessions', 'setNotificationState',
    ]) {
      expect(composition).toContain(operation);
    }
    expect(composition).toContain("site/server/d1/repository.ts");
    expect(composition).toContain("d1-rest-adapter/src/index.ts");
  });
});
