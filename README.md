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
| `VISION_BASE_URL` | URL privada de `swimtrack-ai` (ej. `http://gpu-host:8001`). |
| `VISION_AUTH_TOKEN` | Token compartido con `swimtrack-ai`. |
| `VISION_BATCH_SIZE` | Cantidad de frames JPEG enviados por request; default `8`. |
| `VISION_INFERENCE_SIZE` | Resolución cuadrada enviada al modelo; default `640`. |
| `VISION_JPEG_QUALITY` | Calidad de compresión de los frames; default `85`. |
| `VISION_*_TIMEOUT` | Timeouts de conexión, lectura, escritura y pool. |
| `VISION_CLEANUP_TIMEOUT` | Timeout corto para cerrar una sesión remota. |
| `VISION_MAX_RETRIES` | Reintentos idempotentes adicionales por batch. |
| `MAX_CONTENT_LENGTH` | Tamaño máximo del upload de video completo; default 1 GiB. |
| `FLASK_SECRET_KEY` | Clave de sesión de Flask. |

`.env` no se sube al repo; `.env.example` sí.

`VISION_AUTH_TOKEN` debe tener exactamente el mismo valor que `SWIMTRACK_AUTH_TOKEN` en `swimtrack-ai`.

## Tests

```bash
uv run --with-requirements requirements.txt --with pytest pytest -q
uv run --with ruff ruff check .
```

## API

### `POST /api/detect`

Recibe `multipart/form-data` con el campo `video`, crea una sesión de tracking remota y responde `text/event-stream`. Cada evento contiene `{time,width,height,boxes,count}`. El archivo temporal y la sesión remota se limpian al terminar, fallar o cortar el stream. Consulta [INTEGRACION_IA.md](INTEGRACION_IA.md) para el contrato completo.

### `POST /api/ai/analyze`

Proxy hacia el Flask de IA. El front manda JSON (`{ mode, swimmerName, metrics, messages }`) y Flask lo reenvía a `IA_BASE_URL/analyze` con el header `X-Swimtrack-Auth`. Si la IA no responde (timeout, caída o respuesta no-JSON), devuelve un **mock** para no bloquear el front.

Respuesta: `{ "ok": true, "mock": <bool>, "analysis": "<texto>" }`.

## Estructura

```
app.py                 Flask + páginas + endpoints /api/detect y /api/ai/analyze
config.py              Config dev/prod desde .env
remote_detector.py     Decode, batching HTTP, retries y cleanup de sesiones IA
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
ProxyPass        /swimtrack/  http://localhost:7001/
ProxyPassReverse /swimtrack/  http://localhost:7001/
```

Detalle completo en [PLAN.md](PLAN.md), sección 14.
