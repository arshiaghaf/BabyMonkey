import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const readSourceTree = (directory: string): string => readdirSync(directory, {
  withFileTypes: true,
}).flatMap((entry) => {
  const entryPath = path.join(directory, entry.name);
  if (entry.isDirectory()) return readSourceTree(entryPath);
  return /\.(?:[cm]?[jt]sx?|jsonc?)$/.test(entry.name)
    ? [readFileSync(entryPath, 'utf8')]
    : [];
}).join('\n');

describe('D1 foundation execution boundary', () => {
  it('exposes only bounded repositories through server routes and keeps relay activation server-only', () => {
    const root = process.cwd();
    const routeSource = readSourceTree(path.join(root, 'app'));
    const clientSource = [
      readSourceTree(path.join(root, 'components')),
      readSourceTree(path.join(root, 'lib')),
    ].join('\n');
    const workerConfig = readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8');
    const repositorySource = readFileSync(
      path.join(root, 'server/d1/repository.ts'),
      'utf8',
    );
    const deliveryBoundarySource = readFileSync(
      path.join(root, 'server/signal/delivery-boundary.ts'),
      'utf8',
    );
    const mtlsDeliverySource = readFileSync(
      path.join(root, 'server/signal/mtls-delivery-boundary.ts'),
      'utf8',
    );
    const signalRuntimeSource = readFileSync(
      path.join(root, 'server/signal/runtime.ts'),
      'utf8',
    );

    expect(clientSource).not.toMatch(/server\/d1|D1Database/i);
    expect(routeSource).not.toMatch(
      /createInvitation|revokeInvitation|resetPrincipalEnrollment|setNotificationState/i,
    );
    expect(workerConfig).toContain('"database_id": "00000000-0000-0000-0000-000000000000"');
    expect(workerConfig).not.toMatch(/"remote"\s*:\s*true/i);
    expect(`${routeSource}
${clientSource}`).not.toMatch(/createInvitation|setNotificationState|maintenance\/maintenance-cli/i);
    expect(repositorySource.startsWith("import 'server-only';")).toBe(true);
    expect(deliveryBoundarySource.startsWith("import 'server-only';")).toBe(true);
    expect(deliveryBoundarySource).not.toMatch(
      /\bfetch\b|https?:|telegram|relay|mtls|credential|binding|process\.env|cloudflare:workers/i,
    );
    expect(mtlsDeliverySource.startsWith("import 'server-only';")).toBe(true);
    expect(mtlsDeliverySource).toContain('binding.fetch(request)');
    expect(mtlsDeliverySource).not.toMatch(
      /globalThis\.fetch|(?<!\.)\bfetch\s*\(|authorization|bearer|api[_-]?key|secret|telegram|destination|recipient|process\.env/i,
    );
    expect(signalRuntimeSource).toContain('BABYMONKEY_RELAY_MTLS');
    expect(signalRuntimeSource).toContain('BABYMONKEY_RELAY_ORIGIN');
    expect(signalRuntimeSource).toContain("process.env.NODE_ENV === 'development'");
    expect(signalRuntimeSource).not.toMatch(/globalThis\.fetch/i);
    expect(workerConfig).not.toContain('BABYMONKEY_RELAY_ORIGIN');
    expect(`${routeSource}\n${clientSource}`).not.toMatch(
      /BABYMONKEY_RELAY|edge\.owner\.co|certificate_id|mtls_certificates/i,
    );
    expect(workerConfig).not.toMatch(
      /TELEGRAM|CLOUDFLARE_(?:API_KEY|API_TOKEN)|BEGIN (?:CERTIFICATE|PRIVATE KEY)|secrets_store/i,
    );
  });
});
