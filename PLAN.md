# SwimTrack — Plan de implementación (Frontend Flask)

> **Cómo usar este documento (para Claude Code):**
> Este archivo es la fuente de verdad del proyecto. Antes de empezar cualquier tarea, leelo completo. Las tareas están numeradas y son atómicas: cada una corresponde a **un commit**. No saltes tareas, no mezcles tareas, no agregues features que no estén en la tarea actual. Si tenés dudas, preguntá antes de improvisar.

---

## Estado del proyecto

**Última actualización:** 2026-05-26

| # | Tarea | Estado | Commit |
|---|---|---|---|
| 1 | Esqueleto Flask + 5 páginas + layout base | ✅ Completada | `feat: esqueleto Flask con 5 páginas y layout base` |
| 2 | Módulos JS compartidos (`lib/`) | ✅ Completada | `feat(lib): módulos JS compartidos (storage, format, metrics, stopwatch)` |
| 3 | Página Nadadores (CRUD localStorage) | ✅ Completada | `feat: página de gestión de nadadores con localStorage` |
| 4 | Página Historial | ✅ Completada | `feat: página de historial con filtros y expansión de largos` |
| 5 | Monitor parte 1: estructura sin cámara | ✅ Completada | `feat: monitor (estructura, pistas, cronómetro y conteo de largos)` |
| 6 | Monitor parte 2: cámara + detección | ✅ Completada | `feat: monitor con cámara y detección COCO-SSD` |
| 7 | Análisis IA parte 1: métricas | ✅ Completada | `feat: análisis (selectores y métricas calculadas en cliente)` |
| 8 | Análisis IA parte 2: integración `/api/ai/analyze` | ✅ Completada | `feat: integración con módulo IA vía /api/ai/analyze` |
| 9 | Página Demo end-to-end | ✅ Completada | `feat: página demo end-to-end auto-contenida` |
| 10 | Pulido final + README | ✅ Completada | `chore: pulido final, accesibilidad y README` |

> **🎉 Las 10 tareas están code-complete.** Falta verificación en navegador (ver nota al final) — el entorno de esta máquina no tiene Flask/venv instalable. Los commits los hace el usuario.

### Lo que ya existe en el repo

**Backend Flask y configuración:**
- `app.py` — factory `create_app()` + 5 rutas + `POST /api/ai/analyze` que **proxea al Flask de IA** (`IA_BASE_URL/analyze` con header `X-Swimtrack-Auth`) y cae a `_mock_analysis(payload)` si la IA falla/timeout/no-JSON.
- `config.py` — `DevelopmentConfig` / `ProductionConfig` con `get_config()`.
- `.env.example`, `.gitignore`, `requirements.txt` (Flask 3, python-dotenv, requests).

**Templates Jinja:**
- `templates/base.html` — sidebar (5 items con íconos Bootstrap), header con toggle hamburguesa, bloques `content` y `scripts`, todas las URLs con `url_for()`.
- `templates/swimmers.html` — **implementado** (Tarea 3): card "Agregar Nadador" (form nombre/edad/nivel + botón Anónimo) y card "Nadadores Registrados (N)" con tabla y edición inline.
- `templates/history.html` — **implementado** (Tarea 4): título + botón "Analizar con IA" (oculto si no hay sesiones), select de filtro por nadador y tabla de sesiones con fila expandible.
- `templates/monitor.html` — **implementado** (Tareas 5 y 6): columna izquierda con stage de cámara (`<video>` + `<img>` demo + `<canvas>` superpuesto) y botones Iniciar/Modo Demo/Detener + contador de personas; columna derecha con `#lanesContainer` + botón "Agregar Pista".
- `templates/analysis.html` — **implementado** (Tareas 7 y 8): estado vacío, selectores nadador/sesión, 4 cards de métricas, card Coach IA (resumen/diagnóstico) y card de chat.
- `templates/demo.html` — **implementado** (Tarea 9): piscina con badge "Largo N / 10", grilla de 10 tiempos, card de análisis IA al final.
- `templates/base.html` — además del layout, ahora incluye `<meta name="st-analyze-url">` (URL del endpoint vía `url_for`, para soportar subpath) y el `#toastContainer`.

**Páginas con lógica (`static/js/`):**
- `swimmers.js` — CRUD de nadadores: `addSwimmer(anonymous)`, `deleteSwimmer`, `startEdit/saveEdit/cancelEdit`, `render()`. Delegación de eventos en el `<tbody>`, escape de HTML, Enter=guardar / Escape=cancelar en edición.
- `history.js` — historial: `visibleSessions()` (filtro + orden por fecha desc), `deleteSession`, `toggleExpand`, `render()`. Filtro poblado desde sesiones+nadadores (incluye nadadores ya borrados), chips de tiempos por largo en la fila expandida.
- `monitor.js` (291 líneas) — pistas + controles. `Map` de `Stopwatch` persistentes por `laneId::swimmerId`; `onTick` actualiza solo el `[data-timer]` vía querySelector, así `render()` reconstruye el DOM sin matar los timers. Demo mode si no hay nadadores (`DEMO_SWIMMERS`/`DEMO_LANES`, no persiste pistas). `saveSession` arma la `Session` desde `getLapTimes()` y la guarda en `swimcoach-sessions` (aparece en Historial) + toast. Modo Pirámide deshabilitado con tooltip nativo. La cámara se delega a `lib/camera-panel.js` (ver abajo).
- `analysis.js` (197 líneas) — lee swimmers+sessions, selectores nadador/sesión, 4 cards de métricas con `computeSessionMetrics` (fatiga en rojo si > 1500 ms), botones Resumen/Diagnóstico y chat que llaman a `analyze()` de `lib/ai-coach.js`. Estado vacío si no hay sesiones.
- `demo.js` (96 líneas) — 10 tiempos hardcodeados, `setInterval` cada 1.5 s revela los largos, al terminar muestra la card de IA y llama a `analyze({mode:'summary'})`. Botón pasa a "Reiniciar demo".

