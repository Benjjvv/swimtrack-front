// Panel de cámara del Monitor: enchufa CameraController + DetectionLoop + dibujo de cajas.
// Widget autónomo (solo toca sus propios elementos del DOM) para no inflar monitor.js,
// que está al límite de 300 líneas que impone el PLAN.

import { CameraController } from './camera.js';
import { loadCocoSsd, DetectionLoop, drawDetections, clearCanvas } from './detection.js';

// Detecciones simuladas para "Modo Demo" (coords sobre un lienzo de 1280×720).
const DEMO_DETECTIONS = [
  { id: 'd1', bbox: [120, 90, 250, 150], score: 0.92, class: 'person' },
  { id: 'd2', bbox: [560, 170, 230, 160], score: 0.88, class: 'person' },
  { id: 'd3', bbox: [880, 120, 250, 150], score: 0.81, class: 'person' },
];

/** Cablea los botones Iniciar/Demo/Detener y el contador de personas detectadas. */
export function initCameraPanel() {
  const video = document.getElementById('cameraVideo');
  const img = document.getElementById('demoImage');
  const canvas = document.getElementById('cameraCanvas');
  const placeholder = document.getElementById('cameraPlaceholder');
  const countEl = document.getElementById('detectionCount');
  const startBtn = document.getElementById('startCameraBtn');
  const demoBtn = document.getElementById('demoModeBtn');
  const stopBtn = document.getElementById('stopCameraBtn');
  if (!video || !startBtn) return; // no estamos en la página Monitor

  const camera = new CameraController();
  /** @type {DetectionLoop|null} */
  let loop = null;

  const setCount = (n) => {
    countEl.textContent = String(n);
  };

  function stopCamera() {
    if (loop) {
      loop.stop();
      loop = null;
    }
    camera.stop();
    video.classList.add('d-none');
    stopBtn.classList.add('d-none');
    clearCanvas(canvas);
    setCount(0);
  }

  async function startCamera() {
    try {
      placeholder.classList.add('d-none');
      img.classList.add('d-none');
      video.classList.remove('d-none');
      await camera.start(video);
      stopBtn.classList.remove('d-none');
      // Cargar el modelo puede tardar unos segundos la primera vez.
      const model = await loadCocoSsd();
      loop = new DetectionLoop(model);
      loop.start(video, (dets) => {
        drawDetections(canvas, video, dets);
        setCount(dets.length);
      });
    } catch (err) {
      stopCamera();
      placeholder.textContent = err.message || 'No se pudo iniciar la cámara.';
      placeholder.classList.remove('d-none');
    }
  }

  function showDemo() {
    stopCamera();
    placeholder.classList.add('d-none');
    img.classList.remove('d-none');
    drawDetections(canvas, img, DEMO_DETECTIONS);
    setCount(DEMO_DETECTIONS.length);
  }

  startBtn.addEventListener('click', startCamera);
  demoBtn.addEventListener('click', showDemo);
  stopBtn.addEventListener('click', stopCamera);
}
