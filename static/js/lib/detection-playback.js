// Reproducción de detecciones sincronizadas con un <video> subido.
//
// Sube el video a POST /api/detect y consume el stream SSE (un evento por frame,
// contrato: {time, width, height, boxes, identity_summary?, count}). Cada frame se acumula en
// this.frames y el DIBUJO se sincroniza con el frame efectivamente presentado por
// el <video> mediante requestVideoFrameCallback. En navegadores que no exponen
// ese API usamos timeupdate como fallback. Se muestra el frame cuyo `time`
// corresponde al timestamp de media del video, no al instante en que llega SSE.
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
import { getBoxDebugSettings } from './debug-settings.js';

// El video no debe alcanzar al stream SSE: esperamos esta ventaja antes de
// iniciar y volvemos a pausar si la inferencia queda demasiado atrás.
const INITIAL_BUFFER_SECONDS = 2;
const MIN_PAUSE_BUFFER_SECONDS = 0.15;
const MAX_PAUSE_BUFFER_SECONDS = 0.5;
const MIN_RESUME_BUFFER_SECONDS = 0.75;
const MAX_RESUME_BUFFER_SECONDS = 3;
const DEFAULT_ARRIVAL_GAP_SECONDS = 0.15;
const ARRIVAL_GAP_SAMPLE_LIMIT = 24;
const INTERPOLATION_MAX_GAP_SECONDS = 0.5;
// `timeupdate` se emite con poca frecuencia. Sólo lo usamos para recuperar el
// overlay cuando el callback preciso del compositor no llega por un tiempo
// anormal; de otro modo ambos relojes competirían y harían parpadear las cajas.
const VIDEO_FRAME_CALLBACK_STALL_SECONDS = 0.35;
// El loop nativo no garantiza el orden de seeked, timeupdate y
// requestVideoFrameCallback. Una diferencia grande evita confundir el reloj
// levemente atrasado de timeupdate con el reinicio real del clip.
const LOOP_REWIND_MIN_SECONDS = 0.5;
// Después de un seek/loop puede llegar un callback pendiente del ciclo previo.
// Sólo volvemos al reloj preciso cuando mediaTime es coherente con el nuevo
// tiempo pedido o presentado por el elemento.
const VIDEO_FRAME_CALLBACK_SYNC_TOLERANCE_SECONDS = 0.25;
// Un frame vacío de la IA no debe hacer desaparecer las cajas de inmediato.
// Mantenemos la última detección reciente, pero acotamos su antigüedad para no
// dejar una posición congelada durante una oclusión prolongada.
const DETECTION_PERSISTENCE_SECONDS = 1.5;

/**
 * Caja del contrato -> formato de drawDetections, mapeada al MISMO recorte que
 * hace `object-fit: cover` del <video>: escala uniforme + offset de centrado.
 * Así las cajas coinciden con el contenido visible para cualquier relación de
 * aspecto (con la IA real, frame.width/height = dims del video original).
 * @param {{id:number,identity_id?:number,x1:number,y1:number,x2:number,y2:number,conf:number}} box
 * @param {number} scale factor uniforme
 * @param {number} offX  desplazamiento horizontal (px de pantalla)
 * @param {number} offY  desplazamiento vertical
 */
function toDetection(box, scale, offX, offY) {
  return {
    // ByteTrack puede cambiar `id` cuando recupera a un nadador. La identidad
    // canónica mantiene estelas e interpolación continuas durante ese cambio.
    id: box.identity_id ?? box.id,
    identityId: box.identity_id,
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function percentile(values, q) {
  if (!values.length) return DEFAULT_ARRIVAL_GAP_SECONDS;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank conserva el hueco entre batches incluso si un batch entrega
  // varios eventos SSE en el mismo tick del navegador.
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)];
}