**Módulos JS de cámara/detección (`static/js/lib/`, Tarea 6):**
- `camera.js` — clase `CameraController` (`start(videoEl)`/`stop()`/`isActive()`), `getUserMedia` 1280×720 `facingMode:'environment'`, maneja permiso denegado / sin cámara.
- `detection.js` — `loadCocoSsd()` (inyecta los `<script>` UMD de TF.js 4.20 + COCO-SSD 2.2.3 del CDN bajo demanda, cachea el modelo), clase `DetectionLoop(model).start(videoEl, onDetections)/stop()` (filtra `person` con score > 0.4), y helpers `drawDetections(canvas, source, dets)` / `clearCanvas(canvas)`.
- `camera-panel.js` — **módulo extra, no estaba en el plan original**: `initCameraPanel()` cablea los botones del Monitor y el contador. Se creó porque meter ese glue (~55 líneas) en `monitor.js` lo pasaba de 300; el PLAN manda refactorizar a `lib/` al tocar el límite. Incluye `DEMO_DETECTIONS` (3 cajas) para el Modo Demo.

**Static:**
- `static/css/theme.css` — paleta completa del Apéndice A, layout (`.st-app`, `.st-sidebar`, `.st-main`, `.st-header`, `.st-content`), overrides de Bootstrap (card, form-control, btn-primary, table), responsive mobile.
- `static/js/app.js` — toggle de sidebar (clase `collapsed` desktop / `open` mobile).

**Módulos JS compartidos (`static/js/lib/`):**
- `storage.js` — `getItem(key, default)`, `setItem(key, value)`, `removeItem(key)`, `KEYS = {SWIMMERS: 'swimcoach-swimmers', SESSIONS: 'swimcoach-sessions', LANES: 'swimcoach-lanes'}`.
- `format.js` — `formatTime(ms)` → `"mm:ss.cs"`, `formatDate(isoString)`, `generateId()` (usa `crypto.randomUUID` con fallback).
- `metrics.js` — `computeSessionMetrics(session)` devuelve `{totalLaps, totalTime, avgLap, bestLap, worstLap, stdDev, consistencyScore, fatigueDelta}`.
- `stopwatch.js` — clase `Stopwatch` con `start/pause/stop/reset/getElapsed/addLap/removeLap/getLapTimes/isRunning` y callback `onTick(elapsed)`.
- `ai-coach.js` (Tarea 8) — `analyze(payload)` hace `POST` a la URL del `<meta st-analyze-url>`, timeout 30 s con `AbortController`, devuelve `{ok, analysis, mock, error}`.
- `toast.js` (Tarea 10) — `showToast(message, type)` crea un toast de Bootstrap en `#toastContainer` (usa `textContent`, sin riesgo de inyección).

### Smoke tests que pasaron
- `formatTime(83450) === "01:23.45"` ✓ (criterio explícito del plan)
- `computeSessionMetrics` con 6 largos: `consistencyScore=94.7%`, `fatigueDelta=+3000ms` ✓
- `Stopwatch.start() / pause()` cambia `isRunning()` correctamente ✓
- `python -m py_compile app.py config.py` OK ✓

### Próximo paso al retomar

**Todas las tareas (1-10) están code-complete.** Lo único pendiente es **verificación manual en navegador**, que no se pudo hacer en esta máquina (Python 3.12 sin `pip`/`venv`/`ensurepip`; falta `python3.12-venv` o `pip`). Para verificar, en una máquina con Flask:

```bash
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt && cp .env.example .env
flask --app app run --port 7001 --debug   # http://localhost:7001
```

Checklist de verificación (criterios de aceptación de cada tarea):
- **Nadadores:** agregar / anónimo / editar inline / eliminar / persiste al refrescar.
- **Monitor:** demo con 2 pistas × 2 nadadores; cronómetro +/- largos; Guardar Sesión → aparece en Historial (toast). Cámara pide permiso (localhost) y dibuja cajas tras ~3 s; Modo Demo dibuja 3 cajas sin internet.
- **Historial:** filtro por nadador, expandir largos, eliminar.
- **Análisis:** selectores, 4 métricas (fatiga roja si > 1500 ms), botones IA y chat muestran el texto (mock si la IA no está arriba).
- **Demo:** corre 10 largos en ~15 s y muestra el análisis al final.

> Validaciones automáticas que sí corrieron: `node --check` en los 15 JS (OK), todos < 300 líneas, `py_compile app.py config.py` (OK), sin imports absolutos ni URLs hardcodeadas en templates.

### Aclaración importante sobre el flujo de datos

La IA del compañero **no genera los datos crudos de la app**. Su rol es solo devolver **texto de análisis** (resumen ejecutivo, diagnóstico técnico, respuestas del coach chat).

