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

# Pocos PROCESOS. Cada worker importa app.py por separado y crea su propio
# `_detector`; con la clase real eso carga los pesos de YOLO en GPU/RAM UNA vez
# por proceso, y una sola GPU no quiere N inferencias en paralelo. 2 workers dan
# tolerancia a fallos (si uno muere a mitad de un stream, el otro sigue) sin
# duplicar de más el modelo. Con una GPU chica podés bajar a 1 y subir threads.
workers = int(os.getenv("GUNICORN_WORKERS", "2"))

# HILOS por worker: acá está la concurrencia real. Un hilo puede quedar atado a
# un stream largo mientras el resto atiende requests cortas. YOLO (torch) libera
# el GIL durante la inferencia en C/CUDA, así que los hilos avanzan de verdad
# aun con la clase real. 2 workers x 4 hilos = hasta 8 requests simultáneas.
threads = int(os.getenv("GUNICORN_THREADS", "4"))

# NO precargar la app. Con preload_app=True gunicorn importaría app.py (creando
# `_detector`, o sea el modelo) en el master y forkearía los workers; el contexto
# CUDA no sobrevive al fork ("Cannot re-initialize CUDA in forked subprocess").
# Con preload_app=False cada worker inicializa CUDA después del fork. Correcto.
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
