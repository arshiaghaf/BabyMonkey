import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

for (const consumer of ['@cloudflare/vitest-plugin', 'eslint-plugin-react-hooks']) {
  const consumerRequire = createRequire(import.meta.resolve(consumer));
  const { z } = consumerRequire('zod');

  for (const kind of ['array', 'set', 'map']) {
    test(`${consumer}: oversized ${kind} stops before element validation`, () => {
      let visits = 0;
      const element = z.string().superRefine(() => { visits++; });
      const schema = kind === 'array' ? z.array(element).max(2)
        : kind === 'set' ? z.set(element).max(2) : z.map(z.string(), element).max(2);
      const input = values => kind === 'array' ? values
        : kind === 'set' ? new Set(values) : new Map(values.map((value, index) => [String(index), value]));
      for (const jitless of [false, true]) {
        // Wrapping also exercises the object's default compiled parser path.
        const wrapper = z.object({ items: schema });
        for (const values of [Array.from({ length: 64 }, (_, i) => String(i)), Array.from({ length: 64 }, (_, i) => i)]) {
          visits = 0;
          const rejected = wrapper.safeParse({ items: input(values) }, { jitless });
          assert.equal(rejected.success, false);
          assert.equal(rejected.error.issues.length, 1);
          assert.equal(rejected.error.issues[0].code, 'too_big');
          assert.equal(visits, 0);
        }
        visits = 0;
        const ordinary = input(['one', 'two']);
        const accepted = wrapper.safeParse({ items: ordinary }, { jitless });
        assert.equal(accepted.success, true);
        assert.deepEqual(accepted.data.items, ordinary);
        assert.equal(visits, 2);
      }
    });
  }

  test(`${consumer}: exact-length errors and overwrite ordering remain intact`, () => {
    const tooShort = z.array(z.string()).length(2).safeParse(['one']);
    assert.equal(tooShort.success, false);
    assert.equal(tooShort.error.issues[0].code, 'too_small');
    const normalizeFirst = z.array(z.string()).overwrite(values => values.slice(0, 2)).max(2);
    assert.deepEqual(normalizeFirst.parse(['one', 'two', 'three']), ['one', 'two']);
  });
}