| Quién genera qué | Cómo |
|---|---|
| Nadadores | El usuario los carga manualmente en `/swimmers` (Tarea 3) |
| Sesiones / tiempos por largo | Cronómetro del Monitor + botones `+/-` (Tareas 5-6) — conteo manual |
| Detección de personas (cajas) | TensorFlow.js + COCO-SSD en el navegador (Tarea 6), NO la IA del otro repo |
| Análisis textual / coach | La IA del otro repo vía `/api/ai/analyze` (Tarea 8) |

Re-confirmado en la Tarea 6: "las cajas se dibujan pero NO disparan eventos de 'largo completado'. El usuario sigue contando con +/-." → la cuenta de largos es manual incluso con la IA conectada.

---

## 0. Contexto del proyecto

**SwimTrack** es un sistema de visión por computadora para entrenamiento de natación. Una cámara fija detecta nadadores, cuenta largos automáticamente y mide tiempos. Libera al entrenador de contar manualmente.

**Esto es solo el frontend.** El módulo de IA real lo desarrolla otra persona en un repo aparte. Nosotros dejamos un punto de integración limpio (un endpoint HTTP) que cuando esté lista la IA se conecta sin tocar el resto.

**Lo que existe ya:**
- Un mockup en React/Vite/TypeScript con Tailwind + shadcn/ui (NO usar este código directamente; usar como referencia visual y de lógica).
- Una arquitectura del curso (Ejercicio 2): Apache + dos Flask separados (front e IA) con un header secreto compartido entre ellos.

**Lo que vamos a construir:**
- Una app Flask que sirve HTML con Jinja + Bootstrap 5 + JavaScript vanilla.
- 5 páginas: Monitor, Nadadores, Historial, Análisis IA, Demo.
- Detección de personas con TensorFlow.js + COCO-SSD cargado desde CDN en el navegador.
- Persistencia en `localStorage` del cliente (nadadores, sesiones, pistas).
- Un endpoint `/api/ai/analyze` que hace de proxy hacia el Flask de IA con el header secreto. Si la IA no responde, devuelve un mock.

**Lo que NO vamos a construir (en este entregable):**
- No hay base de datos en el server.
- No hay autenticación.
- No hay backend de IA (eso es otro repo, otra persona).
- No hay TypeScript ni build step.

---

## 1. Stack y decisiones técnicas

| Capa | Decisión | Razón |
|---|---|---|
| Backend | Flask 3.x | Pedido del curso |
| Templating | Jinja2 (viene con Flask) | Estándar |
| CSS | Bootstrap 5.3 desde CDN + un `theme.css` propio | Bootstrap por simplicidad; tema custom para conservar el look del mockup |
| Iconos | Bootstrap Icons desde CDN | Un solo ecosistema |
| Fuentes | Inter + JetBrains Mono desde Google Fonts | Igual al mockup |
| JS | Vanilla puro, módulos ES6 (`<script type="module">`) | Sin build step |
| Detección | TensorFlow.js + COCO-SSD desde CDN | Igual al mockup, corre en el navegador |
| Persistencia cliente | `localStorage` | Igual al mockup |
| Comunicación con IA | `fetch` a `/api/ai/analyze` (Flask front hace proxy a Flask IA con header secreto) | Patrón del Ejercicio 2c |
| Variables sensibles | `.env` (no se sube al repo); `.env.example` sí se sube | Buena práctica |
| Versión Python | 3.10+ recomendado, 3.8+ aceptable | Compatible con Flask 3 |

**Decisiones de diseño tomadas:**
- **Tema oscuro** con cyan/azul piscina (`hsl(199, 89%, 48%)`) como primario. Detalles exactos en Apéndice A.
- **Sidebar fija** a la izquierda, colapsable en mobile.
- **Modo Pirámide** del Swimmer Control: queda en el HTML pero deshabilitado con badge "Próximamente". No hay que implementar su lógica.
- **Subpath en server**: `/swimtrack/`. En local: `/`. Controlado por la variable `URL_PREFIX`.
- **Puertos**: Flask front en `7001`, Flask IA en `7011` (convención del curso).

---

## 2. Estructura de carpetas final

```
swimtrack-front/
├── app.py                          # Flask + las 5 rutas + proxy a IA
├── config.py                       # Config dev/prod desde .env
├── requirements.txt
├── .env.example                    # Plantilla (SÍ se sube)
├── .env                            # Real (NO se sube)
├── .gitignore
├── PLAN.md                         # Este archivo
├── README.md                       # Cómo correr
├── templates/
│   ├── base.html                   # Layout: sidebar + header + bloque content
│   ├── monitor.html
│   ├── swimmers.html
│   ├── history.html
│   ├── analysis.html
│   └── demo.html
└── static/
    ├── css/
    │   └── theme.css               # Tema oscuro sobre Bootstrap
    ├── js/
    │   ├── lib/
    │   │   ├── storage.js          # Wrapper sobre localStorage
    │   │   ├── format.js           # formatTime, formatDate, generateId
    │   │   ├── metrics.js          # computeSessionMetrics
    │   │   ├── stopwatch.js        # Cronómetro
    │   │   ├── camera.js           # getUserMedia
    │   │   ├── detection.js        # COCO-SSD + bucle de detección
    │   │   └── ai-coach.js         # fetch a /api/ai/analyze
    │   ├── app.js                  # JS común (sidebar toggle)
    │   ├── monitor.js              # Lógica página Monitor
    │   ├── swimmers.js             # Lógica página Nadadores
    │   ├── history.js              # Lógica página Historial
    │   ├── analysis.js             # Lógica página Análisis
    │   └── demo.js                 # Lógica página Demo
    └── img/
        ├── logo.jpg                # (copiar del mockup)
        └── demo-pool.jpg           # (copiar del mockup)
```

