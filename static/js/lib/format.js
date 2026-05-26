// Helpers de formato: tiempo, fecha, IDs.

/**
 * Formatea un tiempo en milisegundos como "mm:ss.cs".
 * Ej.: formatTime(83450) → "01:23.45"
 * @param {number} ms
 * @returns {string}
 */
export function formatTime(ms) {
  let safeMs = Number.isFinite(ms) && ms >= 0 ? ms : 0;
  const totalSeconds = Math.floor(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const centis = Math.floor((safeMs % 1000) / 10);
  return (
    String(minutes).padStart(2, '0') +
    ':' +
    String(seconds).padStart(2, '0') +
    '.' +
    String(centis).padStart(2, '0')
  );
}

/**
 * Formatea una fecha ISO como string localizado en español.
 * Ej.: formatDate("2026-05-26T14:30:00Z") → "26 may 2026, 14:30"
 * @param {string} isoString
 * @returns {string}
 */
export function formatDate(isoString) {
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('es-ES', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

/**
 * Genera un ID único. Usa crypto.randomUUID si está disponible,
 * con fallback a timestamp + random.
 * @returns {string}
 */
export function generateId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
