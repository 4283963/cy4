"""应用全局配置。"""
from __future__ import annotations

from pathlib import Path


class Settings:
    PROJECT_NAME: str = "气象探空气球轨迹模拟服务"
    API_PREFIX: str = "/api"

    BACKEND_DIR: Path = Path(__file__).resolve().parent
    PROJECT_DIR: Path = BACKEND_DIR.parent

    FRONTEND_DIR: Path = PROJECT_DIR / "frontend"

    CORS_ORIGINS: list[str] = [
        "http://localhost",
        "http://localhost:5173",
        "http://localhost:8080",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:8080",
    ]

    EARTH_RADIUS_M: float = 6_371_000.0
    OMEGA: float = 7.2921e-5


settings = Settings()