**Reglas que Claude Code debe respetar:**
- Un archivo `.js` por página + módulos en `lib/` para lógica compartida.
- Ningún archivo JS supera 300 líneas. Si crece, refactorizar a módulos en `lib/`.
- Los templates Jinja NO contienen JS inline largo (solo `<script src="...">`).
- Las URLs en HTML usan SIEMPRE `{{ url_for('endpoint') }}` o `{{ url_for('static', filename='...') }}`, nunca strings hardcodeadas tipo `/swimmers` o `/static/css/theme.css`. Esto es CRÍTICO para que funcione bajo subpath en el server.

---

## 3. Tarea 1 — Esqueleto del proyecto

**Objetivo:** Que el proyecto corra en local con `flask run` y muestre las 5 páginas vacías navegables con la sidebar funcionando.

**Archivos a crear:**

`.gitignore`:
```
__pycache__/
*.py[cod]
venv/
.venv/
env/
.env
.env.local
.vscode/
.idea/
.DS_Store
*.log
instance/
```

`.env.example` (con comentarios explicativos):
```
FLASK_ENV=development
FLASK_RUN_PORT=7001
URL_PREFIX=/
IA_BASE_URL=http://localhost:7011
IA_SECRET_HEADER=cambiame-por-algo-aleatorio-12345
FLASK_SECRET_KEY=dev-secret-change-in-prod
```

`requirements.txt`:
```
Flask>=3.0.0
python-dotenv>=1.0.0
requests>=2.31.0
```

`config.py`:
- Carga `.env` con `python-dotenv`.
- Clase `Config` base con `SECRET_KEY`, `URL_PREFIX`, `IA_BASE_URL`, `IA_SECRET_HEADER`.
- Subclases `DevelopmentConfig` (DEBUG=True) y `ProductionConfig` (DEBUG=False).
- Función `get_config()` que devuelve la apropiada según `FLASK_ENV`.

`app.py`:
- Patrón factory: función `create_app()`.
- 5 rutas: `/`, `/swimmers`, `/history`, `/analysis`, `/demo`. Cada una renderiza su template con `active="monitor"` (etc) para resaltar el item activo en la sidebar.
- Una ruta `POST /api/ai/analyze` que por ahora devuelve `{"ok": True, "mock": True, "analysis": "Pendiente — implementar en tarea 9"}`.
- Al final, bloque `if __name__ == "__main__":` que corre con el puerto de `.env`.

`README.md`:
- Cómo crear el venv.
- Cómo instalar dependencias.
- Cómo copiar `.env.example` a `.env`.
- Cómo correr.
- URL local de prueba.

**Para los templates: no implementar todavía nada complejo.** Solo:

`templates/base.html`:
- `<!doctype html>` con `<html lang="es" data-bs-theme="dark">`.
- En `<head>`:
  - Bootstrap 5.3 CSS desde CDN (`https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css`).
  - Bootstrap Icons desde CDN (`https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.css`).
  - Google Fonts (Inter + JetBrains Mono).
  - `{{ url_for('static', filename='css/theme.css') }}`.
- En `<body>`:
  - Un `<div class="st-app">` que contiene:
    - Sidebar `<aside class="st-sidebar" id="sidebar">` con brand "SwimTrack" e items: Monitor, Nadadores, Historial, Análisis IA, Demo. Cada item usa `class="st-nav-link {% if active == 'monitor' %}active{% endif %}"`.
    - `<div class="st-main">` con header (botón hamburguesa con id `sidebarToggle` + título "SwimTrack") y `<main class="st-content">{% block content %}{% endblock %}</main>`.
- Antes de `</body>`:
  - Bootstrap bundle JS desde CDN.
  - `{{ url_for('static', filename='js/app.js') }}`.
  - `{% block scripts %}{% endblock %}` para que páginas hijas inyecten su JS.

`templates/monitor.html`, `swimmers.html`, `history.html`, `analysis.html`, `demo.html`:
- Cada uno extiende `base.html` y en `{% block content %}` solo pone un `<h1>` con el nombre de la página y un párrafo "TODO: implementar". Nada más por ahora.

`static/css/theme.css`:
- Ver Apéndice A. Implementar todas las variables CSS y los selectores para layout (`.st-app`, `.st-sidebar`, `.st-nav-link`, `.st-main`, `.st-header`, `.st-content`) y para sobrescribir Bootstrap (`.card`, `.form-control`, `.btn-primary`, `.table`).

`static/js/app.js`:
- Solo el toggle de la sidebar (clase `collapsed` en desktop, `open` en mobile).

**Criterios de aceptación:**
- [ ] `python -m venv venv && source venv/bin/activate && pip install -r requirements.txt && cp .env.example .env && flask --app app run --port 7001` arranca sin errores.
- [ ] `http://localhost:7001/` muestra la sidebar con 5 items y el contenido "Monitor — TODO".
- [ ] Click en cada item navega correctamente y resalta el item activo.
- [ ] El botón hamburguesa colapsa/expande la sidebar.
- [ ] Tema oscuro visible (fondo oscuro, primario cyan).
- [ ] `git status` no muestra `.env` ni `venv/` (gitignore funciona).

