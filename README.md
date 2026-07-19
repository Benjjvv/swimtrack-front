# SwimTrack — Frontend

Frontend Flask de **SwimTrack**, un sistema de visión por computadora para entrenamiento de natación: una cámara fija detecta nadadores y el entrenador cuenta largos y mide tiempos sin tener que hacerlo a mano.

Este repo contiene el frontend y su BFF Flask. El análisis textual se integra mediante `/api/ai/analyze`; la detección RT-DETRv2 + ByteTrack se ejecuta en `swimtrack-ai` y se integra mediante `/api/detect` sin exponer la máquina GPU al navegador.

Ver [PLAN.md](PLAN.md) para la especificación completa por tareas.

## Stack

- **Flask 3** sirviendo HTML con **Jinja2**.
- **Bootstrap 5.3** + Bootstrap Icons (CDN) + un `theme.css` propio (tema oscuro).
- **JavaScript vanilla** con módulos ES6 (sin build step, sin TypeScript).
- **TensorFlow.js + COCO-SSD** (CDN, bajo demanda) para detección de personas en el navegador.
- Persistencia en **`localStorage`** del cliente (nadadores, sesiones, pistas).

## Páginas

| Ruta | Página | Qué hace |
|---|---|---|
| `/` | Monitor | Cámara + detección (COCO-SSD), pistas, cronómetro y conteo manual de largos. |
| `/swimmers` | Nadadores | ABM de nadadores (localStorage). |
| `/history` | Historial | Sesiones pasadas, filtro por nadador, tiempos por largo. |
| `/analysis` | Análisis IA | Métricas calculadas en cliente + resumen/diagnóstico/chat vía IA. |
| `/demo` | Demo | Sesión simulada de 10 largos end-to-end + análisis IA. |

## Cómo correrlo en local

```bash
cp .env.example .env
uv run --with-requirements requirements.txt flask --app app run --port 7001 --debug
```

Abrir <http://localhost:7001>.

> **Nota sobre la cámara:** `getUserMedia` solo funciona en contexto seguro — `localhost` (dev) o **HTTPS** (producción). El "Modo Demo" del Monitor no necesita cámara ni internet.

## Variables de entorno (`.env`)

| Variable | Para qué |
|---|---|
| `FLASK_ENV` | `development` o `production`. |
| `FLASK_RUN_PORT` | Puerto del Flask front (convención del curso: `7001`). |
| `URL_PREFIX` | `/` en local, `/swimtrack/` bajo el server con Apache. |
| `IA_BASE_URL` | URL del Flask de IA (ej. `http://localhost:7011`). |
| `IA_SECRET_HEADER` | Secreto compartido; se manda como header `X-Swimtrack-Auth`. |
| `VISION_BASE_URL` | URL privada de `swimtrack-ai`; en este despliegue usa `http://10.0.218.101:7001`. |
| `VISION_AUTH_TOKEN` | Token compartido con `swimtrack-ai`. |
| `VISION_LAP_CALIBRATION_ID` | Calibración fija solicitada al crear la sesión; default `fixed-camera-v1`. |
| `VISION_TRACKING_DIAGNOSTICS` | Instrumentación opt-in por frame: `none` (default), `counts` o `boxes`. |
| `VISION_TRANSPORT` | `frames` (default) conserva el envío JPEG idempotente; `video` retransmite el archivo original una vez a `/v1/tracking-sessions/{session_id}/video` y recibe NDJSON. Actívalo sólo junto con la versión compatible de `swimtrack-ai`. |
| `VISION_BATCH_SIZE` | Cantidad de frames JPEG enviados por request; default `4`. |
| `VISION_PREPARED_BATCH_QUEUE_SIZE` | Batches JPEG preparados localmente mientras el request anterior espera la GPU; default `2`, siempre con un único request ordenado en vuelo. |
| `VISION_MAX_FPS` | Máximo de FPS que se analizan desde un video subido; default `30`, con timestamps originales. |
| `VISION_INFERENCE_SIZE` | Resolución cuadrada enviada al modelo; default `640`. |
| `VISION_JPEG_QUALITY` | Calidad de compresión de los frames; default `85`. |
| `VISION_*_TIMEOUT` | Timeouts de conexión, lectura, escritura y pool. |
| `VISION_CLEANUP_TIMEOUT` | Timeout corto para cerrar una sesión remota. |
| `VISION_MAX_RETRIES` | Reintentos idempotentes adicionales por batch. |
| `MAX_CONTENT_LENGTH` | Tamaño máximo del upload de video completo; default 1 GiB. |
| `FLASK_SECRET_KEY` | Clave de sesión de Flask. |
| `LAP_EPISODE_MODE` | Reducer de episodios: `shadow` (default) u `off`; no existe un modo que cambie el contador visible. |
| `LAP_CONFIDENCE_THRESHOLD` | Threshold `[0,1]` para decisiones shadow; default `0.2`. El menú Debug puede sobrescribirlo por upload en el navegador. |

