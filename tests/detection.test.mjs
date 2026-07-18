import assert from 'node:assert/strict';
import test from 'node:test';

import { drawDetections } from '../static/js/lib/detection.js';

test('renders only the confidence percentage in each detection label', () => {
  const labels = [];
  const context = {
    clearRect() {},
    strokeRect() {},
    fillRect() {},
    fillText(label) { labels.push(label); },
    measureText(label) { return { width: label.length * 8 }; },
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext() { return context; },
  };

  drawDetections(canvas, { videoWidth: 640, videoHeight: 480 }, [
    { id: 12, bbox: [10, 20, 30, 40], score: 0.917, class: 'person' },
    { id: 'demo', bbox: [50, 60, 70, 80], score: 0, class: 'person' },
  ]);

  assert.deepEqual(labels, ['92%', '0%']);
});