**Commit sugerido:** `feat: esqueleto Flask con 5 páginas y layout base`

**NO hacer en esta tarea:**
- No implementar lógica de páginas todavía.
- No incluir TensorFlow.js todavía.
- No tocar `localStorage`.
- No conectarse a la IA.

---

## 4. Tarea 2 — Módulos JS compartidos (`lib/`)

**Objetivo:** Crear los módulos JS reutilizables que las páginas van a usar.

**Archivos a crear:**

`static/js/lib/storage.js`:
- Exporta funciones `getItem(key, defaultValue)`, `setItem(key, value)`, `removeItem(key)`.
- Internamente usan `localStorage` con `JSON.parse`/`JSON.stringify` y manejan errores (quota, JSON inválido).
- Keys que se usarán: `swimcoach-swimmers`, `swimcoach-sessions`, `swimcoach-lanes` (igual que el mockup).

`static/js/lib/format.js`:
- `formatTime(ms)` → `"01:23.45"` (mm:ss.cs). Ver implementación exacta en el mockup (`src/lib/format.ts`).
- `formatDate(isoString)` → fecha localizada en español (`"26 may 2026, 14:30"`).
- `generateId()` → `crypto.randomUUID()` con fallback.

`static/js/lib/metrics.js`:
- `computeSessionMetrics(session)` → objeto con `totalLaps`, `totalTime`, `avgLap`, `bestLap`, `worstLap`, `stdDev`, `consistencyScore`, `fatigueDelta`.
- Misma lógica que `src/lib/metrics.ts` del mockup.

`static/js/lib/stopwatch.js`:
- Clase `Stopwatch` con métodos `start()`, `pause()`, `stop()`, `reset()`, `getElapsed()`, `addLap()`, `removeLap()`, `getLapTimes()`.
- Internamente maneja `setInterval` y acumula tiempo.
- Soporta callback `onTick(elapsed)` para actualizar la UI.

**Criterios de aceptación:**
- [ ] Los 4 archivos existen y exportan funciones/clases con `export`.
- [ ] Se pueden importar con `import { ... } from './lib/storage.js'`.
- [ ] Probar en consola del navegador: cargar una página, en DevTools hacer `import('/static/js/lib/format.js').then(m => console.log(m.formatTime(83450)))` debe devolver `"01:23.45"`.

**Commit sugerido:** `feat(lib): módulos JS compartidos (storage, format, metrics, stopwatch)`

**NO hacer:**
- No agregar lógica de UI todavía.
- No importar estos módulos desde templates aún.

---

## 5. Tarea 3 — Página Nadadores (más simple, ideal para validar el patrón)

**Objetivo:** CRUD de nadadores funcionando con localStorage. Esta tarea valida el patrón Jinja + JS vanilla que vamos a repetir.

**Referencia visual y de lógica:** `swim-vision-main/src/components/SwimmerManager.tsx` y `swim-vision-main/src/pages/Swimmers.tsx` del mockup.

**Qué implementar:**

`templates/swimmers.html`:
- Card 1: "Agregar Nadador" con form (nombre, edad, nivel — select con principiante/intermedio/avanzado) y dos botones: "Agregar" y "Agregar Anónimo".
- Card 2: "Nadadores Registrados (N)" con tabla. Cada fila: nombre, edad, nivel, botones editar/eliminar.
- El modo edición es inline en la tabla (la fila se transforma en inputs).

`static/js/swimmers.js`:
- Importa `getItem`, `setItem` de `lib/storage.js` y `generateId` de `lib/format.js`.
- Maneja todo el estado en memoria + sincroniza con localStorage en cada cambio.
- Funciones: `addSwimmer(anonymous)`, `deleteSwimmer(id)`, `startEdit(id)`, `saveEdit()`, `cancelEdit()`, `render()`.
- `render()` redibuja la tabla y el contador.
- Para nombres anónimos: `"Anónimo " + (N+1)` donde N es la cantidad existente.

`templates/swimmers.html` debe terminar con:
```html
{% block scripts %}
<script type="module" src="{{ url_for('static', filename='js/swimmers.js') }}"></script>
{% endblock %}
```

**Criterios de aceptación:**
- [ ] Agregar un nadador con nombre + edad + nivel → aparece en la tabla.
- [ ] Agregar anónimo → aparece como "Anónimo 1", "Anónimo 2", etc.
- [ ] Editar inline → cambia y persiste.
- [ ] Eliminar → desaparece.
- [ ] Refrescar la página → los datos persisten (localStorage).
- [ ] Contador "(N)" refleja el total.

**Commit sugerido:** `feat: página de gestión de nadadores con localStorage`

---

## 6. Tarea 4 — Página Historial

**Objetivo:** Tabla de sesiones pasadas con filtro por nadador y vista expandible de tiempos por largo.

**Referencia:** `src/components/SessionHistory.tsx` + `src/pages/HistoryPage.tsx`.

**Qué implementar:**

`templates/history.html`:
- Header con título "Historial de Sesiones" y botón "Analizar con IA" (link a `/analysis`, se muestra solo si hay sesiones).
- Card con select de filtro (por nadador) y tabla: Fecha, Nadador, Largos, Tiempo Total, acciones (expandir + eliminar).
- Al click en una fila, se expande mostrando los tiempos de cada largo como chips.
- Si no hay sesiones: mensaje "No hay sesiones registradas".

