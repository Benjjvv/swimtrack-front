// Sincroniza el panel de detección (video + IA) con las Pistas del Monitor:
//  1) Timer ↔ video: al reproducir el video los cronómetros de las pistas
//     corren; al pausar/detener, se pausan. (Escucha los eventos que emite
//     camera-panel.js sobre el ciclo de vida del <video>.)
//  2) Largos IA → pista: mapea cada lane_id de la IA a una Pista y muestra el
//     conteo de largos detectados en vivo, SIN pisar el conteo manual.
// Módulo autónomo para no inflar monitor.js (límite ~300 líneas del PLAN).

/** lane_ids de la IA vistos en el stream (para poblar el selector). @type {Set<string>} */
const seenAiLanes = new Set();
/** Último conteo de largos por lane_id de la IA. @type {Record<string,number>} */
let aiLapCounts = {};

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

/** Largos IA acumulados para un lane_id de la IA (0 si no hay dato). */
export function aiLapCountFor(aiLaneId) {
  return aiLaneId && Number.isFinite(aiLapCounts[aiLaneId]) ? aiLapCounts[aiLaneId] : 0;
}

/**
 * HTML del selector "Carril IA" de una Pista: la mapea a un lane_id de la IA y
 * muestra los largos detectados para ese carril. Se inyecta dentro de
 * laneCard() de monitor.js. Sin carriles IA vistos aún, queda deshabilitado.
 * @param {{id:string, aiLaneId?:string}} lane
 */
export function renderAiSelector(lane) {
  const ids = [...seenAiLanes];
  const options = ['<option value="">— sin conectar IA —</option>']
    .concat(ids.map((id) => {
      const selected = lane.aiLaneId === id ? ' selected' : '';
      return `<option value="${escapeHtml(id)}"${selected}>${escapeHtml(id)}</option>`;
    }))
    .join('');
  const disabled = ids.length ? '' : ' disabled';
  return `
    <div class="mb-3">
      <label class="form-label small mb-1">Carril IA</label>
      <select class="form-select form-select-sm lane-ai-select"${disabled}>${options}</select>
      <div class="text-muted small mt-1">
        <i class="bi bi-robot me-1"></i>Largos IA:
        <span class="fw-semibold" data-ai-count="${lane.id}">${aiLapCountFor(lane.aiLaneId)}</span>
      </div>
    </div>`;
}

/**
 * Conecta los eventos del panel de detección con las Pistas del Monitor.
 * @param {{getLanes:()=>Array, getControl:(key:string)=>{start:()=>void,pause:()=>void}, requestRender:()=>void}} api
 */
export function initLaneSync({ getLanes, getControl, requestRender }) {
  const eachControl = (fn) => {
    getLanes().forEach((lane) => {
      lane.swimmerIds.forEach((sid) => fn(getControl(`${lane.id}::${sid}`)));
    });
  };
  const startAll = () => { eachControl((sw) => sw.start()); requestRender(); };
  const pauseAll = () => { eachControl((sw) => sw.pause()); requestRender(); };

  window.addEventListener('swimtrack:video-play', startAll);
  window.addEventListener('swimtrack:video-pause', pauseAll);
  window.addEventListener('swimtrack:video-stopped', pauseAll);

  // Cada frame la IA reporta el desglose por carril: actualizamos los contadores
  // in-place (barato) y sólo re-renderizamos si aparece un lane_id nuevo (raro),
  // para no reconstruir el DOM en cada frame.
  window.addEventListener('swimtrack:lap-by-lane', (e) => {
    aiLapCounts = e.detail && typeof e.detail === 'object' ? e.detail : {};
    let grew = false;
    Object.keys(aiLapCounts).forEach((id) => {
      if (!seenAiLanes.has(id)) { seenAiLanes.add(id); grew = true; }
    });
    if (grew) { requestRender(); return; } // el selector ganó opciones nuevas
    getLanes().forEach((lane) => {
      if (!lane.aiLaneId) return;
      const el = document.querySelector(`[data-ai-count="${lane.id}"]`);
      if (el) el.textContent = String(aiLapCountFor(lane.aiLaneId));
    });
  });
}
