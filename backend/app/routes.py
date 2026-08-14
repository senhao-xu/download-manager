"""HTTP API routes."""
import asyncio
import json
import logging
import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, UploadFile, File
from fastapi.responses import FileResponse, StreamingResponse

from . import downloader, history, jobs
from . import settings as app_settings
from .schemas import (
    BatchRequest,
    BtMagnetRequest,
    CookieCheckResult,
    DownloadRequest,
    HistoryEntry,
    HistoryList,
    HttpDownloadRequest,
    InfoRequest,
    InfoResponse,
    JobCreated,
    JobStatus,
    SettingsUpdate,
    TestRequest,
    TestResult,
)
from .storage import media_type, job_dir
from yt_dlp.utils import DownloadError

router = APIRouter(prefix="/api")

logger = logging.getLogger("routes")

_ZIP_MEDIA = {"application/zip", "video/mp4", "video/webm", "audio/mpeg"}


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


@router.post("/download-http", response_model=JobCreated)
def post_download_http(req: HttpDownloadRequest):
    """Stream-download one or more direct HTTP(S) URLs (server-as-relay)."""
    cleaned = [u.strip() for u in req.urls if u.strip()]
    if not cleaned:
        raise HTTPException(status_code=400, detail="No URLs provided.")
    bad = [u for u in cleaned if not u.lower().startswith(("http://", "https://"))]
    if bad:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid URL(s) (must start with http:// or https://): {bad[:3]}",
        )
    job = jobs.start_http(cleaned)
    return JobCreated(job_id=job.id)


@router.post("/download-bt", response_model=JobCreated)
def post_download_bt(req: BtMagnetRequest):
    """Start a BitTorrent download from a magnet link."""
    magnet = req.magnet.strip()
    low = magnet.lower()
    if not low.startswith("magnet:?") or "xt=urn:btih:" not in low:
        raise HTTPException(
            status_code=400,
            detail="Invalid magnet link. It must start with 'magnet:?' and contain 'xt=urn:btih:'.",
        )
    job = jobs.start_bt(magnet)
    return JobCreated(job_id=job.id)


@router.post("/download-bt/file", response_model=JobCreated)
async def post_download_bt_file(file: UploadFile = File(...)):
    """Start a BitTorrent download from an uploaded .torrent file.

    Writes the uploaded bytes to the job's temp dir, then starts the job with
    that file path as the source. The .torrent is small, so a synchronous write
    here is fine.
    """
    # Create the job first so we have a temp dir to write the .torrent into.
    job = jobs.create_job()
    dest = job_dir(job.id)
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    suffix = Path(file.filename or "").suffix.lower()
    if suffix and suffix != ".torrent":
        raise HTTPException(
            status_code=400,
            detail=f"Expected a .torrent file, got '{suffix or 'no extension'}'.",
        )
    torrent_path = dest / "source.torrent"
    torrent_path.write_bytes(raw)
    jobs.start_bt_with_job(job, str(torrent_path))
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
        media_type=media_type(job.result_path),
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
    return FileResponse(path, media_type=media_type(path), filename=filename)


@router.get("/history", response_model=HistoryList)
def get_history(kind: str | None = None, page: int = 1, page_size: int = 10):
    """List past downloads, newest-first, filtered by `kind` and paginated.

    `kind` is one of "youtube" | "http" | "bt" (None = all). `page` is
    1-indexed; `page_size` defaults to 10 (clamped to [1, 100] in history).
    `available` reflects on-disk presence.
    """
    recs, total = history.list_page(kind=kind, page=page, page_size=page_size)
    items: list[HistoryEntry] = []
    for rec in recs:
        path = rec.get("path")
        available = bool(path) and Path(path).exists()
        items.append(HistoryEntry(
            id=rec.get("id", ""),
            kind=rec.get("kind", ""),
            title=rec.get("title"),
            source=rec.get("source"),
            filename=rec.get("filename"),
            size=rec.get("size"),
            mime=rec.get("mime"),
            created=rec.get("created", 0),
            available=available,
        ))
    return HistoryList(items=items, total=total, page=page, page_size=page_size)


@router.delete("/history/{job_id}")
def delete_history(job_id: str, delete_files: bool = False):
    """Delete the history record(s) for `job_id`.

    Optionally also removes the downloaded file(s) on disk. Files live under the
    job's directory (``<DOWNLOAD_DIR>/<job_id>``); because a batch/playlist job
    writes multiple history records sharing one id, the whole job dir is removed
    when ``delete_files`` is set (the records are removed regardless).
    """
    removed = history.delete_by_id(job_id)
    if removed is None:
        raise HTTPException(status_code=404, detail="No history record for that id.")

    deleted_files = False
    if delete_files:
        d = Path(removed.get("path") or "")
        # Resolve to the job directory: the recorded path may be a single file
        # inside it, or the job dir itself. Walk up to the DOWNLOAD_DIR/<id> root.
        from . import storage
        job_root = storage.job_dir(job_id)
        try:
            if job_root.exists():
                shutil.rmtree(job_root, ignore_errors=True)
                deleted_files = True
        except Exception as e:  # never fail the API call over file cleanup
            logger.warning("failed to remove job dir %s: %s", job_root, e)
    return {"ok": True, "deleted_files": deleted_files}


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
