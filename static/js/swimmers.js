// Página Nadadores — CRUD persistido en localStorage.
// Patrón: estado en memoria + sync a localStorage en cada cambio + render() redibuja.

import { getItem, setItem, KEYS } from './lib/storage.js';
import { generateId } from './lib/format.js';

/**
 * @typedef {Object} Swimmer
 * @property {string} id
 * @property {string} name
 * @property {number|null} age
 * @property {'principiante'|'intermedio'|'avanzado'} level
 * @property {string} createdAt - ISO string
 */

const LEVELS = ['principiante', 'intermedio', 'avanzado'];
const LEVEL_BADGE = {
  principiante: 'text-bg-secondary',
  intermedio: 'text-bg-info',
  avanzado: 'text-bg-success',
};

/** @type {Swimmer[]} */
let swimmers = getItem(KEYS.SWIMMERS, []);
/** id del nadador en edición, o null si ninguno. @type {string|null} */
let editingId = null;

// --- Referencias al DOM ---
const form = document.getElementById('swimmerForm');
const nameInput = document.getElementById('swimmerName');
const ageInput = document.getElementById('swimmerAge');
const levelInput = document.getElementById('swimmerLevel');
const addAnonBtn = document.getElementById('addAnonBtn');
const tableBody = document.getElementById('swimmerTableBody');
const countEl = document.getElementById('swimmerCount');

// --- Persistencia ---
function persist() {
  setItem(KEYS.SWIMMERS, swimmers);
}

// --- Helpers ---
/** Escapa texto para insertarlo de forma segura en HTML. */
function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

/** Capitaliza la primera letra (para mostrar el nivel). */
function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/** Convierte la edad ingresada a número válido o null. */
function parseAge(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// --- Operaciones CRUD ---
/**
 * Agrega un nadador. Si anonymous=true, ignora el form y usa "Anónimo N".
 * @param {boolean} anonymous
 */
function addSwimmer(anonymous) {
  let name;
  let age;
  let level;

  if (anonymous) {
    name = 'Anónimo ' + (swimmers.length + 1);
    age = null;
    level = 'principiante';
  } else {
    name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }
    age = parseAge(ageInput.value);
    level = LEVELS.includes(levelInput.value) ? levelInput.value : 'intermedio';
  }

  swimmers.push({
    id: generateId(),
    name,
    age,
    level,
    createdAt: new Date().toISOString(),
  });
  persist();

  // Limpiar el form solo en alta normal.
  if (!anonymous) {
    nameInput.value = '';
    ageInput.value = '';
    levelInput.value = 'intermedio';
    nameInput.focus();
  }
  render();
}

/** Elimina un nadador por id. @param {string} id */
function deleteSwimmer(id) {
  swimmers = swimmers.filter((s) => s.id !== id);
  if (editingId === id) editingId = null;
  persist();
  render();
}

/** Pone una fila en modo edición. @param {string} id */
function startEdit(id) {
  editingId = id;
  render();
}

/** Cancela la edición en curso. */
function cancelEdit() {
  editingId = null;
  render();
}

/** Guarda los cambios de la fila en edición. @param {string} id */
function saveEdit(id) {
  const swimmer = swimmers.find((s) => s.id === id);
  if (!swimmer) return;

  const editName = tableBody.querySelector('.edit-name');
  const editAge = tableBody.querySelector('.edit-age');
  const editLevel = tableBody.querySelector('.edit-level');

  const newName = editName.value.trim();
  if (!newName) {
    editName.focus();
    return;
  }
  swimmer.name = newName;
  swimmer.age = parseAge(editAge.value);
  swimmer.level = LEVELS.includes(editLevel.value) ? editLevel.value : swimmer.level;

  editingId = null;
  persist();
  render();
}

// --- Render ---
/** Fila normal (modo lectura). @param {Swimmer} s @returns {string} */
function readRow(s) {
  const badge = LEVEL_BADGE[s.level] || 'text-bg-secondary';
  return `
    <tr data-id="${s.id}">
      <td>${escapeHtml(s.name)}</td>
      <td>${s.age != null ? s.age : '—'}</td>
      <td><span class="badge ${badge}">${escapeHtml(capitalize(s.level))}</span></td>
      <td class="text-end">
        <button class="btn btn-sm btn-outline-secondary" data-action="edit"
                aria-label="Editar ${escapeHtml(s.name)}">
          <i class="bi bi-pencil"></i>
        </button>
        <button class="btn btn-sm btn-outline-danger" data-action="delete"
                aria-label="Eliminar ${escapeHtml(s.name)}">
          <i class="bi bi-trash"></i>
        </button>
      </td>
    </tr>`;
}

/** Fila en modo edición (inputs inline). @param {Swimmer} s @returns {string} */
function editRow(s) {
  const options = LEVELS.map(
    (lvl) =>
      `<option value="${lvl}" ${lvl === s.level ? 'selected' : ''}>${capitalize(lvl)}</option>`
  ).join('');
  return `
    <tr data-id="${s.id}">
      <td><input type="text" class="form-control form-control-sm edit-name" value="${escapeHtml(s.name)}"></td>
      <td><input type="number" class="form-control form-control-sm edit-age" min="1" max="120" value="${s.age != null ? s.age : ''}"></td>
      <td><select class="form-select form-select-sm edit-level">${options}</select></td>
      <td class="text-end text-nowrap">
        <button class="btn btn-sm btn-success" data-action="save" aria-label="Guardar">
          <i class="bi bi-check-lg"></i>
        </button>
        <button class="btn btn-sm btn-outline-secondary" data-action="cancel" aria-label="Cancelar">
          <i class="bi bi-x-lg"></i>
        </button>
      </td>
    </tr>`;
}

/** Redibuja la tabla y el contador. */
function render() {
  countEl.textContent = String(swimmers.length);

  if (swimmers.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="4" class="text-center text-muted py-4">
          No hay nadadores registrados
        </td>
      </tr>`;
    return;
  }

  tableBody.innerHTML = swimmers
    .map((s) => (s.id === editingId ? editRow(s) : readRow(s)))
    .join('');
}

// --- Eventos ---
form.addEventListener('submit', (e) => {
  e.preventDefault();
  addSwimmer(false);
});

addAnonBtn.addEventListener('click', () => addSwimmer(true));

// Delegación: un único listener para todas las acciones de la tabla.
tableBody.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const row = btn.closest('tr[data-id]');
  if (!row) return;
  const id = row.dataset.id;

  switch (btn.dataset.action) {
    case 'edit':
      startEdit(id);
      break;
    case 'delete':
      deleteSwimmer(id);
      break;
    case 'save':
      saveEdit(id);
      break;
    case 'cancel':
      cancelEdit();
      break;
  }
});

// Enter guarda / Escape cancela mientras se edita.
tableBody.addEventListener('keydown', (e) => {
  if (!editingId) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    saveEdit(editingId);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelEdit();
  }
});

// Primer render.
render();
