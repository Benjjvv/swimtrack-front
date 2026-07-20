// Preferencias visuales del overlay de detecciones. Se guardan en el navegador
// para que los tres modos (cámara, demo y video subido) compartan la misma vista.

const STORAGE_KEY = 'swimtrack-box-debug-settings';

export const DEFAULT_BOX_DEBUG_SETTINGS = Object.freeze({
  showValues: true,
  showCenters: false,
  showTrails: false,
  lapConfidenceThreshold: 0.15,
});

function storageOrNull(storage) {
  if (storage) return storage;
  return typeof localStorage === 'undefined' ? null : localStorage;
}

/** Normaliza datos guardados antiguos o inválidos sin perder los defaults. */
export function normalizeBoxDebugSettings(value) {
  const rawLapConfidenceThreshold = value?.lapConfidenceThreshold;
  const lapConfidenceThreshold = typeof rawLapConfidenceThreshold === 'number'
    || (typeof rawLapConfidenceThreshold === 'string' && rawLapConfidenceThreshold.trim())
    ? Number(rawLapConfidenceThreshold) : Number.NaN;
  return {
    showValues: typeof value?.showValues === 'boolean'
      ? value.showValues : DEFAULT_BOX_DEBUG_SETTINGS.showValues,
    showCenters: typeof value?.showCenters === 'boolean'
      ? value.showCenters : DEFAULT_BOX_DEBUG_SETTINGS.showCenters,
    showTrails: typeof value?.showTrails === 'boolean'
      ? value.showTrails : DEFAULT_BOX_DEBUG_SETTINGS.showTrails,
    lapConfidenceThreshold: Number.isFinite(lapConfidenceThreshold)
      && lapConfidenceThreshold >= 0 && lapConfidenceThreshold <= 1
      ? lapConfidenceThreshold : DEFAULT_BOX_DEBUG_SETTINGS.lapConfidenceThreshold,
  };
}

/** Lee las preferencias; si localStorage no está disponible, usa los defaults. */
export function getBoxDebugSettings(storage) {
  try {
    const raw = storageOrNull(storage)?.getItem(STORAGE_KEY);
    return normalizeBoxDebugSettings(raw ? JSON.parse(raw) : null);
  } catch (_err) {
    return { ...DEFAULT_BOX_DEBUG_SETTINGS };
  }
}

/** Guarda un cambio parcial y devuelve la configuración efectiva. */
export function saveBoxDebugSettings(changes, storage) {
  const next = { ...getBoxDebugSettings(storage), ...changes };
  const settings = normalizeBoxDebugSettings(next);
  try {
    storageOrNull(storage)?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (_err) {
    // Privacidad del navegador o cuota llena: el control sigue funcionando
    // mientras la página está abierta gracias al evento que emitimos abajo.
  }
  return settings;
}

function emitSettingsChanged(settings) {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
  window.dispatchEvent(new CustomEvent('swimtrack:box-debug-settings-changed', {
    detail: settings,
  }));
}

/** Inicializa el menú Debug de la barra lateral si está presente en la página. */
export function initBoxDebugMenu() {
  const menu = document.getElementById('debugMenu');
  const toggle = document.getElementById('debugMenuToggle');
  const panel = document.getElementById('debugMenuOptions');
  if (!menu || !toggle || !panel) return;

  const inputs = [...menu.querySelectorAll('[data-box-debug-setting]')];
  const updateInputs = (settings) => {
    inputs.forEach((input) => {
      const value = settings[input.dataset.boxDebugSetting];
      if (input.type === 'checkbox') input.checked = value;
      else input.value = String(value);
    });
  };
  updateInputs(getBoxDebugSettings());

  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!expanded));
    panel.hidden = expanded;
  });

  inputs.forEach((input) => {
    input.addEventListener('change', () => {
      const settings = saveBoxDebugSettings({
        [input.dataset.boxDebugSetting]: input.type === 'checkbox'
          ? input.checked : input.value,
      });
      updateInputs(settings);
      emitSettingsChanged(settings);
    });
  });
}
