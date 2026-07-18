import assert from 'node:assert/strict';
import test from 'node:test';

import { DetectionPlayback } from '../static/js/lib/detection-playback.js';

class FakeResizeObserver {
  observe() {}

  disconnect() {}
}

globalThis.ResizeObserver = FakeResizeObserver;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

class FakeVideo {
  constructor() {
    this.src = '';
    this.srcObject = null;
    this.loop = false;
    this.currentTime = 0;
    this.clientWidth = 640;
    this.clientHeight = 640;
    this.paused = true;
    this.playCalls = 0;
    this.pauseCalls = 0;
    this._listeners = new Map();
  }

  addEventListener(name, listener) {
    this._listeners.set(name, listener);
  }

  removeEventListener(name) {
    this._listeners.delete(name);
  }

  emit(name) {
    this._listeners.get(name)?.();
  }

  async play() {
    this.playCalls += 1;
    this.paused = false;
  }

  pause() {
    this.pauseCalls += 1;
    this.paused = true;
  }
}

function fakeCanvas() {
  const context = {
    clearCalls: 0,
    strokeCalls: 0,
    clearRect() { this.clearCalls += 1; },
    strokeRect() { this.strokeCalls += 1; },
    fillRect() {},
    fillText() {},
    measureText() { return { width: 0 }; },
  };
  return {
    width: 640,
    height: 640,
    context,
    getContext() { return context; },
  };
}

function frame(time) {
  return {
    time,
    width: 640,
    height: 640,
    count: 1,
    boxes: [{ id: 1, x1: 20, y1: 20, x2: 80, y2: 120, conf: 0.9 }],
  };
}

class ControlledPlayback extends DetectionPlayback {
  constructor(...args) {
    super(...args);
    this.streamStarted = deferred();
    this.streamGate = deferred();
    this.streamCalls = 0;
  }

  async _streamDetections() {
    this.streamCalls += 1;
    this.streamStarted.resolve();
    await this.streamGate.promise;
  }
}

test('starts the SSE stream before playing and buffers detections before playback', async () => {
  const video = new FakeVideo();
  const canvas = fakeCanvas();
  const playback = new ControlledPlayback(video, canvas);

  const started = playback.start('blob:video', {}, '/api/detect');
  await playback.streamStarted.promise;

  assert.equal(playback.streamCalls, 1);
  assert.equal(video.playCalls, 0);

  playback._ingestEvent(`data: ${JSON.stringify(frame(0))}`);
  playback._ingestEvent(`data: ${JSON.stringify(frame(1))}`);
  await flush();

  assert.equal(video.playCalls, 1);
  assert.equal(video.paused, false);

  video.currentTime = 0.8;
  video.emit('timeupdate');

  assert.equal(video.paused, true);
  assert.equal(video.pauseCalls, 1);

  playback._ingestEvent(`data: ${JSON.stringify(frame(1.6))}`);
  await flush();

  assert.equal(video.playCalls, 2);
  assert.equal(video.paused, false);

  playback.streamGate.resolve();
  await started;
});

test('clears the overlay instead of drawing a stale frame past the SSE buffer', () => {
  const video = new FakeVideo();
  const canvas = fakeCanvas();
  const playback = new DetectionPlayback(video, canvas);

  playback.frames = [frame(0)];
  video.currentTime = 0.5;
  playback._renderCurrent();

  assert.equal(canvas.context.strokeCalls, 0);
  assert.equal(canvas.context.clearCalls, 1);
});

test('reports an empty completed stream instead of waiting forever', async () => {
  const video = new FakeVideo();
  const canvas = fakeCanvas();
  const playback = new ControlledPlayback(video, canvas);

  const started = playback.start('blob:video', {}, '/api/detect');
  await playback.streamStarted.promise;
  playback.streamGate.resolve();

  await assert.rejects(started, /no emitió frames/);
  assert.equal(video.playCalls, 0);
});
