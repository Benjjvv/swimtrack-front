// Página Monitor — pistas, controles de nadador, cronómetro y conteo de largos.
// La cámara + detección viven en lib/camera-panel.js. Persiste pistas y sesiones en localStorage.

import { getItem, setItem, KEYS } from './lib/storage.js';
import { generateId, formatTime } from './lib/format.js';
import { Stopwatch } from './lib/stopwatch.js';
import { createCounter } from './lib/count-badge.js';
import { initCameraPanel } from './lib/camera-panel.js';
import { showToast } from './lib/toast.js';

// --- Estado ---
// Sin datos demo: si no hay nadadores registrados, el monitor arranca vacío.
// El onboarding (modal) los registrará antes de iniciar cámara o subir video.
/** @type {{id:string,name:string}[]} */
let swimmers = getItem(KEYS.SWIMMERS, []);
/** @type {{id:string,name:string,swimmerIds:string[]}[]} */
let lanes = getItem(KEYS.LANES, []);
// Si ya hay nadadores registrados pero ninguna pista, sembrar "Pista 1" con todos.
if (swimmers.length > 0 && lanes.length === 0) {
  lanes = [{ id: generateId(), name: 'Pista 1', swimmerIds: swimmers.map((s) => s.id) }];
  setItem(KEYS.LANES, lanes);
}

/** Cronómetros vivos por nadador-en-pista. clave = `laneId::swimmerId`. @type {Map<string,Stopwatch>} */
const controls = new Map();

const lanesContainer = document.getElementById('lanesContainer');
const addLaneBtn = document.getElementById('addLaneBtn');
// Dueño de #detectionCount = nº de nadadores REGISTRADOS (no lo que ve la IA).
const setDetectionCount = createCounter(document.getElementById('detectionCount'));

// --- Helpers ---
function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

function swimmerName(id) {
  const s = swimmers.find((x) => x.id === id);
  return s ? s.name : 'Nadador';
}

/** Devuelve (creando si hace falta) el cronómetro de un nadador-en-pista. */
function getControl(key) {
  let sw = controls.get(key);
  if (!sw) {
    sw = new Stopwatch({
      onTick: (elapsed) => {
        const el = document.querySelector(`[data-timer="${key}"]`);
        if (el) el.textContent = formatTime(elapsed);
      },
    });
    controls.set(key, sw);
  }
  return sw;
}

function disposeControl(key) {
  const sw = controls.get(key);
  if (sw) {
    sw.pause();
    controls.delete(key);
  }
}

function persistLanes() {
  setItem(KEYS.LANES, lanes);
}

// --- Operaciones: pistas ---
function addLane() {
  lanes.push({ id: generateId(), name: `Pista ${lanes.length + 1}`, swimmerIds: [] });
  persistLanes();
  render();
}

function deleteLane(laneId) {
  const lane = lanes.find((l) => l.id === laneId);
  if (lane) lane.swimmerIds.forEach((sid) => disposeControl(`${laneId}::${sid}`));
  lanes = lanes.filter((l) => l.id !== laneId);
  persistLanes();
  render();
}

function addSwimmerToLane(laneId, swimmerId) {
  const lane = lanes.find((l) => l.id === laneId);
  if (lane && swimmerId && !lane.swimmerIds.includes(swimmerId)) {
    lane.swimmerIds.push(swimmerId);
    persistLanes();
    render();
  }
}

function removeSwimmerFromLane(laneId, swimmerId) {
  const lane = lanes.find((l) => l.id === laneId);
  if (!lane) return;
  lane.swimmerIds = lane.swimmerIds.filter((id) => id !== swimmerId);
  disposeControl(`${laneId}::${swimmerId}`);
  persistLanes();
  render();
}

// --- Operaciones: cronómetro / largos ---
function toggleTimer(key) {
  const sw = getControl(key);
  if (sw.isRunning()) sw.pause(); else sw.start();
  render();
}
function resetTimer(key) { getControl(key).reset(); render(); }
function addLap(key) { getControl(key).addLap(); render(); }
function removeLap(key) { getControl(key).removeLap(); render(); }

