import { fileURLToPath } from 'node:url';

import { test, expect } from '../fixtures/test.mjs';
import { installDetectionStreamMock } from '../support/mock-detection-stream.mjs';
import { stopVideoFrameCallbacksAfterFirstLoop } from '../support/video-frame-callback.mjs';

const loopVideo = fileURLToPath(new URL('../assets/loop-2s.mp4', import.meta.url));

async function startUploadedLoop({ page, monitor }) {
  await installDetectionStreamMock(page);
  await monitor.goto();
  await monitor.uploadVideo(loopVideo);
  await monitor.waitForPlayback();
}

test('keeps detection boxes visible through two native video loops', async ({ page, monitor }) => {
  await startUploadedLoop({ page, monitor });

  const metrics = await monitor.observeOverlayThroughLoops({ loops: 2 });

  expect(metrics.observedLoops).toBeGreaterThanOrEqual(2);
  expect(metrics.samples).toBeGreaterThan(20);
  expect(metrics.maxConsecutiveBlankFrames).toBeLessThanOrEqual(1);
});

test('recovers the overlay when video frame callbacks stop after a loop', async ({ page, monitor }) => {
  await stopVideoFrameCallbacksAfterFirstLoop(page);
  await startUploadedLoop({ page, monitor });

  const metrics = await monitor.observeOverlayThroughLoops({ loops: 2 });

  expect(metrics.observedLoops).toBeGreaterThanOrEqual(2);
  expect(metrics.maxConsecutiveBlankFrames).toBeLessThanOrEqual(1);
});
