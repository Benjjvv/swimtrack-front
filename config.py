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