export class DetectionPlayback {
  /**
   * @param {HTMLVideoElement} video
   * @param {HTMLCanvasElement} canvas
   * @param {(count:number)=>void} [onCount] callback con personas canónicas confirmadas.
   * @param {(isBuffering:boolean)=>void} [onBufferingChange] actualiza la UI de espera.
   * @param {(telemetry:{reason:string,bufferAhead:number,pauseThreshold:number,resumeThreshold:number,initialThreshold:number,rebufferCount:number,arrivalGapP90:number,streamDone:boolean})=>void} [onBufferTelemetry] actualiza el detalle de espera.
   * @param {(count:number)=>void} [onLapCount] actualiza las vueltas detectadas en shadow mode.
   */
  constructor(video, canvas, onCount, onBufferingChange, onBufferTelemetry, onLapCount) {
    this.video = video;
    this.canvas = canvas;
    this.onCount = onCount || (() => {});
    this.onBufferingChange = onBufferingChange || (() => {});
    this.onBufferTelemetry = onBufferTelemetry || (() => {});
    this.onLapCount = onLapCount || (() => {});
    /** @type {Array<{time:number,width:number,height:number,boxes:any[],count:number,identity_summary?:{confirmed_count:number,active_count:number}}>} */
    this.frames = [];
    this._onTimeUpdate = null;
    this._onSeeked = null;
    this._resizeObs = null;
    /** @type {AbortController|null} para cancelar el stream si se frena. */
    this._abort = null;
    /** Máximo count visto durante la repetición actual del video. */
    this._maxCount = 0;
    /** Identifica la reproducción activa para ignorar callbacks de un video detenido. */
    this._runId = 0;
    this._streamDone = false;
    this._playStarted = false;
    this._buffering = false;
    this._bufferingReason = null;
    this._bufferingStartedAt = null;
    this._rebufferCount = 0;
    this._lastRebufferDuration = 0;
    this._arrivalGaps = [];
    this._lastArrivalAt = null;
    this._clock = () => {
      if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now() / 1000;
      }
      return Date.now() / 1000;
    };
    this._initialBufferWaiter = null;
    this._resumePromise = null;
    this._overlay = createDetectionOverlayState();
    this._onDebugSettingsChange = null;
    this._lastRenderedVideoTime = null;
    this._presentedVideoTime = null;
    this._usesVideoFrameCallback = false;
    this._videoFrameRequestId = null;
    this._lastVideoFrameCallbackAt = null;
    this._awaitingVideoFrameAfterSeek = false;
    this._timelineRecoveryTarget = null;
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
    this._maxCount = 0;
    this.onLapCount(0);
    this._streamDone = false;
    this._playStarted = false;
    this._resetBufferTelemetry();
    this._setBuffering(true, 'initial');
    this._resumePromise = null;
    resetDetectionOverlayState(this._overlay);
    this._lastRenderedVideoTime = null;
    this._presentedVideoTime = null;
    this._lastVideoFrameCallbackAt = this._clock();
    this._awaitingVideoFrameAfterSeek = false;
    this._timelineRecoveryTarget = null;

    this.video.srcObject = null; // por si venía de la cámara
    this.video.src = videoUrl;
    this.video.loop = true;      // el clip de prueba es corto: repetir es cómodo