`.env` no se sube al repo; `.env.example` sí.

`VISION_AUTH_TOKEN` debe tener exactamente el mismo valor que `SWIMTRACK_AUTH_TOKEN` en `swimtrack-ai`.

El Front registra telemetría estructurada sin nombres de archivo, paths, tokens ni contenido: `vision_upload_timing`, `vision_prepare_batch_timing`, `vision_prepare_timing`, `vision_batch_timing`, `vision_video_metadata`, `vision_video_upload_timing` y `vision_sse_timing`. Estas métricas separan guardado del upload, decode/muestreo/resize/JPEG, espera de la cola, request hacia la GPU y emisión SSE.

En la VM temporal del proyecto, `swimtrack-ai` se ejecuta nativamente con `uv` en `10.0.218.101:7001`, dentro del rango ya abierto. El token protege las rutas privadas, pero UFW no restringe el acceso por origen; no reutilices esta configuración fuera de esta red privada temporal. Consulta [INTEGRACION_IA.md](INTEGRACION_IA.md#conexión-directa-privada) para la configuración y el smoke test.

## Tests

```bash
uv run --with-requirements requirements.txt --with pytest python -m pytest -q
uv run --with ruff ruff check .
node tests/detection-playback.test.mjs
```

## API

### `POST /api/detect`

Recibe `multipart/form-data` con el campo `video`, crea una sesión de tracking remota y responde `text/event-stream`. Cada evento contiene `{time,width,height,boxes,count,lap_scores?,tracking_diagnostics?,lap_decisions?}`. `lap_scores` conserva el score heurístico y la evidencia por carril cuando la calibración está habilitada; `tracking_diagnostics` aparece sólo si se habilita explícitamente. En modo shadow, `lap_decisions` aparece una sola vez cuando un episodio cruza el threshold configurado y declara explícitamente que el contador no fue incrementado. `count` mantiene su semántica histórica de IDs acumulados. El archivo temporal y la sesión remota se limpian al terminar, fallar o cortar el stream. Consulta [INTEGRACION_IA.md](INTEGRACION_IA.md) para el contrato completo.

### `POST /api/ai/analyze`

Proxy hacia el Flask de IA. El front manda JSON (`{ mode, swimmerName, metrics, messages }`) y Flask lo reenvía a `IA_BASE_URL/analyze` con el header `X-Swimtrack-Auth`. Si la IA no responde (timeout, caída o respuesta no-JSON), devuelve un **mock** para no bloquear el front.

Respuesta: `{ "ok": true, "mock": <bool>, "analysis": "<texto>" }`.

## Estructura

```
app.py                 Flask + páginas + endpoints /api/detect y /api/ai/analyze
config.py              Config dev/prod desde .env
remote_detector.py     Transporte JPEG o video original, retries y cleanup de sesiones IA
templates/             base.html + 1 plantilla por página
static/css/theme.css   Tema oscuro sobre Bootstrap
static/js/
  <pagina>.js          Lógica de cada página (swimmers, history, monitor, analysis, demo)
  lib/                  Módulos compartidos:
    storage / format / metrics / stopwatch
    camera / detection / camera-panel   (Monitor)
    ai-coach                            (cliente del endpoint de IA)
    toast                               (notificaciones)
```

Regla del proyecto: ningún `.js` supera ~300 líneas; las URLs en HTML usan siempre `url_for()` (necesario para el subpath del server).

## Despliegue (resumen)

En el server, detrás de Apache con `URL_PREFIX=/swimtrack/`:

```apache
ProxyPass        /swimtrack/  http://127.0.0.1:7101/swimtrack/
ProxyPassReverse /swimtrack/  http://127.0.0.1:7101/swimtrack/
```

Detalle completo en [PLAN.md](PLAN.md), sección 14.
