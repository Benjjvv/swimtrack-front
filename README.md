# SwimTrack — Frontend

Frontend Flask de **SwimTrack**, un sistema de visión por computadora para entrenamiento de natación: una cámara fija detecta nadadores y el entrenador cuenta largos y mide tiempos sin tener que hacerlo a mano.

Este repo es **solo el frontend**. El módulo de IA real (análisis textual / coach) vive en otro repo; acá dejamos un punto de integración limpio (`/api/ai/analyze`) que cae a un mock si la IA no está disponible.

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
# Una sola vez
python3 -m venv venv
source venv/bin/activate            # En Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                # Editar .env si hace falta

# Cada vez
source venv/bin/activate
flask --app app run --port 7001 --debug
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
| `FLASK_SECRET_KEY` | Clave de sesión de Flask. |

`.env` no se sube al repo; `.env.example` sí.

## API

### `POST /api/ai/analyze`

Proxy hacia el Flask de IA. El front manda JSON (`{ mode, swimmerName, metrics, messages }`) y Flask lo reenvía a `IA_BASE_URL/analyze` con el header `X-Swimtrack-Auth`. Si la IA no responde (timeout, caída o respuesta no-JSON), devuelve un **mock** para no bloquear el front.

Respuesta: `{ "ok": true, "mock": <bool>, "analysis": "<texto>" }`.

## Estructura

```
app.py                 Flask + 5 rutas + proxy /api/ai/analyze
config.py              Config dev/prod desde .env
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
