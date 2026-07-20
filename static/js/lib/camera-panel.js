// Panel de cámara del Monitor: enchufa CameraController + DetectionLoop + dibujo
// de cajas, y ofrece "Subir Video" como alternativa a la cámara. Widget autónomo
// (solo toca sus propios elementos del DOM) para no inflar monitor.js, que está
// al límite de 300 líneas que impone el PLAN.

import { CameraController } from './camera.js';
import {
  loadCocoSsd,
  DetectionLoop,
  createDetectionOverlayState,
  drawDetections,
  clearCanvas,
  resetDetectionOverlayState,
} from './detection.js';
import { DetectionPlayback } from './detection-playback.js';
import { createCounter } from './count-badge.js';
import { openOnboarding } from './swimmer-onboarding.js';
import { getItem, KEYS } from './storage.js';

// Detecciones simuladas para "Modo Demo" (coords sobre un lienzo de 1280×720).
const DEMO_DETECTIONS = [
  { id: 'd1', bbox: [120, 90, 250, 150], score: 0.92, class: 'person' },
  { id: 'd2', bbox: [560, 170, 230, 160], score: 0.88, class: 'person' },
  { id: 'd3', bbox: [880, 120, 250, 150], score: 0.81, class: 'person' },
];

/**
 * Antes de iniciar cámara o subir video exigimos al menos un nadador registrado.
 * Si no hay ninguno, abre el onboarding. Devuelve true si se puede continuar.
 * @returns {Promise<boolean>}
 */
async function ensureSwimmers() {
  if (getItem(KEYS.SWIMMERS, []).length > 0) return true;
  const chosen = await openOnboarding();
  return Array.isArray(chosen) && chosen.length > 0;
}

