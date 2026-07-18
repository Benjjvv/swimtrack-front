"""Configuración de la aplicación SwimTrack front.

Carga las variables desde .env y expone clases por entorno.
"""

import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    """Configuración base, común a todos los entornos."""

    SECRET_KEY = os.getenv("FLASK_SECRET_KEY", "dev-secret-change-in-prod")
    URL_PREFIX = os.getenv("URL_PREFIX", "/")
    IA_BASE_URL = os.getenv("IA_BASE_URL", "http://localhost:7011")
    IA_SECRET_HEADER = os.getenv("IA_SECRET_HEADER", "")
    MAX_CONTENT_LENGTH = int(os.getenv("MAX_CONTENT_LENGTH", str(1024**3)))

    # Servicio independiente de visión (RT-DETRv2 + ByteTrack) en la GPU.
    VISION_BASE_URL = os.getenv("VISION_BASE_URL", "http://localhost:8001")
    VISION_AUTH_TOKEN = os.getenv("VISION_AUTH_TOKEN", "")
    VISION_LAP_CALIBRATION_ID = os.getenv(
        "VISION_LAP_CALIBRATION_ID", "fixed-camera-v1"
    )
    VISION_TRACKING_DIAGNOSTICS = os.getenv("VISION_TRACKING_DIAGNOSTICS", "none")
    VISION_BATCH_SIZE = int(os.getenv("VISION_BATCH_SIZE", "4"))
    VISION_MAX_FPS = float(os.getenv("VISION_MAX_FPS", "15"))
    VISION_INFERENCE_SIZE = int(os.getenv("VISION_INFERENCE_SIZE", "640"))
    VISION_JPEG_QUALITY = int(os.getenv("VISION_JPEG_QUALITY", "85"))
    VISION_CONNECT_TIMEOUT = float(os.getenv("VISION_CONNECT_TIMEOUT", "5"))
    VISION_READ_TIMEOUT = float(os.getenv("VISION_READ_TIMEOUT", "120"))
    VISION_WRITE_TIMEOUT = float(os.getenv("VISION_WRITE_TIMEOUT", "30"))
    VISION_POOL_TIMEOUT = float(os.getenv("VISION_POOL_TIMEOUT", "5"))
    VISION_CLEANUP_TIMEOUT = float(os.getenv("VISION_CLEANUP_TIMEOUT", "5"))
    VISION_MAX_RETRIES = int(os.getenv("VISION_MAX_RETRIES", "2"))
    VISION_RETRY_BACKOFF_SECONDS = float(
        os.getenv("VISION_RETRY_BACKOFF_SECONDS", "0.5")
    )
    VISION_FALLBACK_FPS = float(os.getenv("VISION_FALLBACK_FPS", "30"))

    # Reducer de episodios en shadow mode. Sin un threshold explícito se
    # registran los máximos por episodio, pero no se emiten decisiones lap.
    LAP_EPISODE_MODE = os.getenv("LAP_EPISODE_MODE", "shadow").strip().lower()
    LAP_CONFIDENCE_THRESHOLD = os.getenv("LAP_CONFIDENCE_THRESHOLD")


class DevelopmentConfig(Config):
    DEBUG = True


class ProductionConfig(Config):
    DEBUG = False


def get_config():
    """Devuelve la clase de config apropiada según FLASK_ENV."""
    env = os.getenv("FLASK_ENV", "development").lower()
    if env == "production":
        return ProductionConfig
    return DevelopmentConfig
