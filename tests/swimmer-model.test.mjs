import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSwimmer, mergeSwimmers, LEVELS } from '../static/js/lib/swimmer-model.js';

test('normalizeSwimmer keeps a valid age and level untouched', () => {
  const s = normalizeSwimmer({ id: '1', name: 'Ana', age: 24, level: 'avanzado', createdAt: 't0' });
  assert.deepEqual(s, { id: '1', name: 'Ana', age: 24, level: 'avanzado', createdAt: 't0' });
});

test('normalizeSwimmer turns an invalid age into null', () => {
  assert.equal(normalizeSwimmer({ name: 'x', age: NaN }).age, null);
  assert.equal(normalizeSwimmer({ name: 'x', age: 0 }).age, null);
  assert.equal(normalizeSwimmer({ name: 'x', age: -3 }).age, null);
  assert.equal(normalizeSwimmer({ name: 'x', age: undefined }).age, null);
  assert.equal(normalizeSwimmer({ name: 'x', age: 12 }).age, 12);
});

test('normalizeSwimmer defaults an unknown level to intermedio', () => {
  assert.equal(normalizeSwimmer({ name: 'x', level: 'pro' }).level, 'intermedio');
  assert.equal(normalizeSwimmer({ name: 'x', level: undefined }).level, 'intermedio');
  for (const lvl of LEVELS) {
    assert.equal(normalizeSwimmer({ name: 'x', level: lvl }).level, lvl);
  }
});

test('mergeSwimmers adds only swimmers whose id is new (dedup by id)', () => {
  const saved = [{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Beto' }];
  const session = [{ id: 'b', name: 'Beto' }, { id: 'c', name: 'Caro' }];
  const { merged, added } = mergeSwimmers(saved, session);
  assert.deepEqual(added.map((s) => s.id), ['c']);
  assert.deepEqual(merged.map((s) => s.id), ['a', 'b', 'c']);
});

test('mergeSwimmers does not mutate the saved array', () => {
  const saved = [{ id: 'a', name: 'Ana' }];
  const before = saved.slice();
  mergeSwimmers(saved, [{ id: 'z', name: 'Z' }]);
  assert.deepEqual(saved, before);
});
