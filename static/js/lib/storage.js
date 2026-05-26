// Wrapper sobre localStorage con serialización JSON y manejo de errores.

/**
 * Lee un valor de localStorage y lo deserializa.
 * @template T
 * @param {string} key
 * @param {T} [defaultValue=null]
 * @returns {T}
 */
export function getItem(key, defaultValue = null) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultValue;
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[storage] getItem(${key}) error:`, err);
    return defaultValue;
  }
}

/**
 * Guarda un valor en localStorage serializándolo a JSON.
 * @param {string} key
 * @param {*} value
 * @returns {boolean} true si se guardó OK.
 */
export function setItem(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn(`[storage] setItem(${key}) error:`, err);
    return false;
  }
}

/**
 * Borra una clave de localStorage.
 * @param {string} key
 * @returns {boolean}
 */
export function removeItem(key) {
  try {
    localStorage.removeItem(key);
    return true;
  } catch (err) {
    console.warn(`[storage] removeItem(${key}) error:`, err);
    return false;
  }
}

// Claves canónicas que usa la app. Coincidir con el mockup.
export const KEYS = Object.freeze({
  SWIMMERS: 'swimcoach-swimmers',
  SESSIONS: 'swimcoach-sessions',
  LANES: 'swimcoach-lanes',
});
