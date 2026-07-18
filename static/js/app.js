// JS común: toggle de la sidebar y preferencias visuales de las detecciones.
import { initBoxDebugMenu } from './lib/debug-settings.js';

const app = document.getElementById('stApp');
const toggle = document.getElementById('sidebarToggle');

if (app && toggle) {
  const mobileQuery = window.matchMedia('(max-width: 768px)');

  toggle.addEventListener('click', function () {
    if (mobileQuery.matches) {
      app.classList.toggle('sidebar-open');
    } else {
      app.classList.toggle('sidebar-collapsed');
    }
  });

  // Si el viewport cruza el breakpoint, limpiar la clase de mobile.
  mobileQuery.addEventListener('change', function () {
    app.classList.remove('sidebar-open');
  });
}

initBoxDebugMenu();
