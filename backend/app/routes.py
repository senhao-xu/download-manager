"""HTTP API routes."""
import asyncio
import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse

from . import downloader, jobs
from . import settings as app_settings
from .schemas import (
    BatchRequest,
    CookieCheckResult,
    DownloadRequest,
    InfoRequest,
    InfoResponse,
    JobCreated,
    JobStatus,
    SettingsUpdate,
    TestRequest,
    TestResult,
)
from yt_dlp.utils import DownloadError

router = APIRouter(prefix="/api")

_ZIP_MEDIA = {"application/zip", "video/mp4", "video/webm", "audio/mpeg"}


def _media_type(path: str) -> str:
    p = path.lower()
    if p.endswith(".zip"):
        return "application/zip"
    if p.endswith(".mp4"):
        return "video/mp4"
    if p.endswith(".webm"):
        return "video/webm"
    if p.endswith(".m4a"):
        return "audio/mp4"
    if p.endswith(".mp3"):
        return "audio/mpeg"
    return "application/octet-stream"


@router.get("/healthz")
def healthz():
    return {"status": "ok"}


@router.post("/info", response_model=InfoResponse)
async def post_info(req: InfoRequest):
    try:
        return await downloader.extract_info(req.url)
    except DownloadError as e:
        raise HTTPException(status_code=400, detail=_friendly(e))
    except Exception as e:  # pragma: no cover - defensive
        raise HTTPException(status_code=400, detail=_friendly(e))


@router.post("/download", response_model=JobCreated)
async def post_download(req: DownloadRequest):
    job = jobs.start_single(req.url, req.quality)
    return JobCreated(job_id=job.id)


@router.post("/download-batch", response_model=JobCreated)
async def post_download_batch(req: BatchRequest):
    if not req.urls:
        raise HTTPException(status_code=400, detail="No URLs selected.")
    job = jobs.start_batch(req.urls, req.quality, req.zip)
    return JobCreated(job_id=job.id)


@router.get("/jobs/{job_id}", response_model=JobStatus)
def get_job_status(job_id: str):
    job = jobs.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    return jobs.snapshot(job)


@router.get("/jobs/{job_id}/events")
async def job_events(job_id: str):
    job = jobs.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")

    async def gen():
        while True:
            j = jobs.get_job(job_id)
            if not j:
                yield _sse({"status": "error", "error": "Job lost."})
                break
            snap = jobs.snapshot(j)
            yield _sse(snap.model_dump())
            if j.status in ("done", "error"):
                break
            await asyncio.sleep(0.4)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.api_route("/files/{job_id}", methods=["GET", "HEAD"])
def get_file(job_id: str):
    job = jobs.get_job(job_id)
    if not job or job.status != "done" or not job.result_path:
        raise HTTPException(status_code=404, detail="File not ready.")
    return FileResponse(
        job.result_path,
        media_type=_media_type(job.result_path),
        filename=job.result_filename or "download",
    )


@router.api_route("/files/{job_id}/{index}", methods=["GET", "HEAD"])
def get_file_indexed(job_id: str, index: int):
    """Serve one file from a non-zip batch download (multiple mp4s)."""
    job = jobs.get_job(job_id)
    if not job or job.status != "done" or not job.files:
        raise HTTPException(status_code=404, detail="File not ready.")
    if index < 0 or index >= len(job.files):
        raise HTTPException(status_code=404, detail="File not found.")
    path, filename = job.files[index]
    return FileResponse(path, media_type=_media_type(path), filename=filename)


# ---- Settings (cookies + proxy + JS runtime), user-editable via UI ----

@router.get("/settings")
def get_settings():
    return app_settings.public_state()


@router.put("/settings")
def put_settings(req: SettingsUpdate):
    return app_settings.save(req.model_dump())


@router.put("/settings/cookies")
async def put_cookies(request: Request):
    content = (await request.body()).decode("utf-8", errors="replace")
    if not content.strip():
        raise HTTPException(status_code=400, detail="Empty cookies content.")
    app_settings.save_cookies(content)
    return {"ok": True, "cookies_configured": True}


@router.delete("/settings/cookies")
def del_cookies():
    app_settings.clear_cookies()
    return {"ok": True, "cookies_configured": False}


@router.post("/settings/test", response_model=TestResult)
async def test_settings(req: TestRequest):
    """Try extracting info for a URL with the current settings, as a connection check."""
    try:
        info = await asyncio.wait_for(downloader.extract_info(req.url), timeout=45)
        return TestResult(ok=True, title=info.title)
    except asyncio.TimeoutError:
        return TestResult(ok=False, error="Timed out after 45s. Check your proxy/cookies.")
    except Exception as e:
        return TestResult(ok=False, error=_friendly(e))


@router.post("/settings/check-cookies", response_model=CookieCheckResult)
async def check_cookies(req: TestRequest):
    """Check whether the configured cookies actually let us through YouTube's bot wall."""
    if not app_settings.effective_opts().get("cookiefile"):
        return CookieCheckResult(state="no_cookies")
    try:
        info = await asyncio.wait_for(downloader.extract_info(req.url), timeout=45)
        return CookieCheckResult(state="working", title=info.title)
    except asyncio.TimeoutError:
        return CookieCheckResult(state="network_error", detail="Timed out after 45s.")
    except Exception as e:
        msg = _friendly(e)
        low = str(e).lower()
        if "sign in" in low or "not a bot" in low:
            return CookieCheckResult(state="blocked", detail=msg)
        if any(k in low for k in ("timeout", "connection", "unreachable", "proxy",
                                  "timed out", "errno", "resolve", "refused", "reset")):
            return CookieCheckResult(state="network_error", detail=msg)
        return CookieCheckResult(state="error", detail=msg)


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj)}\n\n"


def _friendly(e: Exception) -> str:
    # reuse the jobs helper
    from .jobs import _friendly_error
    return _friendly_error(e)
