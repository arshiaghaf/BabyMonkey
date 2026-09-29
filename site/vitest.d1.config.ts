import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cloudflareTest,
  readD1Migrations,
} from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(projectRoot, 'migrations'),
  );

  return {
    resolve: {
      alias: {
        '@': projectRoot,
        'server-only': path.join(projectRoot, 'd1-tests/server-only.ts'),
      },
    },
    plugins: [
      cloudflareTest({
        miniflare: {
          compatibilityDate: '2026-08-23',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['TEST_DB'],
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      include: ['d1-tests/**/*.test.ts'],
      setupFiles: ['./d1-tests/apply-migrations.ts'],
    },
  };
});
