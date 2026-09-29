import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = path.resolve(packageRoot, '..', '..');

const filesBelow = async (directory) => {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.npm-cache', '.next', '.open-next', '.wrangler', 'test-results', 'tests', 'd1-tests', 'e2e', 'relay-tests'].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesBelow(target));
    else if (entry.isFile()) output.push(target);
  }
  return output;
};

const siteFiles = await filesBelow(path.join(repositoryRoot, 'site'));
for (const file of siteFiles) {
  if (!/\.(?:[cm]?[jt]sx?|json)$/.test(file)) continue;
  const contents = await readFile(file, 'utf8');
  if (/maintenance-cli|maintenance\/d1-rest-adapter|d1-rest-adapter/.test(contents)) {
    throw new Error('A site file calls the maintenance boundary.');
  }
}

const packageFiles = await filesBelow(packageRoot);
for (const file of packageFiles) {
  const contents = await readFile(file, 'utf8').catch(() => '');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(contents)) {
    throw new Error('Private key material detected.');
  }
  if (/\b(?:sk|pk)_[a-z]+_[A-Za-z0-9]{24,}\b/.test(contents)) {
    throw new Error('Credential-shaped material detected.');
  }
  if (/https:\/\/[a-z0-9.-]+\/invite#[A-Za-z0-9_-]{43}/.test(contents)) {
    throw new Error('A complete raw invitation fixture was retained.');
  }
}

const example = JSON.parse(await readFile(path.join(packageRoot, 'config.example.json'), 'utf8'));
if (Object.keys(example).sort().join(',') !== 'accountId,databaseId,origin,schemaVersion') {
  throw new Error('The committed configuration example contains an unexpected field.');
}

process.stdout.write('Leakage and no-caller inspection passed.\n');