function saveSession(laneId, swimmerId) {
  const key = `${laneId}::${swimmerId}`;
  const sw = getControl(key);
  const laps = sw.getLapTimes();
  if (laps.length === 0) {
    showToast('Registrá al menos un largo (botón +) antes de guardar.', 'warning');
    return;
  }
  const session = {
    id: generateId(),
    date: new Date().toISOString(),
    swimmerId,
    swimmerName: swimmerName(swimmerId),
    laps: laps.length,
    lapTimes: laps.map((l) => ({ lapNumber: l.lapNumber, time: l.time, timestamp: l.timestamp })),
    totalTime: laps.reduce((sum, l) => sum + l.time, 0),
  };
  const sessions = getItem(KEYS.SESSIONS, []);
  sessions.push(session);
  setItem(KEYS.SESSIONS, sessions);
  sw.reset();
  render();
  showToast(`Sesión de ${session.swimmerName} guardada (${session.laps} largos). Vela en Historial.`);
}

// --- Render ---
function swimmerControl(lane, swimmerId) {
  const key = `${lane.id}::${swimmerId}`;
  const sw = getControl(key);
  const laps = sw.getLapTimes();
  const running = sw.isRunning();
  const last4 = laps.slice(-4);
  const chips = last4.length
    ? last4
        .map(
          (l) =>
            `<span class="badge text-bg-secondary font-monospace">L${l.lapNumber} · ${formatTime(l.time)}</span>`
        )
        .join('')
    : '<span class="text-muted small">Sin largos aún</span>';

  return `
    <div class="st-swimmer-control border rounded p-3" data-lane="${lane.id}" data-swimmer="${swimmerId}">
      <div class="d-flex justify-content-between align-items-start mb-2">
        <div>
          <div class="fw-semibold">${escapeHtml(swimmerName(swimmerId))}</div>
          <div class="text-muted small">Largos: <span class="fw-semibold">${laps.length}</span></div>
        </div>
        <button class="btn btn-sm btn-outline-danger" data-action="remove-swimmer" aria-label="Quitar de la pista">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>

      <div class="fs-2 fw-semibold text-center font-monospace my-2" data-timer="${key}">${formatTime(sw.getElapsed())}</div>

      <div class="d-flex justify-content-center gap-2 mb-2">
        <button class="btn btn-sm ${running ? 'btn-warning' : 'btn-success'}" data-action="toggle">
          <i class="bi bi-${running ? 'pause-fill' : 'play-fill'}"></i> ${running ? 'Pausar' : 'Iniciar'}
        </button>
        <button class="btn btn-sm btn-outline-secondary" data-action="reset" aria-label="Reiniciar cronómetro">
          <i class="bi bi-arrow-counterclockwise"></i>
        </button>
      </div>

      <div class="d-flex justify-content-center align-items-center gap-3 mb-2">
        <button class="btn btn-sm btn-outline-secondary" data-action="lap-minus" aria-label="Quitar largo">
          <i class="bi bi-dash-lg"></i>
        </button>
        <span class="text-muted small">Largo</span>
        <button class="btn btn-sm btn-primary" data-action="lap-plus" aria-label="Sumar largo">
          <i class="bi bi-plus-lg"></i>
        </button>
      </div>

      <div class="d-flex flex-wrap gap-1 justify-content-center mb-2" style="min-height: 1.6rem;">${chips}</div>

      <div class="d-flex gap-2">
        <span class="d-inline-block flex-fill" tabindex="0" title="Próximamente — modo Pirámide">
          <button class="btn btn-sm btn-outline-info w-100" disabled>Modo Pirámide</button>
        </span>
        <button class="btn btn-sm btn-success flex-fill" data-action="save">
          <i class="bi bi-save"></i> Guardar Sesión
        </button>
      </div>
    </div>`;
}

