// Reproducción de detecciones sincronizadas con un <video> subido.
//
// Sube el video a POST /api/detect y consume el stream SSE (un evento por frame,
// contrato: {time, width, height, boxes, count}). Cada frame se acumula en
// this.frames y el DIBUJO se sincroniza con el <video> por el evento timeupdate
// (y por resize): se muestra el frame cuyo `time` corresponde a video.currentTime.
// Reutiliza la capa de dibujo existente (drawDetections/clearCanvas).
//
// EventSource no sirve (es solo GET), así que consumimos el SSE con fetch() +
// ReadableStream.

import {
  createDetectionOverlayState,
  drawDetections,
  clearCanvas,
  resetDetectionOverlayState,
} from './detection.js';

// El video no debe alcanzar al stream SSE: esperamos esta ventaja antes de
// iniciar y volvemos a pausar si la inferencia queda demasiado atrás.
const INITIAL_BUFFER_SECONDS = 2;
const PAUSE_BUFFER_SECONDS = 0.25;
const RESUME_BUFFER_SECONDS = 0.75;
// Un frame vacío de la IA no debe hacer desaparecer las cajas de inmediato.
// Mantenemos la última detección reciente, pero acotamos su antigüedad para no
// dejar una posición congelada durante una oclusión prolongada.
const DETECTION_PERSISTENCE_SECONDS = 1.5;

/**
 * Caja del contrato -> formato de drawDetections, mapeada al MISMO recorte que
 * hace `object-fit: cover` del <video>: escala uniforme + offset de centrado.
 * Así las cajas coinciden con el contenido visible para cualquier relación de
 * aspecto (con la IA real, frame.width/height = dims del video original).
 * @param {{id:number,x1:number,y1:number,x2:number,y2:number,conf:number}} box
 * @param {number} scale factor uniforme
 * @param {number} offX  desplazamiento horizontal (px de pantalla)
 * @param {number} offY  desplazamiento vertical
 */
function toDetection(box, scale, offX, offY) {
  return {
    id: box.id,
    bbox: [
      offX + box.x1 * scale,
      offY + box.y1 * scale,
      (box.x2 - box.x1) * scale,
      (box.y2 - box.y1) * scale,
    ],
    score: box.conf,
    class: 'person',
  };
}

export class DetectionPlayback {
  /**
   * @param {HTMLVideoElement} video
   * @param {HTMLCanvasElement} canvas
   * @param {(count:number)=>void} [onCount] callback con el count del frame.
   * @param {(isBuffering:boolean)=>void} [onBufferingChange] actualiza la UI de espera.
   */
  constructor(video, canvas, onCount, onBufferingChange) {
    this.video = video;
    this.canvas = canvas;
    this.onCount = onCount || (() => {});
    this.onBufferingChange = onBufferingChange || (() => {});
    /** @type {Array<{time:number,width:number,height:number,boxes:any[],count:number}>} */
    this.frames = [];
    this._onTimeUpdate = null;
    this._resizeObs = null;
    /** @type {AbortController|null} para cancelar el stream si se frena. */
    this._abort = null;
    /** Máximo count visto en esta pasada; el contador no baja por el loop. (F9) */
    this._maxCount = 0;
    /** Identifica la reproducción activa para ignorar callbacks de un video detenido. */
    this._runId = 0;
    this._streamDone = false;
    this._playStarted = false;
    this._buffering = false;
    this._initialBufferWaiter = null;
    this._resumePromise = null;
    this._overlay = createDetectionOverlayState();
    this._onDebugSettingsChange = null;
  }

