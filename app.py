"""SwimTrack — Frontend Flask.

5 rutas de páginas + un endpoint proxy hacia el módulo de IA + un endpoint de
detección de nadadores (POST /api/detect) que devuelve SSE. La visión se ejecuta
en un servicio remoto con GPU; este proceso solo decodifica y envía frames.
Si la IA no responde, el endpoint de análisis devuelve un mock.
"""

import json
import logging
import os
import tempfile
import time

import requests
from flask import (
    Flask,
    Response,
    jsonify,
    render_template,
    request,
    stream_with_context,
)

from config import get_config
from lap_episode_reducer import LapEpisodeReducer
from remote_detector import RemoteSwimmerDetector

# Extensiones de video que aceptamos si el navegador no manda un mimetype video/*.
_VIDEO_EXTS = {".mp4", ".webm", ".mov", ".avi", ".mkv", ".m4v", ".ogv", ".ogg"}
_LOGGER = logging.getLogger(__name__)


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
            environ["PATH_INFO"] = path[len(self.prefix) :] or "/"
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


def _remove_file(path):
    """Elimina un temporal de forma idempotente."""
    try:
        os.remove(path)
    except OSError:
        pass


def _sse_detect(
    video_path,
    detector,
    *,
    lap_episode_mode="shadow",
    lap_confidence_threshold=None,
    lap_cooldown_seconds=10.0,
    max_detection_distance_per_second=None,
    logger=_LOGGER,
    request_started=None,
    upload_save_ms=None,
):
    """Generador SSE: un evento por frame siguiendo el contrato de datos.

    `count` conserva el contrato legacy: nº de IDs de caja únicos acumulados
    hasta ese frame (tracklets crudos cuando ByteTrack los produce). Cuando la
    IA publica `identity_summary`, el Front usa ese resumen canónico para
    personas físicas; no se sustituye este campo para no romper consumidores
    antiguos. El video temporal se borra al terminar el stream o si algo falla
    (finally).
    """
    if lap_episode_mode not in {"off", "shadow"}:
        raise ValueError("LAP_EPISODE_MODE debe ser off o shadow.")
    reducer = (
        LapEpisodeReducer(lap_confidence_threshold, lap_cooldown_seconds)
        if lap_episode_mode == "shadow"
        else None
    )
    seen_track_ids = set()
    sse_started = time.perf_counter()
    first_event_at = None
    serialized_bytes = 0
    serialization_ms = 0.0
    yield_resume_ms = 0.0
    emitted_frames = 0
    completed = False
    error_emitted = False
    try:
        # Cada stream remoto crea su propia sesión ByteTrack, por lo que dos
        # uploads concurrentes no comparten IDs ni requieren un lock global.
        for frame in detector.stream(video_path, max_detection_distance_per_second):
            for box in frame.get("boxes", []):
                seen_track_ids.add(box.get("id"))
            frame["count"] = len(seen_track_ids)
            if reducer is not None:
                decisions = reducer.observe(frame.get("lap_scores"))
                if decisions:
                    frame["lap_decisions"] = decisions
                    for decision in decisions:
                        logger.info(
                            "lap_shadow_decision lane_id=%s episode_id=%s "
                            "candidate_time_ms=%.3f lap_score=%.6f "
                            "score_version=%s threshold=%.6f count_incremented=false",
                            decision["lane_id"],
                            decision["candidate_episode_id"],
                            decision["candidate_time_ms"],
                            decision["lap_score"],
                            decision["score_version"],
                            decision["threshold"],
                        )
            serialization_started = time.perf_counter()
            event = f"data: {json.dumps(frame)}\n\n"
            serialization_ms += (time.perf_counter() - serialization_started) * 1000.0
            emitted_frames += 1
            serialized_bytes += len(event.encode("utf-8"))
            if first_event_at is None:
                first_event_at = time.perf_counter()
            yield_started = time.perf_counter()
            yield event
            # WSGI retoma el generador después de aceptar/escribir el evento. No
            # equivale a una medición de red exacta, pero muestra backpressure del
            # response sin registrar contenido ni datos del usuario.
            yield_resume_ms += (time.perf_counter() - yield_started) * 1000.0
        completed = True
    except Exception as exc:  # noqa: BLE001
        # La IA real puede fallar a mitad (video corrupto, etc.). El 200 y los
        # headers SSE ya salieron, así que no se puede devolver un 4xx/5xx: en su
        # lugar mandamos un evento SSE de error para que el front lo muestre en
        # vez de cortar el stream en silencio. (F2)
        serialization_started = time.perf_counter()
        error_event = f"event: error\ndata: {json.dumps({'error': str(exc)})}\n\n"
        serialization_ms += (time.perf_counter() - serialization_started) * 1000.0
        serialized_bytes += len(error_event.encode("utf-8"))
        error_emitted = True
        yield error_event
    finally:
        finished_at = time.perf_counter()
        if reducer is not None:
            for episode in reducer.snapshot():
                logger.info(
                    "lap_shadow_episode_summary lane_id=%s episode_id=%s "
                    "candidate_time_ms=%.3f max_lap_score=%.6f "
                    "score_version=%s decision_emitted=%s",
                    episode["lane_id"],
                    episode["candidate_episode_id"],
                    episode["candidate_time_ms"],
                    episode["lap_score"],
                    episode["score_version"],
                    str(episode["decision_emitted"]).lower(),
                )

        def optional_ms(timestamp):
            if timestamp is None:
                return "unavailable"
            return f"{(timestamp - sse_started) * 1000.0:.1f}"

        request_to_first_event_ms = None
        request_to_end_ms = None
        if request_started is not None:
            request_to_end_ms = (finished_at - request_started) * 1000.0
            if first_event_at is not None:
                request_to_first_event_ms = (first_event_at - request_started) * 1000.0
        logger.info(
            "vision_sse_timing frames=%d first_event_ms=%s sse_elapsed_ms=%.1f "
            "serialization_ms=%.1f yield_resume_ms=%.1f serialized_bytes=%d "
            "request_to_first_event_ms=%s request_to_end_ms=%s upload_save_ms=%s "
            "completed=%s error_emitted=%s",
            emitted_frames,
            optional_ms(first_event_at),
            (finished_at - sse_started) * 1000.0,
            serialization_ms,
            yield_resume_ms,
            serialized_bytes,
            "unavailable"
            if request_to_first_event_ms is None
            else f"{request_to_first_event_ms:.1f}",
            "unavailable" if request_to_end_ms is None else f"{request_to_end_ms:.1f}",
            "unavailable" if upload_save_ms is None else f"{upload_save_ms:.1f}",
            str(completed).lower(),
            str(error_emitted).lower(),
        )
        # "El video se procesa y se DESCARTA": no queda nada en disco.
        _remove_file(video_path)


