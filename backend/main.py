"""FastAPI 应用入口。

负责创建应用实例、配置跨域与静态资源，并挂载各业务路由。
"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from config import settings
from routers import balloons


def create_app() -> FastAPI:
    app = FastAPI(
        title=settings.PROJECT_NAME,
        version="1.0.0",
        description="根据探空气球传回的气压/温度数据反演高度与风速，并推演落点轨迹。",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(balloons.router, prefix=settings.API_PREFIX)

    @app.get("/health", tags=["meta"])
    def health() -> dict:
        return {"status": "ok", "service": settings.PROJECT_NAME}

    if settings.FRONTEND_DIR.exists():
        app.mount("/", StaticFiles(directory=settings.FRONTEND_DIR, html=True), name="frontend")

    return app


app = create_app()
