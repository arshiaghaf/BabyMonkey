import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { statePresentations } from '../lib/babymonkey-states';

const forbiddenDevelopmentStyleMarkers = [
  '--babymonkey-local-preview-style',
  '.local-preview-controls',
  '.preview-state-buttons',
  '.show-preview-controls',
  '.hide-preview-controls',
] as const;

const forbiddenInfrastructureValueMarkers = [
  '-----BEGIN PRIVATE KEY-----',
  '-----BEGIN CERTIFICATE-----',
  'CLOUDFLARE_API_KEY',
  'CLOUDFLARE_API_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'api.telegram.org',
  'babymonkey-production',
  'BABYMONKEY_RELAY_MTLS',
  'BABYMONKEY_RELAY_ORIGIN',
] as const;

const protectedPresentationCopy = Object.values(statePresentations).flatMap(
  ({ detail, interactionHint, recoveryLabel, title }) =>
    [title, detail, interactionHint, recoveryLabel].filter(
      (value): value is string => Boolean(value),
    ),
);

export const forbiddenProtectedContentMarkers = Array.from(new Set([
  ...protectedPresentationCopy,
  'Ask the recipient to reach out gently',
  'Reveal whether the little monkey was sent',
  'Sign out',
  'Local visual preview',
  'No notification is sent.',
]));

const textArtifactExtensions = [
  '.css',
  '.html',
  '.js',
  '.json',
  '.map',
  '.mjs',
  '.rsc',
  '.txt',
] as const;

export const protectedArtworkFilenames = [
  'ambiguous-outcome-monkey.png',
  'confirmed-monkey.png',
  'cooldown-monkey.png',
  'definitive-failure-monkey.png',
  'pending-monkey.png',
  'ready-monkey-head.png',
  'ready-monkey.png',
  'storybook-badge.png',
] as const;

export const forbiddenPublicArtworkPaths = protectedArtworkFilenames.flatMap(
  (filename) => [
    `/assets/monkey/${filename}`,
    `/__preview-assets/monkey/${filename}`,
  ],
);

async function findFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return findFiles(entryPath);
      return entry.isFile() ? [entryPath] : [];
    }),
  );

  return paths.flat().sort();
}

export async function expectDevelopmentStylesExcluded(directory: string) {
  const cssFiles = (await findFiles(directory)).filter((file) => file.endsWith('.css'));
  expect(cssFiles.length, `CSS artifacts under ${directory}`).toBeGreaterThan(0);

  for (const cssFile of cssFiles) {
    const contents = await readFile(cssFile, 'utf8');
    for (const marker of forbiddenDevelopmentStyleMarkers) {
      expect(contents, `${marker} leaked into ${cssFile}`).not.toContain(marker);
    }
  }
}

export async function expectProtectedContentExcluded(directory: string) {
  const artifactFiles = (await findFiles(directory)).filter((file) =>
    textArtifactExtensions.some((extension) => file.endsWith(extension)),
  );
  expect(artifactFiles.length, `text artifacts under ${directory}`).toBeGreaterThan(0);

  for (const artifactFile of artifactFiles) {
    const contents = await readFile(artifactFile, 'utf8');
    expectProtectedContentExcludedFromText(contents, artifactFile);
  }
}

export async function expectInfrastructureValuesExcluded(directory: string) {
  const artifactFiles = (await findFiles(directory)).filter((file) =>
    textArtifactExtensions.some((extension) => file.endsWith(extension)),
  );
  expect(artifactFiles.length, `text artifacts under ${directory}`).toBeGreaterThan(0);

  for (const artifactFile of artifactFiles) {
    const contents = await readFile(artifactFile, 'utf8');
    expectInfrastructureValuesExcludedFromText(contents, artifactFile);
  }
}

export async function expectProtectedArtworkExcluded(directory: string) {
  const protectedFilenames = new Set<string>(protectedArtworkFilenames);
  const leakedArtwork = (await findFiles(directory)).filter((file) =>
    protectedFilenames.has(path.basename(file)),
  );

  expect(leakedArtwork, `protected artwork under ${directory}`).toEqual([]);
}

export async function expectSourceMapsExcluded(directory: string) {
  const sourceMaps = (await findFiles(directory)).filter((file) => file.endsWith('.map'));
  expect(sourceMaps, `source maps under ${directory}`).toEqual([]);
}

export function expectProtectedContentExcludedFromText(
  contents: string,
  label: string,
) {
  for (const marker of forbiddenProtectedContentMarkers) {
    expect(contents, `${marker} leaked into ${label}`).not.toContain(marker);
  }
}

export function expectInfrastructureValuesExcludedFromText(
  contents: string,
  label: string,
) {
  for (const marker of forbiddenInfrastructureValueMarkers) {
    expect(contents, `${marker} leaked into ${label}`).not.toContain(marker);
  }
}
