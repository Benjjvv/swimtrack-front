# SwimTrack — Frontend

Frontend Flask de SwimTrack, sistema de visión por computadora para entrenamiento de natación.

Ver [PLAN.md](PLAN.md) para la especificación completa del proyecto.

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

## Estructura

- `app.py` — Flask + las 5 rutas + endpoint proxy hacia el módulo de IA.
- `config.py` — Configuración por entorno (dev/prod).
- `templates/` — Plantillas Jinja (1 por página + `base.html`).
- `static/css/theme.css` — Tema oscuro sobre Bootstrap.
- `static/js/` — JS vanilla, un archivo por página + módulos compartidos en `lib/`.

## Estado

En desarrollo. Ver [PLAN.md](PLAN.md) para el desglose por tareas.
