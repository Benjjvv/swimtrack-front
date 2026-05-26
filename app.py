"""SwimTrack — Frontend Flask.

5 rutas de páginas + un endpoint proxy hacia el módulo de IA.
Si la IA no responde, el endpoint devuelve un mock.
"""
import os

from flask import Flask, jsonify, render_template

from config import get_config


def create_app():
    app = Flask(__name__)
    app.config.from_object(get_config())

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
        # En la Tarea 8 se conecta con el Flask de IA real.
        # Por ahora devuelve un mock para no bloquear el desarrollo.
        return jsonify({
            "ok": True,
            "mock": True,
            "analysis": "Pendiente — implementar en tarea 8",
        })

    return app


app = create_app()


if __name__ == "__main__":
    port = int(os.getenv("FLASK_RUN_PORT", "7001"))
    app.run(host="0.0.0.0", port=port, debug=app.config.get("DEBUG", False))