/** Cablea los botones Iniciar/Demo/Subir Video/Detener y el contador de personas. */
export function initCameraPanel() {
  const video = document.getElementById('cameraVideo');
  const img = document.getElementById('demoImage');
  const canvas = document.getElementById('cameraCanvas');
  const placeholder = document.getElementById('cameraPlaceholder');
  const loadingEl = document.getElementById('detectionLoading');
  const loadingLabelEl = document.getElementById('detectionLoadingLabel');
  const loadingDetailEl = document.getElementById('detectionLoadingDetail');
  const countEl = document.getElementById('detectionCount');
  const countLabelEl = document.getElementById('detectionCountLabel');
  const lapCountEl = document.getElementById('lapCount');
  const currentLengthEl = document.getElementById('currentLength');
  const startBtn = document.getElementById('startCameraBtn');
  const demoBtn = document.getElementById('demoModeBtn');
  const stopBtn = document.getElementById('stopCameraBtn');
  const uploadBtn = document.getElementById('uploadVideoBtn');
  const fileInput = document.getElementById('videoFileInput');
  if (!video || !startBtn) return; // no estamos en la página Monitor

  const camera = new CameraController();
  const setCount = createCounter(countEl); // escribe el count y anima "+N" al subir
  const setLapCount = lapCountEl
    ? createCounter(lapCountEl) : () => {}; // episodios shadow confirmados en el upload
  function setLapProgress(lapCount, byLane) {
    const normalizedLapCount = Number.isFinite(Number(lapCount))
      ? Math.max(0, Number(lapCount)) : 0;
    setLapCount(normalizedLapCount);
    if (currentLengthEl) currentLengthEl.textContent = String(normalizedLapCount + 1);
    // El Monitor conecta este desglose por carril IA a cada Pista (lane-sync.js).
    window.dispatchEvent(new CustomEvent('swimtrack:lap-by-lane', {
      detail: byLane && typeof byLane === 'object' ? byLane : {},
    }));
  }
  function setCountLabel(label) {
    if (countLabelEl) countLabelEl.textContent = label;
  }
  function setDetectionLoading(isBuffering) {
    if (!loadingEl) return;
    loadingEl.classList.toggle('d-none', !isBuffering);
    loadingEl.setAttribute('aria-hidden', String(!isBuffering));
    if (!isBuffering) {
      if (loadingLabelEl) loadingLabelEl.textContent = 'Cargando detecciones…';
      if (loadingDetailEl) loadingDetailEl.textContent = '';
    }
  }

  function setDetectionBufferTelemetry(telemetry) {
    if (!loadingEl || loadingEl.classList.contains('d-none')) return;
    const target = telemetry.reason === 'initial'
      ? telemetry.initialThreshold
      : telemetry.resumeThreshold;
    const reason = telemetry.reason === 'rebuffer' ? 'Sincronizando detecciones…' : 'Cargando detecciones…';
    const ahead = Number.isFinite(telemetry.bufferAhead) ? Math.max(0, telemetry.bufferAhead) : 0;
    if (loadingLabelEl) loadingLabelEl.textContent = reason;
    if (loadingDetailEl) {
      const rebuffers = telemetry.rebufferCount ? ` · Pausas: ${telemetry.rebufferCount}` : '';
      loadingDetailEl.textContent = `Buffer: ${ahead.toFixed(1)} / ${target.toFixed(1)} s${rebuffers}`;
    }
  }
  const playback = new DetectionPlayback(
    video,
    canvas,
    setCount,
    setDetectionLoading,
    setDetectionBufferTelemetry,
    setLapProgress,
  );
  const overlay = createDetectionOverlayState();
  /** @type {DetectionLoop|null} */
  let loop = null;
  /** @type {string|null} objectURL del video subido (hay que revocarlo). */
  let objectUrl = null;
  /** Último dibujo local, para reflejar un cambio de Debug sin esperar otro frame. */
  let lastLocalDraw = null;

  function drawLocalDetections(source, detections) {
    lastLocalDraw = { source, detections };
    drawDetections(canvas, source, detections, { overlay });
  }

  /** Frena cualquier modo activo (cámara, detección o playback) y resetea el stage. */
  function reset() {
    if (loop) { loop.stop(); loop = null; }
    playback.stop();
    setDetectionLoading(false);
    camera.stop();
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    video.pause();
    video.removeAttribute('src');
    video.srcObject = null;
    video.classList.add('d-none');
    stopBtn.classList.add('d-none');
    lastLocalDraw = null;
    resetDetectionOverlayState(overlay);
    clearCanvas(canvas);
    setCount(0);
    setCountLabel('persona(s) detectada(s)');
    setLapProgress(0);
    // Fin de sesión: el Monitor pausa los cronómetros de las pistas.
    window.dispatchEvent(new CustomEvent('swimtrack:video-stopped'));
  }

  async function startCamera() {
    reset();
    try {
      placeholder.classList.add('d-none');
      img.classList.add('d-none');
      video.classList.remove('d-none');
      await camera.start(video);
      setCountLabel('persona(s) visible(s)');
      stopBtn.classList.remove('d-none');
      // Cargar el modelo puede tardar unos segundos la primera vez.
      const model = await loadCocoSsd();
      loop = new DetectionLoop(model);
      loop.start(video, (dets) => {
        drawLocalDetections(video, dets);
        setCount(dets.length);
      });
    } catch (err) {
      reset();
      placeholder.textContent = err.message || 'No se pudo iniciar la cámara.';
      placeholder.classList.remove('d-none');
    }
  }

  function showDemo() {
    reset();
    placeholder.classList.add('d-none');
    img.classList.remove('d-none');
    setCountLabel('persona(s) visible(s)');
    drawLocalDetections(img, DEMO_DETECTIONS);
    setCount(DEMO_DETECTIONS.length);
  }

  // Sube un video a /api/detect y dibuja las detecciones que llegan por SSE.
  async function useUploadedVideo(file) {
    reset();
    try {
      placeholder.classList.add('d-none');
      img.classList.add('d-none');
      video.classList.remove('d-none');
      objectUrl = URL.createObjectURL(file);
      setCountLabel('persona(s) identificada(s)');
      stopBtn.classList.remove('d-none');
      const detectUrl = (fileInput && fileInput.dataset.detectUrl) || '/api/detect';
      await playback.start(objectUrl, file, detectUrl);
    } catch (err) {
      reset();
      placeholder.textContent = err.message || 'No se pudo procesar el video.';
      placeholder.classList.remove('d-none');
    }
  }

  startBtn.addEventListener('click', async () => {
    if (await ensureSwimmers()) startCamera();
  });
  demoBtn.addEventListener('click', showDemo);
  stopBtn.addEventListener('click', reset);
  // Ciclo de vida del video → el Monitor corre/pausa los cronómetros de pista.
  // El buffering ya pausa/reanuda el <video>, así que el timer queda sincronizado.
  video.addEventListener('play', () => {
    window.dispatchEvent(new CustomEvent('swimtrack:video-play'));
  });
  video.addEventListener('pause', () => {
    window.dispatchEvent(new CustomEvent('swimtrack:video-pause'));
  });
  window.addEventListener('swimtrack:box-debug-settings-changed', () => {
    if (lastLocalDraw) drawLocalDetections(lastLocalDraw.source, lastLocalDraw.detections);
  });
  if (uploadBtn && fileInput) {
    uploadBtn.addEventListener('click', async () => {
      if (await ensureSwimmers()) fileInput.click();
    });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (file) useUploadedVideo(file);
      fileInput.value = ''; // permite volver a elegir el mismo archivo
    });
  }
}
