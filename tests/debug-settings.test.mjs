import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_BOX_DEBUG_SETTINGS,
  getBoxDebugSettings,
  saveBoxDebugSettings,
} from '../static/js/lib/debug-settings.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, value); },
  };
}

test('uses the current box visualization as the default Debug configuration', () => {
  assert.deepEqual(DEFAULT_BOX_DEBUG_SETTINGS, {
    showValues: true,
    showCenters: false,
    showTrails: false,
  });
  assert.deepEqual(getBoxDebugSettings(memoryStorage()), DEFAULT_BOX_DEBUG_SETTINGS);
});

test('persists each Debug checkbox independently', () => {
  const storage = memoryStorage();
  const saved = saveBoxDebugSettings({ showCenters: true, showTrails: true }, storage);

  assert.deepEqual(saved, {
    showValues: true,
    showCenters: true,
    showTrails: true,
  });
  assert.deepEqual(getBoxDebugSettings(storage), saved);
});
