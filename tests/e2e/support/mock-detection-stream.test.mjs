import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDetectionFrames } from './mock-detection-stream.mjs';

test('buildDetectionFrames creates an ordered SSE-compatible 30 FPS clip', () => {
  const frames = buildDetectionFrames({ durationSeconds: 2, fps: 30, width: 320, height: 320 });

  assert.equal(frames.length, 60);
  assert.equal(frames[0].time, 0);
  assert.equal(frames.at(-1).time, 1.966667);
  assert.ok(frames.every((frame, index) => frame.time === Number((index / 30).toFixed(6))));
  assert.ok(frames.every((frame) => frame.width === 320 && frame.height === 320));
  assert.ok(frames.every((frame) => frame.count === 1 && frame.boxes.length === 1));
});
