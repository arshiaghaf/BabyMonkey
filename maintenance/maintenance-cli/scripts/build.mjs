import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

await build({
  absWorkingDir: packageRoot,
  alias: {
    'server-only': path.join(packageRoot, 'src/server-only.ts'),
  },
  bundle: true,
  entryPoints: ['src/entry.ts'],
  format: 'esm',
  legalComments: 'none',
  minify: false,
  outfile: 'dist/maintenance-cli.mjs',
  packages: 'bundle',
  platform: 'node',
  sourcemap: false,
  target: 'node22',
});
