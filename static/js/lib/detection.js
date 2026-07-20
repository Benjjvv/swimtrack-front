// Detección de personas con TensorFlow.js + COCO-SSD (cargados del CDN bajo demanda).

import { getBoxDebugSettings } from './debug-settings.js';

/**
 * @typedef {Object} Detection
 * @property {string} id
 * @property {[number,number,number,number]} bbox - [x, y, w, h] en px de la fuente.
 * @property {number} score
 * @property {string} class
 * @property {number} [swimmerId] ordinal visible del nadador remoto confirmado.
 */

const TF_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js';
const COCO_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js';

/** @type {Promise<any>|null} cache del modelo (se carga una sola vez). */
let _modelPromise = null;

/** Inyecta un <script> y resuelve cuando carga. */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('No se pudo cargar ' + src));
    document.head.appendChild(s);
  });
}

/**
 * Carga TF.js + COCO-SSD del CDN (una vez) y devuelve el modelo listo.
 * Las libs son builds UMD: exponen `tf` y `cocoSsd` como globales.
 * @returns {Promise<any>}
 */
export async function loadCocoSsd() {
  if (_modelPromise) return _modelPromise;
  _modelPromise = (async () => {
    await loadScript(TF_URL);
    await loadScript(COCO_URL);
    if (typeof cocoSsd === 'undefined') {
      throw new Error('COCO-SSD no quedó disponible tras cargar el CDN.');
    }
    // eslint-disable-next-line no-undef
    return cocoSsd.load();
  })();
  return _modelPromise;
}

export class DetectionLoop {
  /** @param {any} model modelo de COCO-SSD ya cargado. */
  constructor(model) {
    this.model = model;
    this._running = false;
    this._raf = null;
  }

