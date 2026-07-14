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
6. Flask convierte `time_ms` a segundos, agrega el conteo acumulado de IDs y emite el evento SSE `{time,width,height,boxes,count,lap_scores?,tracking_diagnostics?,lap_decisions?}`. Un reducer local al request agrupa los candidatos por `(lane_id, candidate_episode_id)`, conserva el score máximo y, cuando hay un threshold configurado, publica a lo sumo una decisión shadow por episodio sin modificar `count`.
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
| `VISION_BASE_URL` | `http://localhost:8001` | URL privada del servicio GPU; en este despliegue usa `http://10.0.218.101:7001`. |
| `VISION_AUTH_TOKEN` | vacío | Token enviado en `X-Swimtrack-Auth`. |
| `VISION_LAP_CALIBRATION_ID` | `fixed-camera-v1` | Calibración de perspectiva y carril solicitada al crear la sesión; vacío deshabilita el score. |
| `VISION_TRACKING_DIAGNOSTICS` | `none` | Diagnostics de tracking por frame: `none`, `counts` o `boxes`; los dos últimos son opt-in para experimentos. |
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
| `LAP_EPISODE_MODE` | `shadow` | `shadow` reduce y registra episodios; `off` lo deshabilita. No se acepta `active` porque el conteo visible todavía no está habilitado. |
| `LAP_CONFIDENCE_THRESHOLD` | sin valor | Threshold `[0,1]` para emitir decisiones shadow. Se deja sin default para no convertir `0.05` en una decisión de producto; puede configurarse explícitamente durante una evaluación. |

`IA_BASE_URL` e `IA_SECRET_HEADER` siguen perteneciendo al coach textual de `/api/ai/analyze`; no se reutilizan para visión.

## Reducer de episodios en shadow mode

Cada request de video construye una instancia nueva del reducer, por lo que sesiones concurrentes y videos consecutivos no comparten estado. La key de episodio dentro de esa sesión es `(lane_id, candidate_episode_id)`. Las observaciones repetidas actualizan el máximo interno junto con su `candidate_time_ms`, pero el cruce del threshold genera como máximo un `lap_decisions`:

```json
{"lane_id":"center","candidate_episode_id":3,"candidate_time_ms":45200.0,"lap_score":0.072141,"score_version":"trajectory-v5","endpoint":"far","predicted_label":"lap","threshold":0.05,"mode":"shadow","would_increment_lap_count":true,"lap_count_incremented":false}
```

La decisión contiene el máximo disponible al momento del primer cruce. El reducer sigue conservando el máximo final y lo registra en un log sanitizado al cerrar el stream. No incluye token, frames ni bboxes. Como el protocolo actual no publica explícitamente el cierre de un episodio, emitir sólo al final introduciría una latencia indefinida; por eso se notifica el primer cruce y se evita cualquier duplicado posterior. Sin `LAP_CONFIDENCE_THRESHOLD`, shadow mode registra los episodios y sus máximos pero no emite una clasificación positiva.

El valor de `VISION_AUTH_TOKEN` en este repo debe coincidir con `SWIMTRACK_AUTH_TOKEN` en `swimtrack-ai`.

En producción, conecta ambas máquinas mediante una red privada o una VPN y restringe el puerto de AI por origen. Esta VM temporal utiliza el rango ya abierto y sólo el token para proteger las rutas privadas; no expongas el servicio por TCP fuera de esta red temporal, porque el token no debe viajar por Internet usando HTTP plano. Configura también `MAX_CONTENT_LENGTH` y límites equivalentes en Apache/Nginx para rechazar videos excesivos antes de escribirlos a disco.

## Conexión directa privada

Ejecuta `swimtrack-ai` como proceso nativo con `uv` en la máquina GPU y haz que Uvicorn escuche solamente en su IP privada (`10.0.218.101:7001`). La VM temporal ya tiene el rango `7000-7099` abierto y el rol Ansible no modifica UFW. Conserva el bind específico de la IP privada, exige `SWIMTRACK_AUTH_TOKEN` y no reutilices esta exposición sin una ACL por origen en un entorno persistente.

El recorrido queda así:

```text
Flask en 10.0.218.111 → http://10.0.218.101:7001 → Uvicorn en GPU
```

Configura el Front con la URL privada y exactamente el mismo token usado como `SWIMTRACK_AUTH_TOKEN` en la máquina GPU:

```dotenv
VISION_BASE_URL=http://10.0.218.101:7001
VISION_AUTH_TOKEN=<mismo-token-de-swimtrack-ai>
```

El despliegue no requiere privilegios de administrador. El servicio AI sigue ejecutándose como usuario y el token se transfiere por HTTP únicamente dentro de la red privada temporal. Si el Front y `swimtrack-ai` se ejecutan excepcionalmente en la misma máquina, puedes usar `VISION_BASE_URL=http://127.0.0.1:8001`.

## Smoke test end-to-end

Con `swimtrack-ai` ejecutándose en la máquina GPU, valida desde la máquina del Front que el servicio privado responda:

```bash
curl --fail --show-error http://10.0.218.101:7001/healthz
curl --fail --show-error http://10.0.218.101:7001/readyz
```

Inicia el front desde `swimtrack-front/`:

```bash
uv run --with-requirements requirements.txt flask --app app run --port 7001 --debug
```

En otra terminal envía un video corto al BFF y conserva abierta la respuesta SSE:

```bash
curl --no-buffer --fail-with-body \
  -F "video=@../input_vids/<video>.mp4;type=video/mp4" \
  http://127.0.0.1:7001/api/detect
```

La prueba es exitosa si `/readyz` indica que el backend está listo, `/api/detect` emite un evento por frame sin `event: error`, las bboxes respetan las dimensiones originales y los IDs se mantienen entre frames consecutivos. También puedes subir el mismo video desde la UI. Un error remoto aparecerá como evento SSE y el panel lo mostrará aunque el status HTTP del stream ya haya comenzado.