`static/js/history.js`:
- Lee `swimcoach-swimmers` y `swimcoach-sessions` de localStorage.
- Maneja: filtro actual, fila expandida, eliminar sesión.
- `render()` redibuja la tabla.

**Criterios de aceptación:**
- [ ] Si no hay sesiones, muestra el mensaje vacío y NO muestra el botón "Analizar con IA".
- [ ] El filtro por nadador funciona.
- [ ] Click en fila expande/colapsa tiempos por largo.
- [ ] Botón eliminar borra la sesión y actualiza localStorage.

**Commit sugerido:** `feat: página de historial con filtros y expansión de largos`

---

## 7. Tarea 5 — Página Monitor (parte 1: estructura sin cámara)

> **Importante:** la página Monitor es la más compleja. La dividimos en 3 tareas: estructura, cámara/detección, cronómetro/largos.

**Objetivo:** Layout completo del Monitor con datos de demo. Sin cámara real todavía.

**Referencia:** `src/pages/Index.tsx`, `src/components/LaneCard.tsx`, `src/components/SwimmerControl.tsx`.

**Qué implementar:**

`templates/monitor.html`:
- Layout en dos columnas (flex en desktop, stack en mobile):
  - Izquierda: contenedor para el feed de cámara (placeholder con botón "Iniciar Cámara" y "Modo Demo"). Debajo, indicador "N persona(s) detectada(s)".
  - Derecha: panel con cards de pista (Lane Cards). Cada LaneCard tiene: título, lista de nadadores con su control (cronómetro + contador de largos + modo pirámide deshabilitado). Botón "Agregar Pista" al final.

`static/js/monitor.js`:
- Si no hay nadadores en localStorage → modo demo: usar `DEMO_SWIMMERS` y `DEMO_LANES` hardcodeados (ver `src/pages/Index.tsx`).
- Maneja: agregar/eliminar pista, agregar/quitar nadador de pista, render de LaneCards.
- Cada SwimmerControl: cronómetro (usa la clase `Stopwatch` de `lib/`), botones +/- largos, lista de últimos 4 tiempos, botón "Guardar Sesión".

**Modo Pirámide:** el botón existe pero está disabled, con tooltip "Próximamente".

**Criterios de aceptación:**
- [ ] Si localStorage está vacío, muestra dos pistas demo con 2 nadadores cada una.
- [ ] Si hay nadadores reales, muestra los registrados.
- [ ] Cronómetro inicia/pausa/detiene.
- [ ] +/- largos funcionan.
- [ ] Guardar sesión: la sesión aparece en `/history`.
- [ ] Botón modo pirámide está deshabilitado con tooltip.

**Commit sugerido:** `feat: monitor (estructura, pistas, cronómetro y conteo de largos)`

---

## 8. Tarea 6 — Página Monitor (parte 2: cámara + detección)

**Objetivo:** Que el botón "Iniciar Cámara" pida permisos, muestre el video, y dibuje bounding boxes con TensorFlow.js + COCO-SSD.

**Referencia:** `src/hooks/useCamera.ts`, `src/hooks/useDetection.ts`, `src/components/CameraFeed.tsx`.

**Qué implementar:**

`static/js/lib/camera.js`:
- Clase `CameraController` con `start(videoEl)`, `stop()`. Usa `navigator.mediaDevices.getUserMedia` con `facingMode: 'environment'` y 1280x720.
- Maneja errores (permiso denegado, no hay cámara).

`static/js/lib/detection.js`:
- Función `loadCocoSsd()` que carga TensorFlow.js + COCO-SSD desde CDN dinámicamente (`import()` desde URLs CDN).
- Clase `DetectionLoop` con `start(videoEl, onDetections)`, `stop()`. Filtra solo `class === 'person'` y score > 0.4.

**En `monitor.html`:**
- Reemplazar el placeholder por:
  - `<video>` oculto + `<canvas>` superpuesto para dibujar bounding boxes.
  - Botones "Iniciar Cámara", "Modo Demo", "Detener".

**En `monitor.js`:**
- Integrar `CameraController` y `DetectionLoop`.
- En cada frame: limpiar canvas, dibujar el video (no es necesario si usás `<video>` visible bajo el canvas), dibujar las cajas con label "Nadador N (XX%)".
- Modo demo: en vez de detecciones reales, usar las 3 detecciones hardcodeadas (`DEMO_DETECTIONS` del mockup) sobre la imagen `demo-pool.jpg`.

**CDNs sugeridos:**
- TensorFlow.js: `https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js`
- COCO-SSD: `https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js`

Cargar como `<script>` global en `monitor.html` (no como módulo ES, porque estas libs exponen globales).

**Criterios de aceptación:**
- [ ] "Iniciar Cámara" pide permiso y muestra el video.
- [ ] Después de cargar el modelo (~3 seg), aparecen cajas verdes sobre personas detectadas.
- [ ] El contador "N persona(s) detectada(s)" se actualiza.
- [ ] "Modo Demo" muestra la imagen de piscina con 3 cajas simuladas.
- [ ] "Detener" libera la cámara.

**Commit sugerido:** `feat: monitor con cámara y detección COCO-SSD`

