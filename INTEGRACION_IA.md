# Integración con el servicio remoto de visión

El navegador conserva el contrato existente: sube un video con `POST /api/detect` y consume una respuesta SSE con un evento por frame. Flask funciona como BFF: guarda el upload temporalmente, decodifica el video, envía batches de JPEG al servicio privado con GPU y retransmite las detecciones al navegador. El JavaScript no conoce la URL ni el token del servicio IA.

```text
Browser → POST /api/detect → Flask → POST batches → swimtrack-ai (GPU)
Browser ← SSE por frame      ← Flask ← JSON por batch ← RT-DETRv2 + ByteTrack
```

## Ciclo de una detección

1. Flask valida y guarda el video en un archivo temporal.
2. `RemoteSwimmerDetector` abre el video con OpenCV y crea una sesión remota con `POST /v1/tracking-sessions`.
3. Cada frame conserva `frame_index`, timestamp y dimensiones originales, pero se redimensiona a 640×640 y se comprime como JPEG para el transporte.
4. Los frames se agrupan según `VISION_BATCH_SIZE` y se envían secuencialmente a `POST /v1/tracking-sessions/{session_id}/batches`.
5. RT-DETRv2 procesa internamente los frames de a uno en esta primera versión y ByteTrack actualiza la misma sesión en orden.
6. Flask convierte `time_ms` a segundos, agrega el conteo acumulado de IDs y emite el evento SSE `{time,width,height,boxes,count}`.
7. Al terminar, fallar o desconectarse el navegador, Flask cierra la sesión remota y elimina el archivo temporal. El TTL del servicio IA cubre una caída total de red durante el cleanup.

## Contrato del servicio IA

Todas las rutas privadas usan `X-Swimtrack-Auth: <VISION_AUTH_TOKEN>`.

### Crear sesión

```http
POST /v1/tracking-sessions
Content-Type: application/json

{"fps":60.0}
```

Respuesta `201`:

```json
{"session_id":"7bca...","next_sequence":0,"expires_in_seconds":900}
```

### Procesar batch

El request es `multipart/form-data`, con un campo repetido `frames` por cada JPEG y un campo de texto `metadata`:

```json
{"batch_id":"2c53...","sequence":0,"frames":[{"frame_index":0,"time_ms":0.0,"original_width":1080,"original_height":1080}]}
```

Respuesta `200`:

```json
{"session_id":"7bca...","batch_id":"2c53...","sequence":0,"next_sequence":1,"frames":[{"frame_index":0,"time_ms":0.0,"width":1080,"height":1080,"boxes":[{"id":1,"x1":100.0,"y1":50.0,"x2":180.0,"y2":250.0,"conf":0.91,"class_id":0}]}]}
```

`width`, `height` y las bboxes siempre corresponden a las dimensiones originales, aunque el JPEG enviado mida 640×640.

### Cerrar sesión

```http
DELETE /v1/tracking-sessions/{session_id}
```

Respuesta `204`.

## Orden e idempotencia

Los batches de una sesión nunca se envían en paralelo porque ByteTrack depende del orden temporal. Ante un timeout o error transitorio, Flask reintenta con el mismo `batch_id`, `sequence`, metadata y bytes. El servicio IA debe devolver el resultado cacheado sin volver a avanzar el tracker. Un `batch_id` reutilizado con otro contenido o una secuencia fuera de orden produce `409` y no se reintenta.

Se reintentan errores de transporte y HTTP `408`, `425`, `429`, `500`, `502`, `503` y `504`. Los demás errores se entregan al navegador como evento SSE `error`.

## Configuración

| Variable | Default | Uso |
|---|---:|---|
| `VISION_BASE_URL` | `http://localhost:8001` | URL privada del servicio GPU. |
| `VISION_AUTH_TOKEN` | vacío | Token enviado en `X-Swimtrack-Auth`. |
| `VISION_BATCH_SIZE` | `8` | Frames por request HTTP. |
| `VISION_INFERENCE_SIZE` | `640` | Ancho y alto del JPEG enviado. |
| `VISION_JPEG_QUALITY` | `85` | Calidad JPEG de OpenCV. |
| `VISION_CONNECT_TIMEOUT` | `5` | Timeout de conexión en segundos. |
| `VISION_READ_TIMEOUT` | `120` | Timeout esperando el resultado de un batch. |
| `VISION_WRITE_TIMEOUT` | `30` | Timeout enviando multipart. |
| `VISION_POOL_TIMEOUT` | `5` | Timeout esperando una conexión del pool. |
| `VISION_CLEANUP_TIMEOUT` | `5` | Timeout por intento al cerrar una sesión; el TTL cubre fallos. |
| `VISION_MAX_RETRIES` | `2` | Reintentos adicionales por batch y cleanup. |
| `VISION_RETRY_BACKOFF_SECONDS` | `0.5` | Base del backoff exponencial. |
| `VISION_FALLBACK_FPS` | `30` | FPS usado si OpenCV no puede leerlo. |

`IA_BASE_URL` e `IA_SECRET_HEADER` siguen perteneciendo al coach textual de `/api/ai/analyze`; no se reutilizan para visión.

El valor de `VISION_AUTH_TOKEN` en este repo debe coincidir con `SWIMTRACK_AUTH_TOKEN` en `swimtrack-ai`.

En producción, conecta ambas máquinas mediante una red privada o VPN y termina TLS en un reverse proxy; el token no debe viajar por Internet usando HTTP plano. Configura también `MAX_CONTENT_LENGTH` y límites equivalentes en Apache/Nginx para rechazar videos excesivos antes de escribirlos a disco.

## Desarrollo local

El servicio IA debe estar disponible en `VISION_BASE_URL`; el endpoint de detección ya no cae a bboxes falsas. Para probar ambos procesos desde sus respectivos directorios:

```bash
docker compose up --build
```

```bash
uv run --with-requirements requirements.txt flask --app app run --port 7001 --debug
```

Sube un video desde la UI. Un error remoto aparecerá como evento SSE de error y el panel lo mostrará sin cambiar el status HTTP que ya inició el stream.
