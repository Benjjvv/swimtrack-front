// Notificaciones tipo toast usando el componente de Bootstrap.

/**
 * Muestra un toast efímero en la esquina inferior derecha.
 * @param {string} message
 * @param {'success'|'danger'|'warning'|'info'|'primary'} [type='success']
 */
export function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  // Sin contenedor (o sin Bootstrap cargado) caemos a la consola.
  if (!container || typeof bootstrap === 'undefined') {
    console.log('[toast]', message);
    return;
  }

  const toastEl = document.createElement('div');
  toastEl.className = `toast align-items-center text-bg-${type} border-0`;
  toastEl.setAttribute('role', 'status');
  toastEl.setAttribute('aria-live', 'polite');

  const flex = document.createElement('div');
  flex.className = 'd-flex';

  const body = document.createElement('div');
  body.className = 'toast-body';
  body.textContent = message; // textContent evita inyección de HTML

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn-close btn-close-white me-2 m-auto';
  close.setAttribute('data-bs-dismiss', 'toast');
  close.setAttribute('aria-label', 'Cerrar');

  flex.append(body, close);
  toastEl.appendChild(flex);
  container.appendChild(toastEl);

  // eslint-disable-next-line no-undef
  const toast = new bootstrap.Toast(toastEl, { delay: 3000 });
  toast.show();
  toastEl.addEventListener('hidden.bs.toast', () => toastEl.remove());
}