  /**
   * Empieza a recibir SSE, junta una ventaja inicial y recién entonces reproduce.
   * @param {string} videoUrl  URL.createObjectURL del archivo subido (para <video>).
   * @param {File}   file      el mismo video, para subirlo a /api/detect.
   * @param {string} detectUrl URL del endpoint de detección (subpath-safe).
   */
  async start(videoUrl, file, detectUrl) {
    this.stop();
    const runId = ++this._runId;
    this.frames = [];
    this._maxCount = 0; // contador arranca de cero con cada video nuevo
    this._streamDone = false;
    this._playStarted = false;
    this._setBuffering(true);
    this._resumePromise = null;
    resetDetectionOverlayState(this._overlay);

    this.video.srcObject = null; // por si venía de la cámara
    this.video.src = videoUrl;
    this.video.loop = true;      // el clip de prueba es corto: repetir es cómodo

    // Redibujar el frame actual en cada timeupdate Y al cambiar de tamaño
    // (resize de ventana, colapso de sidebar), no solo mientras reproduce. (F4)
    this._onTimeUpdate = () => {
      this._renderCurrent();
      this._pauseIfBufferRunsDry();
    };
    this.video.addEventListener('timeupdate', this._onTimeUpdate);
    this._resizeObs = new ResizeObserver(() => this._renderCurrent());
    this._resizeObs.observe(this.video);
    this._onDebugSettingsChange = () => this._renderCurrent();
    if (typeof window !== 'undefined') {
      window.addEventListener('swimtrack:box-debug-settings-changed', this._onDebugSettingsChange);
    }

    // Iniciar el POST antes de reproducir evita perder un ciclo completo del
    // video mientras Flask recibe el upload y la GPU produce el primer batch.
    const initialBuffer = this._waitForInitialBuffer(runId);
    const stream = this._streamDetections(file, detectUrl, runId);
    stream.then(
      () => this._completeStream(runId),
      (error) => this._failInitialBuffer(runId, error),
    );

    try {
      await initialBuffer;
      if (!this._isActive(runId)) return; // stop() canceló mientras esperaba

      await this.video.play();
      if (!this._isActive(runId)) {
        this.video.pause();
        return;
      }

      this._playStarted = true;
      this._setBuffering(false);
      this._renderCurrent();

      await stream;
    } finally {
      if (this._isActive(runId)) {
        // Si play() falla o el stream terminó con error, no dejamos un POST
        // leyendo en segundo plano después de que el panel se restablezca.
        if (!this._streamDone && this._abort) this._abort.abort();
        this._streamDone = true;
        this._abort = null;
        this._setBuffering(false);
      }
    }
  }