    // requestVideoFrameCallback se ejecuta para cada frame enviado al compositor
    // y entrega su mediaTime exacto. timeupdate se conserva como recuperación
    // ante seek/loop o cuando ese API deja de entregar callbacks.
    this._usesVideoFrameCallback = typeof this.video.requestVideoFrameCallback === 'function';
    this._onTimeUpdate = () => {
      // Algunos navegadores reinician currentTime por loop antes de emitir
      // seeked o de entregar el primer callback del compositor del nuevo ciclo.
      // No dependemos de esos eventos: el propio retroceso del reloj habilita
      // el fallback y redibuja de inmediato las detecciones ya almacenadas.
      const loopRewound = this._hasTimeRewound(this.video.currentTime);
      if (loopRewound) {
        this._beginTimelineRecovery(this.video.currentTime);
      }
      // Nunca dibujamos por ambos relojes durante reproducción normal: currentTime
      // puede adelantar unos milisegundos a mediaTime y alternaría cajas/estelas.
      // Después de un loop buscamos primero el próximo frame presentado; si no
      // aparece, `timeupdate` mantiene vivo el overlay como recuperación.
      if (!this._usesVideoFrameCallback || this.video.paused
        || loopRewound || this._awaitingVideoFrameAfterSeek || this._videoFrameCallbackIsStalled()) {
        this._renderCurrent();
      }
      this._pauseIfBufferRunsDry();
    };
    this.video.addEventListener('timeupdate', this._onTimeUpdate);
    this._onSeeked = () => {
      // Un seek puede no presentar un frame nuevo de inmediato; reflejamos la
      // posición pedida y dejamos que el siguiente callback la afine.
      this._beginTimelineRecovery(this.video.currentTime);
      this._renderCurrent();
      this._pauseIfBufferRunsDry();
    };
    this.video.addEventListener('seeked', this._onSeeked);
    if (this._usesVideoFrameCallback) this._requestVideoFrame(runId);
    this._resizeObs = new ResizeObserver(() => {
      // Las estelas se almacenan en coordenadas del canvas visible. Al cambiar
      // el tamaño, reiniciarlas evita mezclar posiciones de dos escalas.
      resetDetectionOverlayState(this._overlay);
      this._renderCurrent();
    });
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
      this._setBuffering(false, 'playing');
      this._renderCurrent();

