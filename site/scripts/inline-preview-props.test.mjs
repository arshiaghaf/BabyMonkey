import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { inlinePreviewProps } from './inline-preview-props.mjs';

const manifest = {
  previewModeId: 'synthetic-id',
  previewModeSigningKey: 'synthetic-signing',
  previewModeEncryptionKey: 'synthetic-encryption',
};
const bundle = 'function loadManifest(path2) { if (path2.endsWith("/known-manifest.json")) return {known:true}; throw new Error(`Unexpected loadManifest(${path2}) call!`); }';

test('server lookup returns the exact build props and preserves other manifest behavior', () => {
  const context = vm.createContext({});
  vm.runInContext(inlinePreviewProps(bundle, manifest), context);
  const lookup = context.loadManifest;
  assert.deepEqual(JSON.parse(JSON.stringify(lookup('/.next/server/preview-props.json'))), manifest);
  assert.equal(lookup('/known-manifest.json').known, true);
  assert.throws(() => lookup('/unexpected.json'), /Unexpected loadManifest/);
});

test('rejects missing, duplicated, already-supported, or changed bundle patterns', () => {
  for (const source of ['', bundle + bundle, bundle + 'path2.endsWith("/server/preview-props.json")', bundle.replace('throw new Error', 'throw Error')]) {
    assert.throws(() => inlinePreviewProps(source, manifest), /inlining changed/);
  }
});

test('rejects unexpected manifest data without including its values in errors', () => {
  for (const invalid of [null, {}, [], {...manifest, extra: 'sensitive'}, {...manifest, previewModeId: ''}]) {
    assert.throws(() => inlinePreviewProps(bundle, invalid), {message: 'Unexpected preview props manifest shape.'});
  }
});