def create_app(config_overrides=None, detector=None):
    app = Flask(__name__)
    app.config.from_object(get_config())
    if config_overrides:
        app.config.update(config_overrides)
    app.logger.setLevel(logging.INFO)

    lap_episode_mode = app.config.get("LAP_EPISODE_MODE", "shadow")
    if not isinstance(lap_episode_mode, str):
        raise ValueError("LAP_EPISODE_MODE debe ser off o shadow.")
    lap_episode_mode = lap_episode_mode.strip().lower()
    if lap_episode_mode not in {"off", "shadow"}:
        raise ValueError("LAP_EPISODE_MODE debe ser off o shadow.")
    lap_confidence_threshold = app.config.get("LAP_CONFIDENCE_THRESHOLD")
    lap_cooldown_seconds = app.config.get("LAP_COOLDOWN_SECONDS", 10.0)
    if lap_episode_mode == "shadow":
        # Valida la configuración al iniciar, antes de abrir un response SSE.
        LapEpisodeReducer(lap_confidence_threshold, lap_cooldown_seconds)

    # El adaptador no abre red ni decodifica video al construirse. Se conserva
    # en extensions para reutilizar configuración y permitir reemplazarlo en tests.
    app.extensions["swimmer_detector"] = (
        detector
        if detector is not None
        else RemoteSwimmerDetector.from_flask_config(app.config, logger=app.logger)
    )

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
        """Recibe un video, lo procesa en el servicio GPU y responde SSE.

        Un evento por frame con el contrato de datos, con `count` = IDs únicos
        acumulados. El front hace POST con fetch() y lee el stream a mano
        (EventSource no sirve: es solo GET). El video se guarda en un temporal
        solo para pasarle una ruta al detector y se borra al cerrar el stream.
        """
        request_started = time.perf_counter()
        file = request.files.get("video")
        if file is None or not file.filename:
            return jsonify({"ok": False, "error": "Falta el archivo 'video'."}), 400
        if not _looks_like_video(file):
            # Rechazamos acá (antes de abrir el SSE): una vez que empieza el
            # stream ya no se puede devolver un código de error HTTP. (F2)
            return jsonify(
                {"ok": False, "error": "El archivo no parece ser un video."}
            ), 400

        effective_lap_confidence_threshold = lap_confidence_threshold
        effective_lap_cooldown_seconds = lap_cooldown_seconds
        effective_max_detection_distance_per_second = None
        request_lap_confidence_threshold = request.form.get("lap_confidence_threshold")
        if request_lap_confidence_threshold is not None:
            try:
                effective_lap_confidence_threshold = LapEpisodeReducer(
                    request_lap_confidence_threshold
                ).threshold
            except ValueError as exc:
                return jsonify({"ok": False, "error": str(exc)}), 400
        request_lap_cooldown_seconds = request.form.get("lap_cooldown_seconds")
        if request_lap_cooldown_seconds is not None:
            try:
                effective_lap_cooldown_seconds = LapEpisodeReducer(
                    effective_lap_confidence_threshold, request_lap_cooldown_seconds
                ).cooldown_seconds
            except ValueError as exc:
                return jsonify({"ok": False, "error": str(exc)}), 400
        request_max_detection_distance = request.form.get("max_detection_distance_per_second")
        if request_max_detection_distance is not None:
            try:
                effective_max_detection_distance_per_second = float(request_max_detection_distance)
                if not 0 < effective_max_detection_distance_per_second <= 1:
                    raise ValueError
            except (TypeError, ValueError):
                return jsonify({"ok": False, "error": "La distancia máxima debe estar entre 0 y 1."}), 400

        # OpenCV necesita una ruta en disco: guardamos el upload en un temporal.
        # Se elimina al terminar, al fallar o cuando el cliente corta el stream.
        uploaded_ext = os.path.splitext(file.filename)[1].lower()
        suffix = uploaded_ext if uploaded_ext in _VIDEO_EXTS else ".mp4"
        fd, tmp_path = tempfile.mkstemp(suffix=suffix)
        os.close(fd)
        upload_save_started = time.perf_counter()
        try:
            file.save(tmp_path)
        except Exception:
            _remove_file(tmp_path)
            raise
        upload_save_ms = (time.perf_counter() - upload_save_started) * 1000.0
        try:
            upload_bytes = os.path.getsize(tmp_path)
        except OSError:
            upload_bytes = 0
        # Telemetría segura: mide únicamente tamaño y duración; nunca nombre,
        # path, token, contenido del video ni datos de detecciones.
        app.logger.info(
            "vision_upload_timing request_content_length=%s upload_bytes=%d "
            "save_ms=%.1f handler_elapsed_ms=%.1f",
            request.content_length,
            upload_bytes,
            upload_save_ms,
            (time.perf_counter() - request_started) * 1000.0,
        )

        response = Response(
            stream_with_context(
                _sse_detect(
                    tmp_path,
                    app.extensions["swimmer_detector"],
                    lap_episode_mode=lap_episode_mode,
                    lap_confidence_threshold=effective_lap_confidence_threshold,
                    lap_cooldown_seconds=effective_lap_cooldown_seconds,
                    max_detection_distance_per_second=effective_max_detection_distance_per_second,
                    logger=app.logger,
                    request_started=request_started,
                    upload_save_ms=upload_save_ms,
                )
            ),
            mimetype="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",  # que el proxy (Apache) no buffere el stream
            },
        )
        # Respaldo para el caso extremo en que WSGI cierre la respuesta sin
        # empezar a iterar el generador (cuyo finally aún no habría corrido).
        response.call_on_close(lambda: _remove_file(tmp_path))
        return response

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
            return jsonify(
                {
                    "ok": True,
                    "mock": False,
                    "analysis": data.get("analysis", data.get("text", "")),
                }
            )
        except (requests.RequestException, ValueError):
            # IA caída, timeout o respuesta no-JSON: mock para no bloquear el front.
            return jsonify(
                {
                    "ok": True,
                    "mock": True,
                    "analysis": _mock_analysis(payload),
                }
            )

    return app


app = create_app()


if __name__ == "__main__":
    # Solo para dev (`python app.py`). En producción se usa gunicorn -c
    # gunicorn.conf.py app:app. threaded=True para que el stream SSE de
    # /api/detect no bloquee las demás rutas del dev server. `flask run` ya
    # corre con hilos por defecto.
    port = int(os.getenv("FLASK_RUN_PORT", "7001"))
    app.run(
        host="0.0.0.0", port=port, debug=app.config.get("DEBUG", False), threaded=True
    )
