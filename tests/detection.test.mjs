import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDetectionOverlayState,
  drawDetections,
} from '../static/js/lib/detection.js';

function fakeCanvas() {
  const labels = [];
  const context = {
    clearRect() {},
    strokeRect() {},
    fillRect() {},
    fillText(label) { labels.push(label); },
    measureText(label) { return { width: label.length * 8 }; },
    beginPathCalls: 0,
    lineCalls: 0,
    strokeCalls: 0,
    beginPath() { this.beginPathCalls += 1; },
    moveTo() { this.lineCalls += 1; },
    lineTo() { this.lineCalls += 1; },
    stroke() { this.strokeCalls += 1; },
  };
  return {
    width: 0,
    height: 0,
    labels,
    context,
    getContext() { return context; },
  };
}

test('renders only the confidence percentage in each detection label', () => {
  const canvas = fakeCanvas();

  drawDetections(canvas, { videoWidth: 640, videoHeight: 480 }, [
    { id: 12, bbox: [10, 20, 30, 40], score: 0.917, class: 'person' },
    { id: 'demo', bbox: [50, 60, 70, 80], score: 0, class: 'person' },
  ]);

  assert.deepEqual(canvas.labels, ['92%', '0%']);
});

test('can draw center crosses and trails without showing box values', () => {
  const canvas = fakeCanvas();
  const overlay = createDetectionOverlayState();
  const settings = { showValues: false, showCenters: true, showTrails: true };
  const source = { videoWidth: 640, videoHeight: 480 };

  drawDetections(canvas, source, [
    { id: 12, bbox: [10, 20, 30, 40], score: 0.9, class: 'person' },
  ], { overlay, settings });
  drawDetections(canvas, source, [
    { id: 12, bbox: [25, 20, 30, 40], score: 0.9, class: 'person' },
  ], { overlay, settings });

  assert.deepEqual(canvas.labels, []);
  assert.equal(overlay.trails.get('12').length, 2);
  assert.ok(canvas.context.beginPathCalls >= 3); // 2 cruces + 1 estela
  assert.ok(canvas.context.strokeCalls >= 3);
});
