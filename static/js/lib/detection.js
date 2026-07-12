// Detección de personas con TensorFlow.js + COCO-SSD (cargados del CDN bajo demanda).

/**
 * @typedef {Object} Detection
 * @property {string} id
 * @property {[number,number,number,number]} bbox - [x, y, w, h] en px de la fuente.
 * @property {number} score
 * @property {string} class
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

/**
 * Dibuja las cajas "Nadador N (XX%)" en el canvas. Iguala la resolución interna
 * del canvas a la de la fuente (video/imagen) para mapear las bbox 1:1; el CSS
 * estira el canvas al tamaño visible.
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLVideoElement|HTMLImageElement|null} source
 * @param {Detection[]} detections
 */
export function drawDetections(canvas, source, detections) {
  const srcW = (source && (source.videoWidth || source.naturalWidth)) || 1280;
  const srcH = (source && (source.videoHeight || source.naturalHeight)) || 720;
  if (canvas.width !== srcW || canvas.height !== srcH) {
    canvas.width = srcW;
    canvas.height = srcH;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.lineWidth = Math.max(2, srcW / 320);
  const fontPx = Math.max(14, Math.round(srcW / 60));
  ctx.font = `${fontPx}px sans-serif`;
  ctx.textBaseline = 'top';

  detections.forEach((d, i) => {
    const [x, y, w, h] = d.bbox;
    ctx.strokeStyle = '#22c55e';
    ctx.strokeRect(x, y, w, h);

    // Etiqueta con el id real si es numérico (detección server/playback);
    // si no (cámara/demo usan ids string), caemos al índice.
    const n = typeof d.id === 'number' ? d.id : i + 1;
    const label = `Nadador ${n} (${Math.round((d.score || 0) * 100)}%)`;
    const th = fontPx + 6;
    const tw = ctx.measureText(label).width + 8;
    const labelY = Math.max(0, y - th);
    ctx.fillStyle = '#22c55e';
    ctx.fillRect(x, labelY, tw, th);
    ctx.fillStyle = '#03120a';
    ctx.fillText(label, x + 4, labelY + 3);
  });
}
