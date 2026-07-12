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

import { drawDetections, clearCanvas } from './detection.js';

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
   */
  constructor(video, canvas, onCount) {
    this.video = video;
    this.canvas = canvas;
    this.onCount = onCount || (() => {});
    /** @type {Array<{time:number,width:number,height:number,boxes:any[],count:number}>} */
    this.frames = [];
    this._onTimeUpdate = null;
    this._resizeObs = null;
    /** @type {AbortController|null} para cancelar el stream si se frena. */
    this._abort = null;
    /** Máximo count visto en esta pasada; el contador no baja por el loop. (F9) */
    this._maxCount = 0;
  }

  /**
   * Reproduce el video y le pide al back las detecciones (SSE) para dibujarlas.
   * @param {string} videoUrl  URL.createObjectURL del archivo subido (para <video>).
   * @param {File}   file      el mismo video, para subirlo a /api/detect.
   * @param {string} detectUrl URL del endpoint de detección (subpath-safe).
   */
  async start(videoUrl, file, detectUrl) {
    this.stop();
    this.frames = [];
    this._maxCount = 0; // contador arranca de cero con cada video nuevo

    this.video.srcObject = null; // por si venía de la cámara
    this.video.src = videoUrl;
    this.video.loop = true;      // el clip de prueba es corto: repetir es cómodo

    // Redibujar el frame actual en cada timeupdate Y al cambiar de tamaño
    // (resize de ventana, colapso de sidebar), no solo mientras reproduce. (F4)
    this._onTimeUpdate = () => this._renderCurrent();
    this.video.addEventListener('timeupdate', this._onTimeUpdate);
    this._resizeObs = new ResizeObserver(() => this._renderCurrent());
    this._resizeObs.observe(this.video);

    await this.video.play();
    if (!this._onTimeUpdate) return; // stop() canceló mientras cargaba el video

    await this._streamDetections(file, detectUrl);
  }

  /** POST del video a /api/detect y consumo incremental del SSE (acumula frames). */
  async _streamDetections(file, detectUrl) {
    const form = new FormData();
    form.append('video', file); // el back lo lee como request.files['video']
    this._abort = new AbortController();
    try {
      const res = await fetch(detectUrl, { method: 'POST', body: form, signal: this._abort.signal });
      if (!res.ok || !res.body) {
        throw new Error('El servidor de detección respondió ' + res.status + '.');
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          this._ingestEvent(buffer.slice(0, sep));
          buffer = buffer.slice(sep + 2);
        }
      }
      if (buffer.trim()) this._ingestEvent(buffer); // último evento sin "\n\n"
    } catch (err) {
      if (err && err.name === 'AbortError') return; // stop() canceló: es normal
      throw err;
    }
  }

  /**
   * Parsea un evento SSE. Si es `event: error` (la IA falló a mitad), lanza para
   * que el panel lo muestre; si no, acumula el frame del contrato. (F2)
   */
  _ingestEvent(raw) {
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
    try {
      this.frames.push(JSON.parse(data)); // {time,width,height,boxes,count}
    } catch (_e) {
      // keepalive/comentario u otro evento no-JSON: lo ignoramos.
    }
  }

  /** Dibuja el frame que corresponde al video.currentTime actual. */
  _renderCurrent() {
    const frame = this._frameAt(this.video.currentTime);
    if (frame) this._render(frame);
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
    drawDetections(this.canvas, { videoWidth: elW, videoHeight: elH }, dets);
    // El count del contrato es monótono en una pasada, pero el video está en
    // loop: al reiniciar, los frames vuelven a count bajo. Clampeamos al máximo
    // visto para que el contador no reinicie ni re-anime cada ciclo. (F9)
    const count = typeof frame.count === 'number' ? frame.count : dets.length;
    this._maxCount = Math.max(this._maxCount, count);
    this.onCount(this._maxCount);
  }

  /** Último frame cuyo `time` ya pasó (los frames llegan ordenados por time). */
  _frameAt(t) {
    let match = null;
    for (const f of this.frames) {
      if (f.time <= t) match = f;
      else break;
    }
    return match || this.frames[0] || null;
  }

  /** Cancela el stream, quita listeners y limpia el canvas. */
  stop() {
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
    clearCanvas(this.canvas);
  }
}