  /** POST del video a /api/detect y consumo incremental del SSE (acumula frames). */
  async _streamDetections(file, detectUrl, runId) {
    const form = new FormData();
    form.append('video', file); // el back lo lee como request.files['video']
    const abort = new AbortController();
    this._abort = abort;
    try {
      const res = await fetch(detectUrl, { method: 'POST', body: form, signal: abort.signal });
      if (!res.ok || !res.body) {
        throw new Error('El servidor de detección respondió ' + res.status + '.');
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!this._isActive(runId)) return;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          this._ingestEvent(buffer.slice(0, sep), runId);
          buffer = buffer.slice(sep + 2);
        }
      }
      if (buffer.trim() && this._isActive(runId)) this._ingestEvent(buffer, runId); // último evento sin "\n\n"
    } catch (err) {
      if (err && err.name === 'AbortError') return; // stop() canceló: es normal
      throw err;
    }
  }

  /**
   * Parsea un evento SSE. Si es `event: error` (la IA falló a mitad), lanza para
   * que el panel lo muestre; si no, acumula el frame del contrato. (F2)
   */
  _ingestEvent(raw, runId = this._runId) {
    if (!this._isActive(runId)) return;
    let event = 'message';
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    const data = dataLines.join('');
    if (!data) return;
    if (event === 'error') {
      let msg = 'Error en la detección.';
      try { msg = JSON.parse(data).error || msg; } catch (_e) { /* usa el default */ }
      throw new Error(msg);
    }
    let frame;
    try {
      frame = JSON.parse(data);
    } catch (_e) {
      // keepalive/comentario u otro evento no-JSON: lo ignoramos.
      return;
    }
    this.frames.push(frame); // {time,width,height,boxes,count}
    this._settleInitialBuffer();
    this._renderCurrent();
    this._resumeIfBuffered(runId);
  }

  /** Espera la ventaja inicial o el final de un video más corto que el margen. */
  _waitForInitialBuffer(runId) {
    return new Promise((resolve, reject) => {
      this._initialBufferWaiter = { runId, resolve, reject };
      this._settleInitialBuffer();
    });
  }

  _settleInitialBuffer() {
    const waiter = this._initialBufferWaiter;
    if (!waiter) return;
    if (!this._isActive(waiter.runId)) {
      this._initialBufferWaiter = null;
      waiter.resolve();
      return;
    }
    if (this._streamDone && !this.frames.length) {
      this._initialBufferWaiter = null;
      waiter.reject(new Error('El servidor de detección no emitió frames.'));
      return;
    }
    if (!this.frames.length || (!this._streamDone && this._bufferAhead() < INITIAL_BUFFER_SECONDS)) {
      return;
    }
    this._initialBufferWaiter = null;
    waiter.resolve();
  }

  _completeStream(runId) {
    if (!this._isActive(runId)) return;
    this._streamDone = true;
    this._settleInitialBuffer();
    this._renderCurrent();
    this._resumeIfBuffered(runId);
  }

  _failInitialBuffer(runId, error) {
    if (!this._isActive(runId)) return;
    const waiter = this._initialBufferWaiter;
    if (!waiter || waiter.runId !== runId) return;
    this._initialBufferWaiter = null;
    waiter.reject(error);
  }

  _isActive(runId) {
    return this._runId === runId && this._onTimeUpdate !== null;
  }

  _latestFrameTime() {
    const frame = this.frames[this.frames.length - 1];
    return frame && Number.isFinite(frame.time) ? frame.time : null;
  }

  _bufferAhead() {
    const latest = this._latestFrameTime();
    return latest === null ? Number.NEGATIVE_INFINITY : latest - this.video.currentTime;
  }

  _setBuffering(isBuffering) {
    if (this._buffering === isBuffering) return;
    this._buffering = isBuffering;
    this.onBufferingChange(isBuffering);
  }

  _pauseIfBufferRunsDry() {
    if (!this._playStarted || this._streamDone || this._buffering) return;
    if (this._bufferAhead() >= PAUSE_BUFFER_SECONDS) return;
    this._setBuffering(true);
    this.video.pause();
  }

  _resumeIfBuffered(runId) {
    if (!this._isActive(runId) || !this._playStarted || !this._buffering || this._resumePromise) {
      return;
    }
    if (!this._streamDone && this._bufferAhead() < RESUME_BUFFER_SECONDS) return;

    this._resumePromise = this.video.play()
      .then(() => {
        if (!this._isActive(runId)) return;
        this._setBuffering(false);
        this._renderCurrent();
      })
      .catch(() => {
        // El video está muted; un rechazo es excepcional. Conservamos el estado
        // pausado para no avanzar sin detecciones mientras el usuario reintenta.
        if (this._isActive(runId)) this._setBuffering(true);
      })
      .finally(() => {
        if (this._isActive(runId)) this._resumePromise = null;
      });
  }

  /** Dibuja el frame que corresponde al video.currentTime actual. */
  _renderCurrent() {
    const frame = this._frameAt(this.video.currentTime);
    if (frame) this._render(frame);
    else clearCanvas(this.canvas);
  }

  /** Mapea las cajas al recorte de object-fit: cover del <video> y las dibuja. */
  _render(frame) {
    // Tamaño renderizado del <video> (px CSS). El canvas se superpone 1:1.
    const elW = this.video.clientWidth || frame.width;
    const elH = this.video.clientHeight || frame.height;
    // Igual que object-fit: cover -> escala uniforme (la mayor) y centrado. Para
    // un video 16:9 en la caja 16:9, scale es único y los offsets son 0.
    const scale = Math.max(elW / frame.width, elH / frame.height);
    const offX = (elW - frame.width * scale) / 2;
    const offY = (elH - frame.height * scale) / 2;
    const dets = (frame.boxes || []).map((b) => toDetection(b, scale, offX, offY));
    drawDetections(this.canvas, { videoWidth: elW, videoHeight: elH }, dets, {
      overlay: this._overlay,
    });
    // El count del contrato es monótono en una pasada, pero el video está en
    // loop: al reiniciar, los frames vuelven a count bajo. Clampeamos al máximo
    // visto para que el contador no reinicie ni re-anime cada ciclo. (F9)
    const count = typeof frame.count === 'number' ? frame.count : dets.length;
    this._maxCount = Math.max(this._maxCount, count);
    this.onCount(this._maxCount);
  }

  /** Última detección con cajas que no sea futura para el instante indicado. */
  _lastDetectionAtOrBefore(t) {
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const frame = this.frames[index];
      if (frame.time > t) continue;
      if (Array.isArray(frame.boxes) && frame.boxes.length > 0) return frame;
    }
    return null;
  }

  /** Frame sincronizado, conservando cajas recientes ante un vacío breve de detección. */
  _frameAt(t) {
    let match = null;
    for (const f of this.frames) {
      if (f.time <= t) match = f;
      else break;
    }
    if (match && Array.isArray(match.boxes) && match.boxes.length > 0) {
      return t - match.time <= DETECTION_PERSISTENCE_SECONDS ? match : null;
    }

    const lastDetection = this._lastDetectionAtOrBefore(t);
    if (lastDetection && t - lastDetection.time <= DETECTION_PERSISTENCE_SECONDS) {
      return lastDetection;
    }
    return match;
  }

  /** Cancela el stream, quita listeners y limpia el canvas. */
  stop() {
    this._runId += 1;
    if (this._initialBufferWaiter) {
      const waiter = this._initialBufferWaiter;
      this._initialBufferWaiter = null;
      waiter.resolve();
    }
    this._streamDone = false;
    this._playStarted = false;
    this._setBuffering(false);
    this._resumePromise = null;
    if (this._abort) {
      this._abort.abort();
      this._abort = null;
    }
    if (this._onTimeUpdate) {
      this.video.removeEventListener('timeupdate', this._onTimeUpdate);
      this._onTimeUpdate = null;
    }
    if (this._resizeObs) {
      this._resizeObs.disconnect();
      this._resizeObs = null;
    }
    if (this._onDebugSettingsChange && typeof window !== 'undefined') {
      window.removeEventListener('swimtrack:box-debug-settings-changed', this._onDebugSettingsChange);
      this._onDebugSettingsChange = null;
    }
    resetDetectionOverlayState(this._overlay);
    clearCanvas(this.canvas);
  }
}