function addSwimmerRow(lane) {
  const available = swimmers.filter((s) => !lane.swimmerIds.includes(s.id));
  if (available.length === 0) return '';
  const opts = available
    .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`)
    .join('');
  return `
    <div class="input-group input-group-sm mt-2" data-lane="${lane.id}">
      <select class="form-select lane-add-select" aria-label="Nadador a agregar">${opts}</select>
      <button class="btn btn-outline-primary" data-action="add-swimmer">
        <i class="bi bi-plus-lg"></i> Agregar nadador
      </button>
    </div>`;
}

function laneCard(lane) {
  const body = lane.swimmerIds.length
    ? lane.swimmerIds.map((sid) => swimmerControl(lane, sid)).join('')
    : '<div class="text-muted small">Sin nadadores en esta pista.</div>';
  return `
    <div class="card" data-lane="${lane.id}">
      <div class="card-body">
        <div class="d-flex justify-content-between align-items-center mb-3">
          <h3 class="h6 mb-0"><i class="bi bi-water me-2"></i>${escapeHtml(lane.name)}</h3>
          <button class="btn btn-sm btn-outline-danger" data-action="delete-lane" aria-label="Eliminar pista">
            <i class="bi bi-trash"></i>
          </button>
        </div>
        <div class="d-flex flex-column gap-3">${body}</div>
        ${addSwimmerRow(lane)}
      </div>
    </div>`;
}

function render() {
  lanesContainer.innerHTML = lanes.length
    ? lanes.map(laneCard).join('')
    : '<div class="text-muted">No hay pistas. Agregá una para empezar.</div>';
}

// --- Eventos ---
addLaneBtn.addEventListener('click', addLane);

lanesContainer.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;

  // Acciones a nivel de pista.
  if (action === 'delete-lane') {
    return deleteLane(btn.closest('.card[data-lane]').dataset.lane);
  }
  if (action === 'add-swimmer') {
    const group = btn.closest('[data-lane]');
    const select = group.querySelector('.lane-add-select');
    return addSwimmerToLane(group.dataset.lane, select && select.value);
  }

  // Acciones a nivel de control de nadador.
  const ctrl = btn.closest('.st-swimmer-control');
  if (!ctrl) return;
  const key = `${ctrl.dataset.lane}::${ctrl.dataset.swimmer}`;
  switch (action) {
    case 'toggle': return toggleTimer(key);
    case 'reset': return resetTimer(key);
    case 'lap-plus': return addLap(key);
    case 'lap-minus': return removeLap(key);
    case 'remove-swimmer': return removeSwimmerFromLane(ctrl.dataset.lane, ctrl.dataset.swimmer);
    case 'save': return saveSession(ctrl.dataset.lane, ctrl.dataset.swimmer);
  }
});

// Onboarding: cuando el modal registra nadadores, reflejarlos en el panel derecho.
window.addEventListener('swimtrack:swimmers-registered', (e) => {
  swimmers = getItem(KEYS.SWIMMERS, []);
  const sessionIds = (e.detail || []).map((s) => s.id);
  if (lanes.length === 0) {
    lanes = [{ id: generateId(), name: 'Pista 1', swimmerIds: [...sessionIds] }];
  } else {
    sessionIds.forEach((id) => { if (!lanes[0].swimmerIds.includes(id)) lanes[0].swimmerIds.push(id); });
  }
  persistLanes();
  setDetectionCount(swimmers.length);
  render();
});

// Eventos que arrancan/pausan cronómetros: sesión (todos) y guion de largos.
const forEachControl = (fn) => lanes.forEach((l) => l.swimmerIds.forEach((sid) => fn(getControl(`${l.id}::${sid}`))));
window.addEventListener('swimtrack:session-start', () => { forEachControl((sw) => sw.start()); render(); });
window.addEventListener('swimtrack:session-stop', () => { forEachControl((sw) => sw.pause()); render(); });
window.addEventListener('swimtrack:demo-lap', (e) => { // camera-panel avisa un largo
  const sid = e.detail && e.detail.swimmerId;
  const lane = lanes.find((l) => l.swimmerIds.includes(sid));
  if (lane) { getControl(`${lane.id}::${sid}`).addLap(); render(); }
});
setDetectionCount(swimmers.length);
render();
initCameraPanel(); // Cámara + detección: panel autónomo en lib/camera-panel.js.