  /**
   * Corre la detección frame a frame y llama onDetections con las personas.
   * @param {HTMLVideoElement} videoEl
   * @param {(dets: Detection[]) => void} onDetections
   */
  start(videoEl, onDetections) {
    if (this._running) return;
    this._running = true;
    const tick = async () => {
      if (!this._running) return;
      try {
        const preds = await this.model.detect(videoEl);
        const people = preds
          .filter((p) => p.class === 'person' && p.score > 0.4)
          .map((p, i) => ({ id: 'det-' + i, bbox: p.bbox, score: p.score, class: p.class }));
        onDetections(people);
      } catch (_err) {
        // Frame no listo / tensor inválido: ignoramos y seguimos.
      }
      if (this._running) this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }
}

/** Limpia el canvas por completo. @param {HTMLCanvasElement} canvas */
export function clearCanvas(canvas) {
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

/** Crea el estado aislado de las estelas de una fuente de video o imagen. */
export function createDetectionOverlayState() {
  return { trails: new Map() };
}

/** Elimina el historial de estelas sin tocar el contenido visible del canvas. */
export function resetDetectionOverlayState(overlay) {
  overlay?.trails?.clear();
}

function appendTrailPoints(overlay, detections) {
  if (!overlay?.trails) return;
  const visibleIds = new Set();
  detections.forEach((detection, index) => {
    const id = String(detection.id ?? index);
    const [x, y, width, height] = detection.bbox;
    const point = { x: x + width / 2, y: y + height / 2 };
    const points = overlay.trails.get(id) || [];
    const previous = points[points.length - 1];
    if (!previous || previous.x !== point.x || previous.y !== point.y) {
      points.push(point);
      // Un límite fijo evita que una cámara abierta acumule memoria sin límite.
      if (points.length > 24) points.shift();
    }
    overlay.trails.set(id, points);
    visibleIds.add(id);
  });
  for (const id of overlay.trails.keys()) {
    if (!visibleIds.has(id)) overlay.trails.delete(id);
  }
}

function drawTrails(ctx, overlay, lineWidth) {
  if (!overlay?.trails) return;
  ctx.strokeStyle = 'rgb(34 197 94 / 0.55)';
  ctx.lineWidth = Math.max(1, lineWidth / 2);
  for (const points of overlay.trails.values()) {
    if (points.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
    ctx.stroke();
  }
}

/**
 * Dibuja las cajas con su porcentaje de confianza en el canvas. Iguala la resolución interna
 * del canvas a la de la fuente (video/imagen) para mapear las bbox 1:1; el CSS
 * estira el canvas al tamaño visible.
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLVideoElement|HTMLImageElement|null} source
 * @param {Detection[]} detections
 * @param {{overlay?: {trails: Map<string, Array<{x:number,y:number}>>}, settings?: {
 *   showValues?: boolean, showSwimmerIds?: boolean, showTimestamp?: boolean, showCenters?: boolean, showTrails?: boolean},
 *   timestampSeconds?: number, timestampFps?: number}} [options]
 */
export function drawDetections(canvas, source, detections, options = {}) {
  const srcW = (source && (source.videoWidth || source.naturalWidth)) || 1280;
  const srcH = (source && (source.videoHeight || source.naturalHeight)) || 720;
  if (canvas.width !== srcW || canvas.height !== srcH) {
    canvas.width = srcW;
    canvas.height = srcH;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const settings = options.settings || getBoxDebugSettings();
  const overlay = options.overlay;
  const lineWidth = Math.max(2, srcW / 320);
  ctx.lineWidth = lineWidth;
  const fontPx = Math.max(14, Math.round(srcW / 60));
  ctx.font = `${fontPx}px sans-serif`;
  ctx.textBaseline = 'top';

  if (settings.showTrails) {
    appendTrailPoints(overlay, detections);
    drawTrails(ctx, overlay, lineWidth);
  } else {
    resetDetectionOverlayState(overlay);
  }

  detections.forEach((d) => {
    const [x, y, w, h] = d.bbox;
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = lineWidth;
    ctx.strokeRect(x, y, w, h);

    const labelParts = [];
    if (settings.showSwimmerIds && Number.isInteger(d.swimmerId) && d.swimmerId > 0) {
      labelParts.push(`Nadador #${d.swimmerId}`);
    }
    if (settings.showValues) labelParts.push(`${Math.round((d.score || 0) * 100)}%`);
    if (labelParts.length) {
      const label = labelParts.join(' · ');
      const th = fontPx + 6;
      const tw = ctx.measureText(label).width + 8;
      const labelY = Math.max(0, y - th);
      ctx.fillStyle = '#22c55e';
      ctx.fillRect(x, labelY, tw, th);
      ctx.fillStyle = '#03120a';
      ctx.fillText(label, x + 4, labelY + 3);
    }

    if (settings.showCenters) {
      const centerX = x + w / 2;
      const centerY = y + h / 2;
      const arm = Math.max(5, srcW / 120);
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = Math.max(1, lineWidth / 2);
      ctx.beginPath();
      ctx.moveTo(centerX - arm, centerY);
      ctx.lineTo(centerX + arm, centerY);
      ctx.moveTo(centerX, centerY - arm);
      ctx.lineTo(centerX, centerY + arm);
      ctx.stroke();
    }
  });

  if (settings.showTimestamp && Number.isFinite(options.timestampSeconds)) {
    const fps = Number.isFinite(options.timestampFps) && options.timestampFps > 0 ? options.timestampFps : 30;
    const totalFrames = Math.max(0, Math.floor(options.timestampSeconds * fps + 1e-6));
    const framesPerSecond = Math.round(fps);
    const minutes = Math.floor(totalFrames / (framesPerSecond * 60));
    const seconds = Math.floor(totalFrames / framesPerSecond) % 60;
    const frames = totalFrames % framesPerSecond;
    const timestamp = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(frames).padStart(2, '0')}`;
    const padding = Math.max(6, Math.round(fontPx * 0.35));
    const width = ctx.measureText(timestamp).width + padding * 2;
    const height = fontPx + padding * 2;
    ctx.fillStyle = 'rgb(3 18 10 / 0.78)';
    ctx.fillRect(Math.max(0, srcW - width - padding), padding, width, height);
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(timestamp, Math.max(0, srcW - width), padding * 2);
  }
}
