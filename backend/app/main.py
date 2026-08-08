"""FastAPI application entrypoint.

Run: uvicorn app.main:app --host 0.0.0.0 --port 8000
"""
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import routes, storage

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    storage.start_cleanup_thread()
    yield


app = FastAPI(title="YouTube Download Website", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # personal/self-hosted; tighten if exposed publicly
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(routes.router)

# Serve the built frontend if present (production / Docker). In dev the Vite
# dev server (frontend/) serves the UI on its own port.
_frontend_dist = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
if _frontend_dist.is_dir():
    app.mount("/", StaticFiles(directory=str(_frontend_dist), html=True), name="frontend")