**NO hacer:**
- No implementar conteo automático de largos (eso es de la IA real, no nuestro).
- Las cajas se dibujan, pero NO disparan eventos de "largo completado". El usuario sigue contando con +/-.

---

## 9. Tarea 7 — Página Análisis IA (parte 1: métricas)

**Objetivo:** Selectores de nadador/sesión + cards de métricas calculadas en el cliente. Sin llamada a la IA todavía.

**Referencia:** `src/pages/Analysis.tsx`.

**Qué implementar:**

`templates/analysis.html`:
- Header con título.
- Card con dos selects: "Nadador" (Todos + lista) y "Sesión" (lista de sesiones del nadador filtrado, ordenadas por fecha desc).
- Grid de 4 cards de métricas: Largos totales, Promedio/largo, Consistencia (%), Fatiga (segunda mitad).
- Card "Coach IA" con dos botones: "Resumen ejecutivo" y "Diagnóstico técnico" (por ahora hacen `console.log`).
- Card "Pregúntale al Coach" con chat (placeholder por ahora).

`static/js/analysis.js`:
- Lee sesiones y nadadores de localStorage.
- Importa `computeSessionMetrics` de `lib/metrics.js`.
- Cuando cambia el selector, recalcula y redibuja las 4 cards.
- Si no hay sesiones: muestra mensaje "Aún no hay sesiones registradas".

**Criterios de aceptación:**
- [ ] Sin sesiones: mensaje vacío.
- [ ] Con sesiones: selectores funcionan y las cards muestran los números correctos.
- [ ] Métrica de fatiga aparece en rojo si > 1500 ms (igual que el mockup).

**Commit sugerido:** `feat: análisis (selectores y métricas calculadas en cliente)`

---

## 10. Tarea 8 — Página Análisis IA (parte 2: integración con `/api/ai/analyze`)

**Objetivo:** Los botones de Coach IA y el chat hacen `fetch` al endpoint `/api/ai/analyze` y muestran la respuesta.

**Qué implementar:**

`static/js/lib/ai-coach.js`:
- Función `async analyze({ mode, swimmer, session, history, messages })` → hace `fetch('/api/ai/analyze')` con `POST` JSON.
- Devuelve `{ ok, analysis, error }`.
- Manejo de errores: timeout, red caída, etc.

**En `analysis.js`:**
- Conectar los botones "Resumen ejecutivo" y "Diagnóstico técnico" → llaman a `analyze({ mode: 'summary' | 'diagnosis', ... })` y muestran el `analysis` en un `<div>`.
- Chat: mantiene un array `chatHistory` en memoria. Al enviar, llama con `mode: 'chat'` y `messages: chatHistory`.
- Loading state: deshabilitar botones mientras se espera, mostrar spinner.

**En `app.py`:** verificar que el endpoint `/api/ai/analyze` ya intenta hacer `requests.post` al Flask IA con el header `X-Swimtrack-Auth`. Si falla, devuelve el mock que ya está.

**Criterios de aceptación:**
- [ ] Click en "Resumen ejecutivo" muestra el texto del mock (ya que IA aún no existe).
- [ ] Chat envía pregunta y muestra respuesta mock.
- [ ] Si se apaga Flask front: error visible al usuario.
- [ ] DevTools Network: el header `X-Swimtrack-Auth` se envía desde Flask front a Flask IA (cuando IA esté arriba).

**Commit sugerido:** `feat: integración con módulo IA vía /api/ai/analyze`

---

## 11. Tarea 9 — Página Demo

**Objetivo:** Demo end-to-end auto-contenida que muestra el flujo completo sin cámara ni nadadores.

**Referencia:** `src/pages/Demo.tsx`.

**Qué implementar:**

`templates/demo.html`:
- Header explicativo.
- Dos cards en grid:
  - Izquierda: imagen de piscina con badge "Largo N / 10", botón "Iniciar demo".
  - Derecha: grid de los 10 tiempos por largo, se van pintando uno a uno.
- Card de análisis IA (aparece después de terminar).

`static/js/demo.js`:
- Sesión hardcodeada de 10 largos (copiar tiempos de `src/pages/Demo.tsx`).
- Al click "Iniciar demo": setInterval cada 1.5s que aumenta el largo actual hasta 10.
- Al terminar: botón "Analizar con IA" que llama a `/api/ai/analyze` con modo `summary`.

**Criterios de aceptación:**
- [ ] La demo corre completa en ~15 segundos.
- [ ] Los tiempos se revelan progresivamente.
- [ ] El análisis se muestra al final.
- [ ] Funciona aunque no haya nadadores ni sesiones en localStorage.

**Commit sugerido:** `feat: página demo end-to-end auto-contenida`

---

## 12. Tarea 10 — Pulido final y README

**Objetivo:** Revisión de UX, accesibilidad básica, README completo.

**Qué hacer:**

- Revisar que **todas las URLs usan `url_for()`** y no hay strings hardcodeadas.
- Revisar que **ninguna ruta JS importa de forma absoluta** desde `/static/...`. Usar paths relativos al módulo (`./lib/storage.js`).
- Agregar `aria-label` a botones que solo tienen ícono.
- Agregar mensajes de toast (Bootstrap toast component) para acciones importantes: "Sesión guardada", "Nadador eliminado", etc.
- Probar responsive en mobile (DevTools).
- Completar `README.md` con:
  - Descripción del proyecto.
  - Cómo instalar y correr en local.
  - Cómo desplegar en el server (referencia a sección 14).
  - Endpoints API.
  - Estructura del proyecto.

