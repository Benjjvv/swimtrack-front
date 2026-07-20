// Modal de onboarding del Monitor: registra los nadadores de la sesión antes de
// iniciar cámara o subir un video. Persiste las altas nuevas en KEYS.SWIMMERS y
// resuelve con la lista elegida. Reutiliza el modelo de nadador de la página
// Nadadores (mismo shape: {id,name,age,level,createdAt}).

import { getItem, setItem, KEYS } from './storage.js';
import { generateId } from './format.js';
import { normalizeSwimmer, mergeSwimmers } from './swimmer-model.js';

let modal = null;        // instancia bootstrap.Modal (lazy)
let resolveOpen = null;  // resolver de la Promise en curso
let confirmed = false;   // true si se cerró con "Empezar" (no cancelado)
/** Nadadores elegidos para la sesión (altas nuevas + guardados). @type {Object[]} */
let session = [];

const el = (id) => document.getElementById(id);

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

function capitalize(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}

/** Crea un Swimmer normalizado, generando id y fecha acá (parte impura). */
function createSwimmer(name, age, level) {
  return normalizeSwimmer({
    id: generateId(),
    name,
    age,
    level,
    createdAt: new Date().toISOString(),
  });
}

// --- Render ---
function renderSession() {
  const list = el('onbSessionList');
  list.innerHTML = session.length
    ? session
        .map(
          (s) => `
      <div class="d-flex justify-content-between align-items-center border rounded px-2 py-1" data-id="${escapeHtml(s.id)}">
        <span><i class="bi bi-person me-2"></i>${escapeHtml(s.name)}
          <span class="text-muted small">· ${capitalize(s.level)}${s.age ? ` · ${s.age} años` : ''}</span>
        </span>
        <button type="button" class="btn btn-sm btn-outline-danger py-0" data-action="remove" aria-label="Quitar">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>`
        )
        .join('')
    : '<div class="text-muted small">Todavía no agregaste nadadores.</div>';
  el('onbStartBtn').disabled = session.length === 0;
}

function renderSaved() {
  const wrap = el('onbSavedWrap');
  const list = el('onbSavedList');
  const inSession = new Set(session.map((s) => s.id));
  const saved = getItem(KEYS.SWIMMERS, []).filter((s) => !inSession.has(s.id));
  if (saved.length === 0) {
    wrap.classList.add('d-none');
    list.innerHTML = '';
    return;
  }
  wrap.classList.remove('d-none');
  list.innerHTML = saved
    .map(
      (s) => `
      <button type="button" class="btn btn-sm btn-outline-secondary" data-id="${escapeHtml(s.id)}">
        <i class="bi bi-plus-lg"></i> ${escapeHtml(s.name)}
      </button>`
    )
    .join('');
}

// --- Acciones ---
function addFromForm() {
  const name = el('onbName').value.trim();
  if (!name) { el('onbName').focus(); return; }
  session.push(createSwimmer(name, parseInt(el('onbAge').value, 10), el('onbLevel').value));
  el('onbName').value = '';
  el('onbAge').value = '';
  el('onbLevel').value = 'intermedio';
  el('onbName').focus();
  renderSession();
  renderSaved();
}

function addAnon() {
  session.push(createSwimmer(`Anónimo ${session.length + 1}`, NaN, 'principiante'));
  renderSession();
  renderSaved();
}

function onSessionClick(e) {
  const btn = e.target.closest('button[data-action="remove"]');
  if (!btn) return;
  const id = btn.closest('[data-id]').dataset.id;
  session = session.filter((s) => s.id !== id);
  renderSession();
  renderSaved();
}

function onSavedClick(e) {
  const btn = e.target.closest('button[data-id]');
  if (!btn) return;
  const sw = getItem(KEYS.SWIMMERS, []).find((s) => s.id === btn.dataset.id);
  if (sw && !session.some((s) => s.id === sw.id)) session.push(sw);
  renderSession();
  renderSaved();
}

function confirmStart() {
  if (session.length === 0) return;
  const { merged, added } = mergeSwimmers(getItem(KEYS.SWIMMERS, []), session);
  if (added.length) setItem(KEYS.SWIMMERS, merged);
  confirmed = true;
  window.dispatchEvent(new CustomEvent('swimtrack:swimmers-registered', { detail: session.slice() }));
  if (resolveOpen) { resolveOpen(session.slice()); resolveOpen = null; }
  modal.hide();
}

// --- Setup (una sola vez) ---
function ensureModal() {
  if (modal) return;
  const modalEl = el('onboardingModal');
  modal = new window.bootstrap.Modal(modalEl);
  el('onbAddBtn').addEventListener('click', addFromForm);
  el('onbAnonBtn').addEventListener('click', addAnon);
  el('onbStartBtn').addEventListener('click', confirmStart);
  el('onbSessionList').addEventListener('click', onSessionClick);
  el('onbSavedList').addEventListener('click', onSavedClick);
  el('onbName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addFromForm(); }
  });
  // Cerrar con la X/Cancelar/backdrop sin "Empezar" = cancelado.
  modalEl.addEventListener('hidden.bs.modal', () => {
    if (!confirmed && resolveOpen) { resolveOpen(null); resolveOpen = null; }
  });
}

/**
 * Abre el modal de onboarding. Resuelve con la lista de nadadores de la sesión
 * (>=1) o con null si el usuario canceló. Las altas nuevas quedan persistidas.
 * @returns {Promise<Object[]|null>}
 */
export function openOnboarding() {
  return new Promise((resolve) => {
    ensureModal();
    resolveOpen = resolve;
    confirmed = false;
    session = [];
    el('onbName').value = '';
    el('onbAge').value = '';
    el('onbLevel').value = 'intermedio';
    renderSession();
    renderSaved();
    modal.show();
  });
}
