"""API assembly with separate account-service and household-data surfaces."""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import unquote

from fastapi import APIRouter, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .db import provider
from .migrate import run_migrations
from .permissions import PermissionDenied
from .routers import attachments, auth, batches, catalog, desktop, events, items, labels, maintenance, public, scan, sync, system

logging.basicConfig(
    level=os.getenv("HOMELEDGER_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)
log = logging.getLogger("homeledger")
STATIC_DIR = Path(__file__).parent / "static"
API_PREFIX = "/api/v1"


@asynccontextmanager
async def lifespan(app: FastAPI):
    run_migrations(verbose=False)
    log.info("HomeLedger %s starting | mode=%s | db=%s", settings.app_version,
             "accounts" if app.state.service_mode else settings.deployment_mode, provider.dialect)
    task: asyncio.Task | None = None
    if not app.state.service_mode and os.getenv("HOMELEDGER_ENABLE_SCHEDULER", "true").lower() != "false":
        from .scheduler import run_forever
        task = asyncio.create_task(run_forever(settings.reminder_poll_seconds))
    yield
    if task:
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass


class StreamSafeGZipMiddleware(GZipMiddleware):
    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["path"].endswith("/events/stream"):
            await self.app(scope, receive, send)
            return
        await super().__call__(scope, receive, send)


class BodyLimitMiddleware:
    """Check chunked bodies as well as Content-Length before handlers mutate data."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") not in {"POST", "PUT", "PATCH"}:
            return await self.app(scope, receive, send)
        path = scope["path"]
        is_file = path.endswith("/attachments") or "/sync/blob/" in path
        limit = (settings.max_upload_mb + 1) * 1024 * 1024 if is_file else 4 * 1024 * 1024
        limit = max(1, limit)
        headers = dict(scope.get("headers", []))
        try:
            declared = int(headers.get(b"content-length", b"0"))
        except ValueError:
            declared = limit + 1
        chunks = []
        total = 0
        while declared <= limit:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            total += len(message.get("body", b""))
            if total > limit:
                break
            chunks.append(message)
            if not message.get("more_body", False):
                async def replay():
                    return chunks.pop(0) if chunks else await receive()
                return await self.app(scope, replay, send)
        response = JSONResponse({"detail": "请求内容过大"}, status_code=413)
        await response(scope, receive, send)


def static_candidate(root: Path, full_path: str) -> Path | None:
    """Resolve once inside the static root; Windows separators/ADS are not assets."""
    decoded = unquote(unquote(full_path))
    if "\\" in decoded or ":" in decoded or "\x00" in decoded:
        return None
    if any(part in {".", ".."} for part in decoded.split("/")) or decoded.startswith("/"):
        return None
    root = root.resolve()
    candidate = (root / decoded).resolve()
    if not candidate.is_relative_to(root):
        return None
    return candidate


def create_app(*, service_mode: bool | None = None, static_dir: Path | None = None) -> FastAPI:
    accounts = settings.service_mode if service_mode is None else service_mode
    app = FastAPI(
        title="HomeLedger Account Service" if accounts else "HomeLedger API",
        version=settings.app_version, lifespan=lifespan,
        docs_url=None if accounts else "/api/docs",
        redoc_url=None if accounts else "/api/redoc",
        openapi_url=None if accounts else "/api/openapi.json",
    )
    app.state.service_mode = accounts
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origin_list,
                       allow_credentials=False, allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
                       allow_headers=["Authorization", "Content-Type", "X-Family-Id", "X-Desktop-Token"],
                       expose_headers=["Content-Disposition", "Retry-After"])
    app.add_middleware(StreamSafeGZipMiddleware, minimum_size=800)
    app.add_middleware(BodyLimitMiddleware)

    @app.middleware("http")
    async def response_headers(request: Request, call_next):
        response = await call_next(request)
        path = request.url.path
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")
        if path.startswith(API_PREFIX):
            response.headers.setdefault("Cache-Control", "no-store")
        elif path.startswith("/assets/"):
            response.headers.setdefault("Cache-Control", "public, max-age=31536000, immutable")
        elif path in ("/", "/index.html", "/sw.js", "/manifest.webmanifest"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.exception_handler(PermissionDenied)
    async def permission_handler(request: Request, exc: PermissionDenied):
        return JSONResponse(status_code=403, content={"detail": str(exc), "permission": exc.permission, "code": "permission_denied"})

    if accounts:
        # Route assembly, not a UI flag: none of the data-plane endpoints exist.
        allowed = {"/auth/register", "/auth/login", "/auth/me", "/auth/change-password",
                   "/system/health", "/system/stats"}
        limited = APIRouter()
        limited.routes.extend(route for router in (auth.router, system.router)
                              for route in router.routes if route.path in allowed)
        app.include_router(limited, prefix=API_PREFIX)
    else:
        for router in (auth.router, catalog.router, items.router, batches.router, attachments.router,
                       maintenance.router, labels.router, scan.router, sync.router, system.router,
                       events.router, public.router):
            app.include_router(router, prefix=API_PREFIX)
        if settings.desktop_shell:
            app.include_router(desktop.router, prefix=API_PREFIX)

        @app.get("/api", include_in_schema=False)
        def api_root():
            return RedirectResponse("/api/docs")

    root = static_dir if static_dir is not None else STATIC_DIR
    if not accounts and root.exists() and settings.serve_frontend:
        if (root / "assets").exists():
            app.mount("/assets", StaticFiles(directory=root / "assets"), name="assets")

        @app.get("/{full_path:path}", include_in_schema=False)
        async def spa(full_path: str):
            if full_path.startswith(("api/", "docs", "openapi")):
                return JSONResponse({"detail": "Not Found"}, status_code=404)
            candidate = static_candidate(root, full_path)
            if candidate is None:
                return JSONResponse({"detail": "Not Found"}, status_code=404)
            if full_path and candidate.is_file():
                return FileResponse(candidate)
            index = static_candidate(root, "index.html")
            if index and index.is_file():
                return FileResponse(index)
            return JSONResponse({"detail": "前端尚未构建"}, status_code=404)
    else:
        @app.get("/", include_in_schema=False)
        def root_status():
            return {"app": settings.app_name, "service_mode": accounts}
    return app


app = create_app()