**Commit sugerido:** `chore: pulido final, accesibilidad y README`

---

## 13. Cómo correrlo en local

```bash
# Una vez
git clone https://github.com/Benjjvv/swimtrack-front.git
cd swimtrack-front
python3 -m venv venv
source venv/bin/activate           # En Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env               # Editar .env si hace falta

# Cada vez
source venv/bin/activate
flask --app app run --port 7001 --debug
# Abrir http://localhost:7001
```

**Para probar el flujo completo con la IA**, hace falta tener corriendo también el Flask de IA (otro repo) en puerto 7011. Si no está, el mock se activa automáticamente y todo sigue funcionando.

---

## 14. Despliegue al server (al final de todo)

```bash
# En el server, vía SSH
cd $HOME/sources/
git clone https://github.com/Benjjvv/swimtrack-front.git
cd swimtrack-front
conda activate <ambiente>          # MiniForge ya está configurado
pip install -r requirements.txt
cp .env.example .env
# Editar .env:
#   FLASK_ENV=production
#   URL_PREFIX=/swimtrack/
#   IA_SECRET_HEADER=<valor real, mismo que tenga el Flask de IA>
```

**Apache `/etc/apache2/sites-enabled/000-default.conf`** (agregar):
```apache
ProxyPass        /swimtrack/  http://localhost:7001/
ProxyPassReverse /swimtrack/  http://localhost:7001/
```

**Correr Flask** (opciones):
- Quick & dirty: `nohup flask --app app run --host 0.0.0.0 --port 7001 &`
- Recomendado: `gunicorn` + servicio systemd. Ver slides 2.9 del curso.

URL final esperada: `https://grupoX.jb.dcc.uchile.cl/swimtrack/`

---

## Apéndice A — Paleta y tipografía

**Variables HSL del mockup (mantener exacto):**

```css
--st-bg:           hsl(220, 20%, 10%);
--st-bg-elev:      hsl(220, 18%, 13%);
--st-bg-elev-2:    hsl(220, 15%, 16%);
--st-bg-sidebar:   hsl(220, 20%, 8%);
--st-border:       hsl(220, 15%, 20%);
--st-text:         hsl(200, 20%, 90%);
--st-text-muted:   hsl(215, 15%, 55%);
--st-primary:      hsl(199, 89%, 48%);   /* cyan piscina */
--st-primary-fg:   hsl(220, 20%, 5%);
--st-accent:       hsl(172, 66%, 50%);
--st-success:      hsl(142, 71%, 45%);
--st-warning:      hsl(38, 92%, 50%);
--st-danger:       hsl(0, 72%, 51%);
```

**Tipografía:**
- Cuerpo: `Inter`, 400/500/600/700 desde Google Fonts.
- Monoespaciada (cronómetros, tiempos): `JetBrains Mono`, 400/500/600/700.

---

## Apéndice B — Tipos de datos (JSDoc)

Para que el JS vanilla no se desordene, comentar las funciones con JSDoc:

```js
/**
 * @typedef {Object} Swimmer
 * @property {string} id
 * @property {string} name
 * @property {number} age
 * @property {'principiante'|'intermedio'|'avanzado'} level
 * @property {string} createdAt - ISO string
 */

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

/**
 * @typedef {Object} Lane
 * @property {string} id
 * @property {string} name
 * @property {string[]} swimmerIds
 */

/**
 * @typedef {Object} Detection
 * @property {string} id
 * @property {[number,number,number,number]} bbox - [x, y, w, h]
 * @property {number} score
 * @property {string} class
 */
```

Las **keys de localStorage**:
- `swimcoach-swimmers` → `Swimmer[]`
- `swimcoach-sessions` → `Session[]`
- `swimcoach-lanes` → `Lane[]`

---

## Glosario rápido de archivos del mockup (para referencia)

Si Claude Code necesita ver cómo está hecho algo en el mockup original, los archivos clave son:

| Lógica | Archivo del mockup |
|---|---|
| Cronómetro + pirámide | `src/components/SwimmerControl.tsx` |
| Cámara | `src/hooks/useCamera.ts` |
| Detección COCO-SSD | `src/hooks/useDetection.ts` |
| Dibujo bounding boxes | `src/components/CameraFeed.tsx` |
| Métricas de sesión | `src/lib/metrics.ts` |
| Formato tiempo/fecha | `src/lib/format.ts` |
| Página Monitor | `src/pages/Index.tsx` |
| Página Análisis | `src/pages/Analysis.tsx` |
| Datos demo | `src/pages/Demo.tsx` |
| Tipos | `src/types/swim.ts` |
| Paleta + tema | `src/index.css` |

---

## Reglas de oro para Claude Code

1. **Una tarea = un commit.** No mezclar.
2. **Siempre `url_for()`**, nunca strings de URL.
3. **Imports relativos** en JS (`./lib/...`), no absolutos (`/static/...`).
4. **No agregar dependencias** que no estén en `requirements.txt` o que requieran un `package.json`. Todo JS viene de CDN o es vanilla.
5. **No usar TypeScript.** Solo JS con JSDoc para tipos.
6. **No "mejorar" features** que no están en la tarea actual. Si tenés ideas, anotalas pero no las implementes.
7. **Si algo no está claro, preguntar** antes de improvisar.
