"""SwimTrack — Frontend Flask.

5 rutas de páginas + un endpoint proxy hacia el módulo de IA + un endpoint de
detección de nadadores (POST /api/detect) que devuelve SSE.
Si la IA no responde, el endpoint de análisis devuelve un mock.
"""
import json
import os
import tempfile
import threading

import requests
from flask import Flask, Response, jsonify, render_template, request

from config import get_config

# --- Detección de nadadores (YOLO) -----------------------------------------
# El import del detector vive en UN SOLO lugar para que el swap sea trivial.
# TODO: cambiar a la clase real cuando esté lista (from detector import SwimmerDetector)
from detector_stub import SwimmerDetector

# Se instancia UNA sola vez y se reutiliza entre requests: cargar los pesos es
# caro en la clase real. Con el stub, weights=None.
_detector = SwimmerDetector(weights=None)

# Serializa el uso del detector dentro del proceso: la clase real usa YOLO con
# track(persist=True), cuyo estado de tracking vive en la instancia. Sin esto,
# dos requests concurrentes cruzarían los IDs y sobrecargarían la GPU. (F8)
_detector_lock = threading.Lock()

# Extensiones de video que aceptamos si el navegador no manda un mimetype video/*.
_VIDEO_EXTS = {".mp4", ".webm", ".mov", ".avi", ".mkv", ".m4v", ".ogv", ".ogg"}


def _looks_like_video(file):
    """Heurística barata para rechazar archivos que claramente no son video."""
    mimetype = (getattr(file, "mimetype", "") or "").lower()
    ext = os.path.splitext(file.filename)[1].lower()
    return mimetype.startswith("video/") or ext in _VIDEO_EXTS


class PrefixMiddleware:
    """Monta la app bajo URL_PREFIX (ej. /swimtrack) cuando se sirve detrás de Apache.

    Apache hace ProxyPass /swimtrack/ -> localhost:PORT/swimtrack/ (preserva el path),
    así que movemos el prefijo de PATH_INFO a SCRIPT_NAME: el ruteo matchea las rutas
    en "/" y url_for() genera automáticamente las URLs con el prefijo (links + /static).
    En local (URL_PREFIX="/") el middleware ni se instala.
    """

    def __init__(self, wsgi_app, prefix=""):
        self.wsgi_app = wsgi_app
        self.prefix = "/" + prefix.strip("/")

    def __call__(self, environ, start_response):
        path = environ.get("PATH_INFO", "")
        if path == self.prefix or path.startswith(self.prefix + "/"):
            environ["PATH_INFO"] = path[len(self.prefix):] or "/"
            environ["SCRIPT_NAME"] = self.prefix
        return self.wsgi_app(environ, start_response)


def _mock_analysis(payload):
    """Texto de análisis simulado cuando la IA real no está disponible."""
    mode = payload.get("mode", "summary")
    metrics = payload.get("metrics") or {}
    name = payload.get("swimmerName") or "el nadador"

    if mode == "chat":
        messages = payload.get("messages") or []
        last = messages[-1].get("content", "") if messages else ""
        return (
            f"(Coach IA simulado) Sobre «{last}»: cuando el módulo de IA real "
            "esté conectado vas a recibir una respuesta basada en los tiempos de "
            "la sesión. Por ahora esto es un mock del frontend."
        )

    laps = metrics.get("totalLaps", "?")
    consistency = metrics.get("consistencyScore")
    fatigue = metrics.get("fatigueDelta")
    cons_txt = f"{consistency:.0f}%" if isinstance(consistency, (int, float)) else "s/d"
    fat_txt = (
        "muestra fatiga en la segunda mitad"
        if isinstance(fatigue, (int, float)) and fatigue > 1500
        else "mantiene un ritmo parejo"
    )
    encabezado = "Resumen ejecutivo" if mode == "summary" else "Diagnóstico técnico"
    return (
        f"({encabezado} simulado — la IA real aún no está conectada.)\n\n"
        f"{name} completó {laps} largos con una consistencia del {cons_txt} y "
        f"{fat_txt}. Recomendación de ejemplo: trabajar técnica de viraje y "
        "controlar el ritmo en los últimos largos."
    )


