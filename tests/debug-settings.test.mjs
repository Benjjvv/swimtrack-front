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

test('uses the current visualization and lap threshold as the default Debug configuration', () => {
  assert.deepEqual(DEFAULT_BOX_DEBUG_SETTINGS, {
    showValues: true,
    showCenters: false,
    showTrails: false,
    lapConfidenceThreshold: 0.2,
  });
  assert.deepEqual(getBoxDebugSettings(memoryStorage()), DEFAULT_BOX_DEBUG_SETTINGS);
});

test('persists Debug checkboxes and the lap threshold independently', () => {
  const storage = memoryStorage();
  const saved = saveBoxDebugSettings({
    showCenters: true,
    showTrails: true,
    lapConfidenceThreshold: '0.7',
  }, storage);

  assert.deepEqual(saved, {
    showValues: true,
    showCenters: true,
    showTrails: true,
    lapConfidenceThreshold: 0.7,
  });
  assert.deepEqual(getBoxDebugSettings(storage), saved);
});

test('falls back to the default lap threshold when a saved value is invalid', () => {
  const storage = memoryStorage();
  storage.setItem('swimtrack-box-debug-settings', JSON.stringify({ lapConfidenceThreshold: 2 }));

  assert.equal(getBoxDebugSettings(storage).lapConfidenceThreshold, 0.2);
});
