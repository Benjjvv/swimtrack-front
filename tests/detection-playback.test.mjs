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

class FrameCallbackVideo extends FakeVideo {
  constructor() {
    super();
    this._frameCallbacks = new Map();
    this._nextFrameCallbackId = 1;
  }

  requestVideoFrameCallback(callback) {
    const id = this._nextFrameCallbackId;
    this._nextFrameCallbackId += 1;
    this._frameCallbacks.set(id, callback);
    return id;
  }

  cancelVideoFrameCallback(id) {
    this._frameCallbacks.delete(id);
  }

  present(mediaTime) {
    const first = this._frameCallbacks.entries().next().value;
    if (!first) return;
    const [id, callback] = first;
    this._frameCallbacks.delete(id);
    callback(0, { mediaTime, presentedFrames: 1 });
  }

  get pendingFrameCallbacks() {
    return this._frameCallbacks.size;
  }
}

function fakeCanvas() {
  const context = {
    clearCalls: 0,
    strokeCalls: 0,
    clearRect() { this.clearCalls += 1; },
    strokeRects: [],
    strokeRect(...args) {
      this.strokeCalls += 1;
      this.strokeRects.push(args);
    },
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

function emptyFrame(time) {
  return { ...frame(time), boxes: [] };
}

function movingFrame(time, x) {
  return {
    time,
    width: 640,
    height: 640,
    count: 1,
    boxes: [{ id: 'swimmer-1', x1: x, y1: 20, x2: x + 60, y2: 120, conf: 0.9 }],
  };
}

function canonicalMovingFrame(time, x, rawId) {
  return {
    time,
    width: 640,
    height: 640,
    count: rawId,
    identity_summary: { confirmed_count: 1, active_count: 1 },
    boxes: [{ id: rawId, identity_id: 1, x1: x, y1: 20, x2: x + 60, y2: 120, conf: 0.9 }],
  };
}

function lapFrame(time, episodeId) {
  return {
    ...frame(time),
    lap_decisions: [{ lane_id: 'center', candidate_episode_id: episodeId }],
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
  const bufferingStates = [];
  const playback = new ControlledPlayback(video, canvas, undefined, (isBuffering) => {
    bufferingStates.push(isBuffering);
  });

  const started = playback.start('blob:video', {}, '/api/detect');
  await playback.streamStarted.promise;

  assert.equal(playback.streamCalls, 1);
  assert.equal(video.playCalls, 0);
  assert.deepEqual(bufferingStates, [true]);

  playback._ingestEvent(`data: ${JSON.stringify(frame(0))}`);
  playback._ingestEvent(`data: ${JSON.stringify(frame(1))}`);
  await flush();

  assert.equal(video.playCalls, 0);

  playback._ingestEvent(`data: ${JSON.stringify(frame(2))}`);
  await flush();

  assert.equal(video.playCalls, 1);
  assert.equal(video.paused, false);
  assert.deepEqual(bufferingStates, [true, false]);

  video.currentTime = 1.8;
  video.emit('timeupdate');

  assert.equal(video.paused, true);
  assert.equal(video.pauseCalls, 1);
  assert.deepEqual(bufferingStates, [true, false, true]);

  playback._ingestEvent(`data: ${JSON.stringify(frame(2.6))}`);
  await flush();

  assert.equal(video.playCalls, 2);
  assert.equal(video.paused, false);
  assert.deepEqual(bufferingStates, [true, false, true, false]);

  playback.streamGate.resolve();
  await started;
});

test('keeps the most recent boxes through short empty or delayed detection gaps', () => {
  const video = new FakeVideo();
  const canvas = fakeCanvas();
  const playback = new DetectionPlayback(video, canvas);

  playback.frames = [frame(0)];
  video.currentTime = 0.5;
  playback._renderCurrent();

  assert.equal(canvas.context.strokeCalls, 1);

  playback.frames.push(emptyFrame(0.6));
  assert.equal(playback._frameAt(1.1).time, 0);

  video.currentTime = 1.1;
  playback._renderCurrent();
  assert.equal(canvas.context.strokeCalls, 2);

  assert.equal(playback._frameAt(1.6).time, 0.6);

  playback.frames = [frame(0)];
  assert.equal(playback._frameAt(1.6), null);
});

test('resets people and lap counters when the video repeats', () => {
  const video = new FakeVideo();
  const canvas = fakeCanvas();
  const peopleCounts = [];
  const lapCounts = [];
  const playback = new DetectionPlayback(video, canvas, (count) => {
    peopleCounts.push(count);
  }, undefined, undefined, (count) => {
    lapCounts.push(count);
  });
  playback.frames = [
    { ...frame(0), count: 1, identity_summary: { confirmed_count: 1, active_count: 1 } },
    { ...lapFrame(0.5, 3), count: 2, identity_summary: { confirmed_count: 2, active_count: 2 } },
    { ...lapFrame(1, 4), count: 3, identity_summary: { confirmed_count: 3, active_count: 3 } },
  ];

  playback._renderAt(0.1);
  playback._renderAt(1);
  playback._renderAt(0.1);

  assert.deepEqual(peopleCounts, [1, 3, 0, 1]);
  assert.deepEqual(lapCounts, [0, 2, 0, 0]);
});

test('uses canonical people counts instead of fragmented ByteTrack IDs', () => {
  const video = new FakeVideo();
  const canvas = fakeCanvas();
  const peopleCounts = [];
  const playback = new DetectionPlayback(video, canvas, (count) => {
    peopleCounts.push(count);
  });
  playback.frames = [
    {
      ...frame(0),
      count: 18,
      identity_summary: { confirmed_count: 1, active_count: 1 },
    },
    {
      ...frame(1),
      count: 99,
      boxes: [
        { id: 41, x1: 20, y1: 20, x2: 80, y2: 120, conf: 0.9 },
        { id: 42, x1: 120, y1: 20, x2: 180, y2: 120, conf: 0.9 },
      ],
    },
  ];

  playback._renderAt(0);
  playback._renderAt(1);

  assert.deepEqual(peopleCounts, [1, 2]);
});

test('interpolates across a raw tracklet change when the canonical identity is stable', () => {
  const video = new FakeVideo();
  const canvas = fakeCanvas();
  const playback = new DetectionPlayback(video, canvas);

  const interpolated = playback._interpolateFrame(
    canonicalMovingFrame(0, 0, 3),
    canonicalMovingFrame(0.2, 100, 19),
    0.1,
  );

  assert.equal(interpolated.boxes[0].id, 3);
  assert.equal(interpolated.boxes[0].identity_id, 1);
  assert.equal(interpolated.boxes[0].x1, 50);
});

test('counts independent lap episodes for two canonical identities in one lane', () => {
  const video = new FakeVideo();
  const canvas = fakeCanvas();
  const playback = new DetectionPlayback(video, canvas);
  playback.frames = [
    {
      ...frame(0),
      lap_decisions: [
        { lane_id: 'center', identity_id: 1, candidate_episode_id: 1 },
        { lane_id: 'center', identity_id: 2, candidate_episode_id: 1 },
      ],
    },
  ];

  assert.equal(playback._lapCountAt(0), 2);
});

test('renders using presented mediaTime and interpolates a stable tracked box', async () => {
  const video = new FrameCallbackVideo();
  const canvas = fakeCanvas();
  const playback = new ControlledPlayback(video, canvas);

  const started = playback.start('blob:video', {}, '/api/detect');
  await playback.streamStarted.promise;
  playback._ingestEvent(`data: ${JSON.stringify(movingFrame(0, 0))}`);
  playback._ingestEvent(`data: ${JSON.stringify(movingFrame(0.2, 100))}`);
  playback._ingestEvent(`data: ${JSON.stringify(movingFrame(2, 200))}`);
  await flush();

  // currentTime representa el reloj del elemento; mediaTime es el timestamp del
  // frame que el compositor acaba de presentar y debe ganar para el overlay.
  video.currentTime = 1.75;
  video.present(0.1);

  assert.equal(playback._presentedVideoTime, 0.1);
  assert.equal(canvas.context.strokeRects.at(-1)[0], 50);
  assert.equal(video.pendingFrameCallbacks, 1);

  playback.stop();
  assert.equal(video.pendingFrameCallbacks, 0);
  playback.streamGate.resolve();
  await started;
});

test('keeps rendering after a loop when video frame callbacks do not resume', async () => {
  const video = new FrameCallbackVideo();
  const canvas = fakeCanvas();
  const playback = new ControlledPlayback(video, canvas);

  const started = playback.start('blob:video', {}, '/api/detect');
  await playback.streamStarted.promise;
  playback._ingestEvent(`data: ${JSON.stringify(emptyFrame(0))}`);
  playback._ingestEvent(`data: ${JSON.stringify(frame(0.1))}`);
  playback._ingestEvent(`data: ${JSON.stringify(frame(2))}`);
  await flush();

  // La última detección no puede ser más antigua que la ventana de persistencia.
  video.present(1.4);
  assert.equal(canvas.context.strokeCalls, 1);

  // Simula el loop: el seek a cero muestra un frame vacío y el navegador no
  // entrega el siguiente requestVideoFrameCallback. Los timeupdate posteriores
  // deben mantener el overlay vivo como fallback.
  video.currentTime = 0;
  video.emit('seeked');
  video.currentTime = 0.1;
  video.emit('timeupdate');

  assert.equal(canvas.context.strokeCalls, 2);

  playback.stop();
  playback.streamGate.resolve();
  await started;
});

test('recovers an implicit loop before seeked while the prior frame callback still looks healthy', async () => {
  const video = new FrameCallbackVideo();
  const canvas = fakeCanvas();
  const playback = new ControlledPlayback(video, canvas);

  const started = playback.start('blob:video', {}, '/api/detect');
  await playback.streamStarted.promise;
  playback._ingestEvent(`data: ${JSON.stringify(emptyFrame(0))}`);
  playback._ingestEvent(`data: ${JSON.stringify(frame(0.1))}`);
  playback._ingestEvent(`data: ${JSON.stringify(frame(2))}`);
  await flush();

  video.present(1.4);
  const strokesAtEndOfCycle = canvas.context.strokeCalls;

  // El loop nativo puede retroceder sin que seeked llegue antes del siguiente
  // timeupdate. Tampoco llega un nuevo callback del compositor en este caso.
  video.currentTime = 0.1;
  video.emit('timeupdate');

  assert.equal(canvas.context.strokeCalls, strokesAtEndOfCycle + 1);
  assert.equal(playback._awaitingVideoFrameAfterSeek, true);

  // Mientras esperamos el callback nuevo, el fallback debe seguir dibujando.
  video.currentTime = 0.2;
  video.emit('timeupdate');
  assert.equal(canvas.context.strokeCalls, strokesAtEndOfCycle + 2);

  playback.stop();
  playback.streamGate.resolve();
  await started;
});

test('ignores a stale video frame callback until it belongs to the repeated cycle', async () => {
  const video = new FrameCallbackVideo();
  const canvas = fakeCanvas();
  const playback = new ControlledPlayback(video, canvas);

  const started = playback.start('blob:video', {}, '/api/detect');
  await playback.streamStarted.promise;
  playback._ingestEvent(`data: ${JSON.stringify(emptyFrame(0))}`);
  playback._ingestEvent(`data: ${JSON.stringify(frame(0.1))}`);
  playback._ingestEvent(`data: ${JSON.stringify(frame(2))}`);
  await flush();

  video.present(1.4);
  video.currentTime = 0.1;
  video.emit('timeupdate');
  const strokesAtLoopStart = canvas.context.strokeCalls;

  // Simula un callback pendiente del ciclo anterior: no puede reemplazar el
  // frame recién renderizado ni sacar al reproductor del modo de recuperación.
  video.present(1.4);
  assert.equal(playback._presentedVideoTime, 0.1);
  assert.equal(playback._awaitingVideoFrameAfterSeek, true);
  assert.equal(canvas.context.strokeCalls, strokesAtLoopStart);

  video.currentTime = 0.15;
  video.present(0.15);
  assert.equal(playback._presentedVideoTime, 0.15);
  assert.equal(playback._awaitingVideoFrameAfterSeek, false);
  assert.equal(canvas.context.strokeCalls, strokesAtLoopStart + 1);

  playback.stop();
  playback.streamGate.resolve();
  await started;
});

test('does not render from timeupdate while video frame callbacks are healthy', async () => {
  const video = new FrameCallbackVideo();
  const canvas = fakeCanvas();
  const playback = new ControlledPlayback(video, canvas);

  const started = playback.start('blob:video', {}, '/api/detect');
  await playback.streamStarted.promise;
  playback._ingestEvent(`data: ${JSON.stringify(frame(0))}`);
  playback._ingestEvent(`data: ${JSON.stringify(frame(0.1))}`);
  playback._ingestEvent(`data: ${JSON.stringify(frame(2))}`);
  await flush();

  video.present(0.1);
  const strokesAfterPresentation = canvas.context.strokeCalls;
  assert.ok(strokesAfterPresentation > 0);

  // El compositor sigue entregando frames: el reloj menos preciso de
  // timeupdate no debe volver a dibujar entre dos frames presentados.
  video.currentTime = 0.15;
  video.emit('timeupdate');
  assert.equal(canvas.context.strokeCalls, strokesAfterPresentation);

  video.present(0.15);
  assert.equal(canvas.context.strokeCalls, strokesAfterPresentation + 1);

  playback.stop();
  playback.streamGate.resolve();
  await started;
});

test('adapts the resume target to slow SSE arrivals and reports rebuffer telemetry', async () => {
  const video = new FakeVideo();
  const canvas = fakeCanvas();
  const telemetry = [];
  const playback = new DetectionPlayback(video, canvas, undefined, undefined, (state) => {
    telemetry.push(state);
  });
  let now = 0;
  playback._clock = () => now;
  // Activamos sólo la parte de estado necesaria para probar el controlador de
  // buffer sin iniciar fetch ni un video real.
  playback._onTimeUpdate = () => {};
  playback._ingestEvent(`data: ${JSON.stringify(frame(0))}`);
  now = 1;
  playback._ingestEvent(`data: ${JSON.stringify(frame(1))}`);

  assert.equal(playback._resumeBufferSeconds(), 2.25);
  playback._playStarted = true;
  playback._setBuffering(true, 'rebuffer');
  video.currentTime = 0.8;
  playback._presentedVideoTime = 0.8;
  playback._resumeIfBuffered(playback._runId);
  assert.equal(video.playCalls, 0);

  playback.frames.push(frame(3.1));
  playback._resumeIfBuffered(playback._runId);
  await flush();

  assert.equal(video.playCalls, 1);
  assert.equal(telemetry.at(-1).reason, 'playing');
  assert.equal(telemetry.at(-1).rebufferCount, 1);
  playback.stop();
});

test('reports an empty completed stream instead of waiting forever', async () => {
  const video = new FakeVideo();
  const canvas = fakeCanvas();
  const bufferingStates = [];
  const playback = new ControlledPlayback(video, canvas, undefined, (isBuffering) => {
    bufferingStates.push(isBuffering);
  });

  const started = playback.start('blob:video', {}, '/api/detect');
  await playback.streamStarted.promise;
  playback.streamGate.resolve();

  await assert.rejects(started, /no emitió frames/);
  assert.equal(video.playCalls, 0);
  assert.deepEqual(bufferingStates, [true, false]);
});
