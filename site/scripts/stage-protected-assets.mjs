import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const assets = {
  '6xP9jFbD2mQvL7aWrN4tYsHkC8eZuG1o': 'ready-monkey.png',
  'cR5uX1nK8pAeM3vHtQ7sZyD9wL2bGjFo': 'pending-monkey.png',
  'mT8qV3aLsD1yK6nWpR9cXeF4uH7zBjGo': 'confirmed-monkey.png',
  'wN2dH7pZ4rK9sMfC1xQaV6uLtG8yEjBo': 'cooldown-monkey.png',
  'aK7vQ2eFmR9xL4sUwD1nY6pHtC8zGjBo': 'definitive-failure-monkey.png',
  'zF4mL9qX2tV7cDsR1nH8wKaU6pYeGjBo': 'ambiguous-outcome-monkey.png',
  'hD9sW3nQ6kX1vLaR8tF2mYpC7uZeGjBo': 'ready-monkey-head.png',
};

const projectRoot = process.cwd();
const destination = path.join(projectRoot, '.open-next', 'assets', '__bm_private');
await mkdir(destination, { recursive: true });
await Promise.all(Object.entries(assets).map(([assetId, filename]) => copyFile(
  path.join(projectRoot, 'protected-assets', 'monkey', filename),
  path.join(destination, `${assetId}.png`),
)));
