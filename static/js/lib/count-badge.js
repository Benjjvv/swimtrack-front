// Contador con animación: escribe el número y, cuando SUBE respecto al valor
// anterior, hace flotar un "+N" (verde) que se desvanece. Se usa en el Monitor
// para el count de cada frame de detección.

/**
 * Crea un actualizador de contador con animación de incremento.
 * `countEl` debe estar dentro de un elemento posicionado (position-relative):
 * el "+N" se ancla al padre para flotar al lado del número.
 * @param {HTMLElement} countEl <span> donde se escribe el número.
 * @returns {(n:number)=>void} llamalo con el nuevo count en cada frame.
 */
export function createCounter(countEl) {
  const anchor = countEl.parentElement || countEl;
  let prev = 0;
  return function setCount(n) {
    const value = Number(n) || 0;
    if (value > prev) popDelta(anchor, value - prev);
    countEl.textContent = String(value);
    prev = value;
  };
}

/** Inyecta un "+delta" flotante que se autodestruye al terminar la animación. */
function popDelta(anchor, delta) {
  const badge = document.createElement('span');
  badge.className = 'st-count-badge';
  badge.textContent = '+' + delta;
  badge.setAttribute('aria-hidden', 'true'); // decorativo; el número ya es accesible
  badge.addEventListener('animationend', () => badge.remove());
  anchor.appendChild(badge);
}
