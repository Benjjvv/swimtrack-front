// Página Historial — sesiones pasadas con filtro por nadador y expansión de largos.
// Patrón: estado en memoria + sync a localStorage al eliminar + render() redibuja.

import { getItem, setItem, KEYS } from './lib/storage.js';
import { formatTime, formatDate } from './lib/format.js';

/**
 * @typedef {Object} LapTime
 * @property {number} lapNumber
 * @property {number} time - ms
 * @property {string} timestamp - ISO
 */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {string} date - ISO
 * @property {string} swimmerId
 * @property {string} swimmerName
 * @property {number} laps
 * @property {LapTime[]} lapTimes
 * @property {number} totalTime - ms
 */

/** @type {Session[]} */
let sessions = getItem(KEYS.SESSIONS, []);
/** @type {{id:string,name:string}[]} */
let swimmers = getItem(KEYS.SWIMMERS, []);
/** swimmerId seleccionado en el filtro, o 'all'. @type {string} */
let currentFilter = 'all';
/** id de la sesión expandida, o null. @type {string|null} */
let expandedId = null;

// --- Referencias al DOM ---
const analyzeBtn = document.getElementById('analyzeBtn');
const filterSelect = document.getElementById('swimmerFilter');
const tableBody = document.getElementById('sessionTableBody');

// --- Helpers ---
function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

/** Sesiones visibles según el filtro, ordenadas por fecha desc. @returns {Session[]} */
function visibleSessions() {
  const list =
    currentFilter === 'all'
      ? sessions
      : sessions.filter((s) => s.swimmerId === currentFilter);
  return list.slice().sort((a, b) => new Date(b.date) - new Date(a.date));
}

// --- Operaciones ---
/** Elimina una sesión por id. @param {string} id */
function deleteSession(id) {
  sessions = sessions.filter((s) => s.id !== id);
  if (expandedId === id) expandedId = null;
  setItem(KEYS.SESSIONS, sessions);
  render();
}

/** Expande/colapsa la fila de una sesión. @param {string} id */
function toggleExpand(id) {
  expandedId = expandedId === id ? null : id;
  render();
}

// --- Render ---
/** Llena el select de filtro con los nadadores que tienen sesiones. */
function renderFilterOptions() {
  // Nadadores que aparecen en alguna sesión (incluye los ya borrados de swimmers).
  const seen = new Map();
  for (const s of sessions) {
    if (!seen.has(s.swimmerId)) seen.set(s.swimmerId, s.swimmerName);
  }
  // Preferir el nombre actual del nadador si todavía existe.
  for (const sw of swimmers) {
    if (seen.has(sw.id)) seen.set(sw.id, sw.name);
  }

  const opts = ['<option value="all">Todos</option>'];
  for (const [id, name] of seen) {
    const selected = id === currentFilter ? 'selected' : '';
    opts.push(`<option value="${escapeHtml(id)}" ${selected}>${escapeHtml(name)}</option>`);
  }
  filterSelect.innerHTML = opts.join('');
}

/** Fila principal de una sesión. @param {Session} s @returns {string} */
function sessionRow(s) {
  const isOpen = s.id === expandedId;
  const laps = s.laps != null ? s.laps : (s.lapTimes || []).length;
  return `
    <tr data-id="${s.id}" class="session-row" role="button" aria-expanded="${isOpen}">
      <td>${escapeHtml(formatDate(s.date))}</td>
      <td>${escapeHtml(s.swimmerName)}</td>
      <td>${laps}</td>
      <td class="font-monospace">${formatTime(s.totalTime)}</td>
      <td class="text-end text-nowrap">
        <button class="btn btn-sm btn-outline-secondary" data-action="expand"
                aria-label="${isOpen ? 'Colapsar' : 'Expandir'} largos">
          <i class="bi bi-chevron-${isOpen ? 'up' : 'down'}"></i>
        </button>
        <button class="btn btn-sm btn-outline-danger" data-action="delete"
                aria-label="Eliminar sesión">
          <i class="bi bi-trash"></i>
        </button>
      </td>
    </tr>`;
}

/** Fila expandida con los tiempos por largo como chips. @param {Session} s @returns {string} */
function detailRow(s) {
  const laps = (s.lapTimes || []).slice().sort((a, b) => a.lapNumber - b.lapNumber);
  const chips = laps.length
    ? laps
        .map(
          (lt) =>
            `<span class="badge text-bg-secondary font-monospace">
               L${lt.lapNumber} · ${formatTime(lt.time)}
             </span>`
        )
        .join('')
    : '<span class="text-muted">Sin tiempos por largo registrados.</span>';
  return `
    <tr class="session-detail" data-detail-for="${s.id}">
      <td colspan="5">
        <div class="d-flex flex-wrap gap-2 py-2">${chips}</div>
      </td>
    </tr>`;
}

/** Redibuja la tabla, el filtro y el botón "Analizar con IA". */
function render() {
  // El botón de análisis depende del total de sesiones, no del filtro.
  analyzeBtn.classList.toggle('d-none', sessions.length === 0);

  renderFilterOptions();

  if (sessions.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="5" class="text-center text-muted py-4">
          No hay sesiones registradas
        </td>
      </tr>`;
    return;
  }

  const list = visibleSessions();
  if (list.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="5" class="text-center text-muted py-4">
          No hay sesiones para este nadador
        </td>
      </tr>`;
    return;
  }

  tableBody.innerHTML = list
    .map((s) => sessionRow(s) + (s.id === expandedId ? detailRow(s) : ''))
    .join('');
}

// --- Eventos ---
filterSelect.addEventListener('change', () => {
  currentFilter = filterSelect.value;
  expandedId = null;
  render();
});

// Delegación: eliminar, o expandir al hacer click en cualquier parte de la fila.
tableBody.addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-id]');
  if (!row) return;
  const id = row.dataset.id;

  const deleteBtn = e.target.closest('button[data-action="delete"]');
  if (deleteBtn) {
    deleteSession(id);
    return;
  }
  toggleExpand(id);
});

// Primer render.
render();
