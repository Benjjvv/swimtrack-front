"""SwimTrack — Frontend Flask.

5 rutas de páginas + un endpoint proxy hacia el módulo de IA.
Si la IA no responde, el endpoint devuelve un mock.
"""
import os

import requests
from flask import Flask, jsonify, render_template, request

from config import get_config


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
    port = int(os.getenv("FLASK_RUN_PORT", "7001"))
    app.run(host="0.0.0.0", port=port, debug=app.config.get("DEBUG", False))