      await stream;
    } finally {
      if (this._isActive(runId)) {
        // Si play() falla o el stream terminó con error, no dejamos un POST
        // leyendo en segundo plano después de que el panel se restablezca.
        if (!this._streamDone && this._abort) this._abort.abort();
        this._streamDone = true;
        this._abort = null;
        this._setBuffering(false, 'complete');
      }
    }
  }

  /** POST del video a /api/detect y consumo incremental del SSE (acumula frames). */
  async _streamDetections(file, detectUrl, runId) {
    const form = new FormData();
    form.append('video', file); // el back lo lee como request.files['video']
    form.append(
      'lap_confidence_threshold',
      String(getBoxDebugSettings().lapConfidenceThreshold),
    );
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
    this._recordArrival();
    this.frames.push(frame); // {time,width,height,boxes,count}
    this._settleInitialBuffer();
    if (!this._usesVideoFrameCallback || !this._playStarted || this.video.paused) {
      this._renderCurrent();
    }
    this._resumeIfBuffered(runId);
    this._emitBufferTelemetry(this._buffering ? this._bufferingReason : 'streaming');
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
    if (!this.frames.length || (!this._streamDone && this._bufferAhead() < this._initialBufferSeconds())) {
      return;
    }
    this._initialBufferWaiter = null;
    waiter.resolve();
  }

  _completeStream(runId) {
    if (!this._isActive(runId)) return;
    this._streamDone = true;
    this._settleInitialBuffer();
    if (!this._usesVideoFrameCallback || !this._playStarted || this.video.paused) {
      this._renderCurrent();
    }
    this._resumeIfBuffered(runId);
    this._emitBufferTelemetry('complete');
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
    const current = this._presentedVideoTime === null ? this.video.currentTime : this._presentedVideoTime;
    return latest === null ? Number.NEGATIVE_INFINITY : latest - current;
  }

  _resetBufferTelemetry() {
    this._bufferingReason = null;
    this._bufferingStartedAt = null;
    this._rebufferCount = 0;
    this._lastRebufferDuration = 0;
    this._arrivalGaps = [];
    this._lastArrivalAt = null;
  }

  _recordArrival() {
    const now = this._clock();
    if (this._lastArrivalAt !== null) {
      const gap = now - this._lastArrivalAt;
      // Pausas muy largas suelen ser el navegador suspendido en background; no
      // dejamos que una de ellas fuerce un objetivo de buffer exagerado.
      if (Number.isFinite(gap) && gap >= 0 && gap <= MAX_RESUME_BUFFER_SECONDS) {
        this._arrivalGaps.push(gap);
        if (this._arrivalGaps.length > ARRIVAL_GAP_SAMPLE_LIMIT) this._arrivalGaps.shift();
      }
    }
    this._lastArrivalAt = now;
  }

  _arrivalGapP90() {
    return percentile(this._arrivalGaps, 0.9);
  }

  _resumeBufferSeconds() {
    // Dos intervalos de llegada más un margen absorben la mayoría de los bursts
    // SSE. Si el último rebuffer duró más, su duración también eleva el próximo
    // objetivo para evitar una secuencia de pausas de ~1 s.
    const protection = Math.max(
      this._arrivalGapP90() * 2,
      this._lastRebufferDuration * 1.5,
    );
    return clamp(0.25 + protection, MIN_RESUME_BUFFER_SECONDS, MAX_RESUME_BUFFER_SECONDS);
  }

  _pauseBufferSeconds() {
    // Pausar antes de agotar el margen deja tiempo para que llegue el próximo
    // batch, sin hacer que los clips normalmente fluidos se congelen demasiado pronto.
    return clamp(this._resumeBufferSeconds() / 3, MIN_PAUSE_BUFFER_SECONDS, MAX_PAUSE_BUFFER_SECONDS);
  }

  _initialBufferSeconds() {
    return Math.max(INITIAL_BUFFER_SECONDS, this._resumeBufferSeconds());
  }

  _bufferTelemetry(reason) {
    const ahead = this._bufferAhead();
    return {
      reason: reason || this._bufferingReason || (this._streamDone ? 'complete' : 'streaming'),
      bufferAhead: Number.isFinite(ahead) ? Math.max(0, ahead) : 0,
      pauseThreshold: this._pauseBufferSeconds(),
      resumeThreshold: this._resumeBufferSeconds(),
      initialThreshold: this._initialBufferSeconds(),
      rebufferCount: this._rebufferCount,
      arrivalGapP90: this._arrivalGapP90(),
      streamDone: this._streamDone,
    };
  }

  _emitBufferTelemetry(reason) {
    this.onBufferTelemetry(this._bufferTelemetry(reason));
  }

  _setBuffering(isBuffering, reason = isBuffering ? 'initial' : 'playing') {
    if (this._buffering === isBuffering) {
      this._emitBufferTelemetry(reason);
      return;
    }
    const now = this._clock();
    if (isBuffering) {
      this._bufferingReason = reason;
      this._bufferingStartedAt = now;
      if (reason === 'rebuffer') this._rebufferCount += 1;
    } else if (this._bufferingReason === 'rebuffer' && this._bufferingStartedAt !== null) {
      this._lastRebufferDuration = Math.max(0, now - this._bufferingStartedAt);
      this._bufferingReason = null;
      this._bufferingStartedAt = null;
    } else {
      this._bufferingReason = null;
      this._bufferingStartedAt = null;
    }
    this._buffering = isBuffering;
    this.onBufferingChange(isBuffering);
    this._emitBufferTelemetry(reason);
  }

  _pauseIfBufferRunsDry() {
    if (!this._playStarted || this._streamDone || this._buffering) return;
    if (this._bufferAhead() >= this._pauseBufferSeconds()) return;
    this._setBuffering(true, 'rebuffer');
    this.video.pause();
  }

  _resumeIfBuffered(runId) {
    if (!this._isActive(runId) || !this._playStarted || !this._buffering || this._resumePromise) {
      return;
    }
    if (!this._streamDone && this._bufferAhead() < this._resumeBufferSeconds()) {
      this._emitBufferTelemetry('rebuffer');
      return;
    }

    this._resumePromise = this.video.play()
      .then(() => {
        if (!this._isActive(runId)) return;
        this._setBuffering(false, 'playing');
        this._renderCurrent();
      })
      .catch(() => {
        // El video está muted; un rechazo es excepcional. Conservamos el estado
        // pausado para no avanzar sin detecciones mientras el usuario reintenta.
        if (this._isActive(runId)) this._setBuffering(true, 'rebuffer');
      })
      .finally(() => {
        if (this._isActive(runId)) this._resumePromise = null;
      });
  }

  /** Dibuja el frame que corresponde al video.currentTime actual. */
  _renderCurrent() {
    this._renderAt(this.video.currentTime);
  }

  _hasTimeRewound(time) {
    return this._lastRenderedVideoTime !== null
      && Number.isFinite(time)
      && time + LOOP_REWIND_MIN_SECONDS < this._lastRenderedVideoTime;
  }

  _beginTimelineRecovery(time) {
    this._timelineRecoveryTarget = Number.isFinite(time) ? time : null;
    this._awaitingVideoFrameAfterSeek = this._usesVideoFrameCallback && !this.video.paused;
  }

  _callbackMatchesCurrentTimeline(mediaTime) {
    if (this._timelineRecoveryTarget === null) return true;
    const references = [this.video.currentTime, this._timelineRecoveryTarget]
      .filter((time) => Number.isFinite(time));
    return references.some((time) => Math.abs(mediaTime - time) <= VIDEO_FRAME_CALLBACK_SYNC_TOLERANCE_SECONDS);
  }

  _videoFrameCallbackIsStalled() {
    if (!this._usesVideoFrameCallback || this._lastVideoFrameCallbackAt === null) return false;
    return this._clock() - this._lastVideoFrameCallbackAt >= VIDEO_FRAME_CALLBACK_STALL_SECONDS;
  }

  /** Dibuja el frame que corresponde a un timestamp de media presentado. */
  _renderAt(time) {
    const currentTime = Number.isFinite(time) ? time : this.video.currentTime;
    if (this._lastRenderedVideoTime !== null && currentTime < this._lastRenderedVideoTime) {
      // Un seek o el loop del video no forman parte de la trayectoria física.
      resetDetectionOverlayState(this._overlay);
      this._maxCount = 0;
      this.onCount(0);
      this.onLapCount(0);
    }
    this._lastRenderedVideoTime = currentTime;
    this._presentedVideoTime = currentTime;
    const frame = this._frameAt(currentTime);
    if (frame) this._render(frame);
    else clearCanvas(this.canvas);
  }

  _requestVideoFrame(runId) {
    if (!this._usesVideoFrameCallback || !this._isActive(runId)) return;
    this._videoFrameRequestId = this.video.requestVideoFrameCallback((_now, metadata) => {
      this._videoFrameRequestId = null;
      if (!this._isActive(runId)) return;
      const mediaTime = metadata && Number.isFinite(metadata.mediaTime)
        ? metadata.mediaTime
        : this.video.currentTime;
      // Un callback que pertenece al ciclo anterior no debe volver a dibujar
      // una caja al final del video ni desactivar el fallback del loop nuevo.
      if (this._awaitingVideoFrameAfterSeek && !this._callbackMatchesCurrentTimeline(mediaTime)) {
        this._requestVideoFrame(runId);
        return;
      }
      this._lastVideoFrameCallbackAt = this._clock();
      this._awaitingVideoFrameAfterSeek = false;
      this._timelineRecoveryTarget = null;
      this._renderAt(mediaTime);
      this._pauseIfBufferRunsDry();
      // Hay que registrar el siguiente callback usando el ID nuevo para que
      // stop() pueda cancelarlo correctamente, tal como exige el API.
      this._requestVideoFrame(runId);
    });
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
    // El resumen canónico cuenta personas físicas, mientras que `count` es el
    // legacy acumulado de tracklets ByteTrack. Si la IA aún no publica el nuevo
    // resumen, degradamos a las personas visibles de este frame, nunca al
    // acumulado histórico de IDs efímeros.
    const confirmedCount = frame.identity_summary?.confirmed_count;
    if (Number.isInteger(confirmedCount) && confirmedCount >= 0) {
      this._maxCount = Math.max(this._maxCount, confirmedCount);
      this.onCount(this._maxCount);
    } else {
      this._maxCount = dets.length;
      this.onCount(dets.length);
    }
    this.onLapCount(this._lapCountAt(this._presentedVideoTime));
  }

  _lapCountAt(time) {
    const episodeKeys = new Set();
    for (const frame of this.frames) {
      if (!Number.isFinite(frame.time) || frame.time > time) continue;
      for (const decision of frame.lap_decisions || []) {
        const laneId = decision?.lane_id;
        const identityId = decision?.identity_id;
        const episodeId = decision?.candidate_episode_id;
        if (typeof laneId !== 'string' || !Number.isInteger(episodeId) || episodeId < 1) continue;
        const identityKey = Number.isInteger(identityId) && identityId > 0 ? identityId : 'legacy';
        episodeKeys.add(`${laneId}:${identityKey}:${episodeId}`);
      }
    }
    return episodeKeys.size;
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

  _nextDetectionAfter(t) {
    for (const frame of this.frames) {
      if (frame.time <= t) continue;
      if (Array.isArray(frame.boxes) && frame.boxes.length > 0) return frame;
    }
    return null;
  }

  _interpolateFrame(previous, next, t) {
    if (!next || !Array.isArray(previous.boxes) || !Array.isArray(next.boxes)) return previous;
    const span = next.time - previous.time;
    if (!Number.isFinite(span) || span <= 0 || span > INTERPOLATION_MAX_GAP_SECONDS) return previous;

    const nextById = new Map();
    for (const box of next.boxes) {
      const identityKey = box?.identity_id ?? box?.id;
      if (identityKey !== undefined && identityKey !== null) nextById.set(String(identityKey), box);
    }
    const factor = clamp((t - previous.time) / span, 0, 1);
    let changed = false;
    const boxes = previous.boxes.map((box) => {
      const identityKey = box?.identity_id ?? box?.id;
      if (identityKey === undefined || identityKey === null) return box;
      const target = nextById.get(String(identityKey));
      if (!target) return box;
      const fields = ['x1', 'y1', 'x2', 'y2', 'conf'];
      if (!fields.every((field) => Number.isFinite(box[field]) && Number.isFinite(target[field]))) {
        return box;
      }
      changed = true;
      return {
        ...box,
        x1: box.x1 + (target.x1 - box.x1) * factor,
        y1: box.y1 + (target.y1 - box.y1) * factor,
        x2: box.x2 + (target.x2 - box.x2) * factor,
        y2: box.y2 + (target.y2 - box.y2) * factor,
        conf: box.conf + (target.conf - box.conf) * factor,
      };
    });
    return changed ? { ...previous, time: t, boxes } : previous;
  }

  /** Frame sincronizado, conservando cajas recientes ante un vacío breve de detección. */
  _frameAt(t) {
    let match = null;
    for (const f of this.frames) {
      if (f.time <= t) match = f;
      else break;
    }
    if (match && Array.isArray(match.boxes) && match.boxes.length > 0) {
      if (t - match.time > DETECTION_PERSISTENCE_SECONDS) return null;
      return this._interpolateFrame(match, this._nextDetectionAfter(t), t);
    }

    const lastDetection = this._lastDetectionAtOrBefore(t);
    if (lastDetection && t - lastDetection.time <= DETECTION_PERSISTENCE_SECONDS) {
      return this._interpolateFrame(lastDetection, this._nextDetectionAfter(t), t);
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
    this._lastRenderedVideoTime = null;
    this._presentedVideoTime = null;
    this._setBuffering(false, 'stopped');
    this._resumePromise = null;
    if (this._abort) {
      this._abort.abort();
      this._abort = null;
    }
    if (this._onTimeUpdate) {
      this.video.removeEventListener('timeupdate', this._onTimeUpdate);
      this._onTimeUpdate = null;
    }
    if (this._onSeeked) {
      this.video.removeEventListener('seeked', this._onSeeked);
      this._onSeeked = null;
    }
    if (this._videoFrameRequestId !== null && typeof this.video.cancelVideoFrameCallback === 'function') {
      this.video.cancelVideoFrameCallback(this._videoFrameRequestId);
    }
    this._videoFrameRequestId = null;
    this._usesVideoFrameCallback = false;
    this._lastVideoFrameCallbackAt = null;
    this._awaitingVideoFrameAfterSeek = false;
    this._timelineRecoveryTarget = null;
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