def _sse_detect(video_path):
    """Generador SSE: un evento por frame siguiendo el contrato de datos.

    `count` = nº de IDs únicos acumulados hasta ese frame; lo calcula el BACK
    (no el detector), acumulando los ids que va viendo. El video temporal se
    borra al terminar el stream o si algo falla (finally).
    """
    seen_ids = set()
    try:
        # Un detector por proceso: serializamos su uso (tracker + GPU). (F8)
        with _detector_lock:
            for frame in _detector.stream(video_path):
                for box in frame.get("boxes", []):
                    seen_ids.add(box.get("id"))
                frame["count"] = len(seen_ids)
                yield f"data: {json.dumps(frame)}\n\n"
    except Exception as exc:  # noqa: BLE001
        # La IA real puede fallar a mitad (video corrupto, etc.). El 200 y los
        # headers SSE ya salieron, así que no se puede devolver un 4xx/5xx: en su
        # lugar mandamos un evento SSE de error para que el front lo muestre en
        # vez de cortar el stream en silencio. (F2)
        yield f"event: error\ndata: {json.dumps({'error': str(exc)})}\n\n"
    finally:
        # "El video se procesa y se DESCARTA": no queda nada en disco.
        try:
            os.remove(video_path)
        except OSError:
            pass


def create_app():
    app = Flask(__name__)
    app.config.from_object(get_config())

    # En producción (URL_PREFIX != "/") montamos la app bajo el subpath de Apache.
    prefix = app.config.get("URL_PREFIX", "/")
    if prefix and prefix.strip("/"):
        app.wsgi_app = PrefixMiddleware(app.wsgi_app, prefix)

    @app.route("/")
    def monitor():
        return render_template("monitor.html", active="monitor")

    @app.route("/swimmers")
    def swimmers():
        return render_template("swimmers.html", active="swimmers")

    @app.route("/history")
    def history():
        return render_template("history.html", active="history")

    @app.route("/analysis")
    def analysis():
        return render_template("analysis.html", active="analysis")

    @app.route("/demo")
    def demo():
        return render_template("demo.html", active="demo")

    @app.route("/api/detect", methods=["POST"])
    def detect():
        """Recibe un video subido, lo procesa con SwimmerDetector y responde SSE.

        Un evento por frame con el contrato de datos, con `count` = IDs únicos
        acumulados. El front hace POST con fetch() y lee el stream a mano
        (EventSource no sirve: es solo GET). El video se guarda en un temporal
        solo para pasarle una ruta al detector y se borra al cerrar el stream.
        """
        file = request.files.get("video")
        if file is None or not file.filename:
            return jsonify({"ok": False, "error": "Falta el archivo 'video'."}), 400
        if not _looks_like_video(file):
            # Rechazamos acá (antes de abrir el SSE): una vez que empieza el
            # stream ya no se puede devolver un código de error HTTP. (F2)
            return jsonify({"ok": False, "error": "El archivo no parece ser un video."}), 400

        # La clase real de YOLO necesita una RUTA en disco: guardamos el upload
        # en un temporal. Se elimina en _sse_detect (finally) al terminar.
        suffix = os.path.splitext(file.filename)[1] or ".mp4"
        fd, tmp_path = tempfile.mkstemp(suffix=suffix)
        os.close(fd)
        file.save(tmp_path)

        return Response(
            _sse_detect(tmp_path),
            mimetype="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",  # que el proxy (Apache) no buffere el stream
            },
        )

    @app.route("/api/ai/analyze", methods=["POST"])
    def ai_analyze():
        """Proxy hacia el Flask de IA. Si falla, devuelve un mock."""
        payload = request.get_json(silent=True) or {}
        base = (app.config.get("IA_BASE_URL") or "").rstrip("/")
        secret = app.config.get("IA_SECRET_HEADER", "")
        try:
            resp = requests.post(
                f"{base}/analyze",
                json=payload,
                headers={"X-Swimtrack-Auth": secret},
                timeout=8,
            )
            resp.raise_for_status()
            data = resp.json()
            return jsonify({
                "ok": True,
                "mock": False,
                "analysis": data.get("analysis", data.get("text", "")),
            })
        except (requests.RequestException, ValueError):
            # IA caída, timeout o respuesta no-JSON: mock para no bloquear el front.
            return jsonify({
                "ok": True,
                "mock": True,
                "analysis": _mock_analysis(payload),
            })

    return app


app = create_app()


if __name__ == "__main__":
    # Solo para dev (`python app.py`). En producción se usa gunicorn -c
    # gunicorn.conf.py app:app. threaded=True para que el stream SSE de
    # /api/detect no bloquee las demás rutas del dev server. `flask run` ya
    # corre con hilos por defecto.
    port = int(os.getenv("FLASK_RUN_PORT", "7001"))
    app.run(host="0.0.0.0", port=port, debug=app.config.get("DEBUG", False), threaded=True)
