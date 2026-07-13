"""Gunicorn — configuración de producción de SwimTrack.

Se ejecuta:  gunicorn -c gunicorn.conf.py app:app

Problema que resuelve
---------------------
POST /api/detect devuelve un stream SSE que dura lo que tarda el detector en
procesar el video (con la clase real de YOLO, potencialmente muchos segundos).
Mientras ese stream vive, mantiene ocupado el worker/hilo que lo atiende. Con el
worker `sync` (default de gunicorn) UNA request larga bloquea al worker entero:
las páginas y /api/ai/analyze dejan de responder. Acá usamos hilos para que eso
no pase.

Sobre el subpath / PrefixMiddleware
-----------------------------------
El prefijo /swimtrack/ lo maneja `PrefixMiddleware` DENTRO de la app, a nivel
WSGI (envuelve app.wsgi_app). Gunicorn sirve el objeto Flask `app`, así que la
request pasa por ese middleware igual que con el dev server: gunicorn NO necesita
ninguna opción de subpath. Importante: NO setear SCRIPT_NAME en gunicorn ni
agregar otra capa de prefijo — la app ya es dueña del prefijo y hacerlo dos veces
rompería url_for(). El middleware devuelve el iterable del stream tal cual (no
bufferiza), por lo que el SSE atraviesa el subpath sin cambios.
"""

import os

# --- Dónde escucha ---------------------------------------------------------
# Solo localhost: Apache hace de ProxyPass hacia acá. Mismo puerto que la
# convención del curso (7001).
bind = os.getenv("GUNICORN_BIND", "127.0.0.1:" + os.getenv("FLASK_RUN_PORT", "7001"))

# --- Modelo de concurrencia: HILOS, no procesos ----------------------------
# gthread: cada worker atiende varias requests con un pool de hilos. Un stream
# largo de /api/detect ocupa UN hilo; los otros hilos siguen libres para servir
# páginas y /api/ai/analyze. (Con "threads > 1" gunicorn ya usa gthread, pero lo
# dejamos explícito.)
worker_class = "gthread"

# Pocos PROCESOS. El modelo vive en swimtrack-ai, no en estos workers; cada
# upload crea una sesión remota aislada. Dos workers dan tolerancia a fallos y
# capacidad de decodificación sin multiplicar memoria CUDA en esta aplicación.
workers = int(os.getenv("GUNICORN_WORKERS", "2"))

# HILOS por worker: acá está la concurrencia real. Un hilo puede quedar atado a
# un stream largo mientras el resto atiende requests cortas. OpenCV y el cliente
# HTTP liberan el GIL durante decode/encode e I/O. 2 workers x 4 hilos permiten
# hasta 8 requests simultáneas; swimtrack-ai serializa el acceso a una sesión.
threads = int(os.getenv("GUNICORN_THREADS", "4"))

# No precargar mantiene el comportamiento histórico y aísla la configuración y
# pools HTTP de cada worker. El front ya no crea contextos CUDA locales.
preload_app = False

# --- Timeouts pensados para streaming --------------------------------------
# Con worker sync, `timeout` mata al worker si una request dura más de N s (fatal
# para un stream largo). Con gthread el timeout chequea la vida del loop del
# worker, no la duración de la request, así que un stream largo no lo dispara;
# igual lo subimos para dar aire a videos largos.
timeout = int(os.getenv("GUNICORN_TIMEOUT", "120"))
graceful_timeout = 30
keepalive = 5

# Heartbeat del worker en memoria: evita cuelgues raros si /tmp está en disco
# lento. Si /dev/shm no existe, gunicorn usa su default.
worker_tmp_dir = "/dev/shm" if os.path.isdir("/dev/shm") else None

# Logs a stdout/stderr (para journald o los logs de Apache).
accesslog = "-"
errorlog = "-"
