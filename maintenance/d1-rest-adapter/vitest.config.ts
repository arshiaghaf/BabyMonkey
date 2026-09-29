import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      'server-only': path.join(packageRoot, 'test/server-only.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
