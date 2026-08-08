"""In-memory job registry + background workers (threadpool).

Single-video and batch (playlist) downloads run in a ThreadPoolExecutor because
yt-dlp is blocking. Progress is written to the Job from yt-dlp progress hooks;
the SSE route reads Job snapshots.
"""
import logging
import re
import threading
import time
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from yt_dlp.utils import DownloadError

from .config import settings
from . import downloader, history, http_dl, storage
from .schemas import JobStatus
from .storage import media_type

logger = logging.getLogger("jobs")


@dataclass
class Job:
    id: str
    status: str = "queued"  # queued | running | done | error
    progress: float = 0.0
    current: int | None = None
    total: int | None = None
    phase: str | None = None
    title: str | None = None
    error: str | None = None
    download_url: str | None = None
    result_path: str | None = None
    result_filename: str | None = None
    # individual files for non-zip batch: list of (path, display_filename)
    files: list = field(default_factory=list)
    updated: float = field(default_factory=time.time)


_jobs: dict[str, Job] = {}
_lock = threading.Lock()
_executor = ThreadPoolExecutor(max_workers=settings.max_concurrent, thread_name_prefix="ytdl-worker")


def create_job() -> Job:
    job = Job(id=uuid.uuid4().hex[:12])
    with _lock:
        _jobs[job.id] = job
    return job


def get_job(job_id: str) -> Job | None:
    with _lock:
        return _jobs.get(job_id)


def snapshot(job: Job) -> JobStatus:
    with _lock:
        if job.files and not job.download_url:
            # non-zip batch: one indexed URL per file (works for 1 or N)
            urls = [f"/api/files/{job.id}/{i}" for i in range(len(job.files))]
        elif job.download_url:
            urls = [job.download_url]
        else:
            urls = []
        return JobStatus(
            id=job.id,
            status=job.status,
            progress=round(job.progress, 1),
            current=job.current,
            total=job.total,
            phase=job.phase,
            title=job.title,
            error=job.error,
            download_url=urls[0] if urls else None,
            download_urls=urls,
        )


def _friendly_error(e: Exception) -> str:
    msg = str(e).strip()
    low = msg.lower()
    if "sign in to confirm" in low or "not a bot" in low:
        return (
            "YouTube blocked the request as a bot. Open Settings to configure "
            "cookies (exported from a logged-in browser) and/or a proxy."
        )
    if "private" in low or "members" in low or "age-restricted" in low:
        return "This video is private, age-restricted, or members-only. Provide cookies (YTDLP_COOKIEFILE) to access it."
    if "unsupported url" in low or "no suitable" in low:
        return "That URL is not supported or is not a valid video/playlist link."
    if "http error 403" in low or "forbidden" in low:
        return "The source returned 403 Forbidden (may block non-browser clients). Try a different video or configure cookies/proxy."
    # yt-dlp errors are often multi-line; the real cause is usually the last
    # non-empty line. Strip the leading "ERROR:" noise.
    lines = [ln.strip() for ln in msg.splitlines() if ln.strip()]
    lines = [re.sub(r"^ERROR:\s*", "", ln) for ln in lines]
    detail = lines[-1] if lines else msg
    return detail[:300] if detail else "Download failed."


def _safe_base(title: str | None, fallback: str) -> str:
    """Sanitized filename stem (no extension) from a title."""
    base = (title or fallback).strip()
    keep = "".join(c for c in base if c.isalnum() or c in " -_().")
    return keep.strip(" .") or fallback


def _filename(base: str, ext: str, index: int | None = None, width: int = 2) -> str:
    """Assemble a download filename; optionally prefix with an order number."""
    ext = ext.lstrip(".")
    return f"{base}.{ext}" if index is None else f"{index:0{width}d} - {base}.{ext}"


def start_single(url: str, quality: str) -> Job:
    job = create_job()
    _executor.submit(_run_single, job, url, quality)
    return job


def start_batch(urls: list[str], quality: str, zip_mode: bool = False) -> Job:
    job = create_job()
    job.total = len(urls)
    _executor.submit(_run_batch, job, urls, quality, zip_mode)
    return job


def start_http(urls: list[str]) -> Job:
    """Start an HTTP relay download job for one or more direct URLs."""
    job = create_job()
    job.total = len(urls)
    _executor.submit(_run_http, job, urls)
    return job


def _set(job: Job, **kw):
    with _lock:
        for k, v in kw.items():
            setattr(job, k, v)
        job.updated = time.time()


def _record_history(job: Job, kind: str, source: str | None,
                    path: str, filename: str, mime: str | None) -> None:
    """Append a history record for one completed file.

    Failure to record is logged but never re-raised: a history write must not
    break a download. `mime` is derived via `storage.media_type(path)`.
    """
    try:
        sz = Path(path).stat().st_size
    except OSError:
        sz = None
    try:
        history.append({
            "id": job.id,
            "kind": kind,
            "title": job.title,
            "source": source,
            "filename": filename,
            "path": path,
            "size": sz,
            "mime": mime,
        })
    except Exception:
        logger.exception("failed to record history for job %s", job.id)


def _run_single(job: Job, url: str, quality: str):
    _set(job, status="running", phase="starting")
    d = storage.job_dir(job.id)

    def hook(ev):
        st = ev.get("status")
        if st == "downloading":
            total = ev.get("total_bytes") or ev.get("total_bytes_estimate") or 0
            done = ev.get("downloaded_bytes", 0)
            pct = (done / total * 99.0) if total else job.progress
            _set(job, progress=max(job.progress, pct), phase="downloading")
        elif st == "finished":
            _set(job, progress=max(job.progress, 99.0), phase="processing (merging)")

    try:
        info, files = downloader.download_sync(url, quality, d, hook)
        f = files[0]
        name = _filename(_safe_base(info.get("title"), f.stem), f.suffix)
        _set(
            job,
            status="done",
            progress=100.0,
            phase="done",
            title=info.get("title"),
            result_path=str(f),
            result_filename=name,
            files=[(str(f), name)],
            download_url=f"/api/files/{job.id}",
        )
        _record_history(job, "youtube", url, str(f), name, media_type(str(f)))
    except Exception as e:
        logger.exception("single download failed for job %s", job.id)
        _set(job, status="error", error=_friendly_error(e), phase="error")


def _run_batch(job: Job, urls: list[str], quality: str, zip_mode: bool):
    total = len(urls)
    _set(job, status="running", phase="starting", total=total, current=0)
    d = storage.job_dir(job.id)
    saved: list = []  # (path, display_filename)

    try:
        for i, url in enumerate(urls):
            _set(job, current=i, phase=f"downloading {i + 1}/{total}")
            base = (i / total) * 100.0 if total else 0.0

            def hook(ev, base=base, span=(100.0 / total if total else 100.0)):
                if ev.get("status") == "downloading":
                    t = ev.get("total_bytes") or ev.get("total_bytes_estimate") or 0
                    done = ev.get("downloaded_bytes", 0)
                    sub = (done / t) if t else 0
                    _set(job, progress=min(99.5, base + span * sub))
                elif ev.get("status") == "finished":
                    _set(job, progress=min(99.5, base + span))

            info, files = downloader.download_sync(url, quality, d, hook)
            seq = i + 1
            for f in files:
                name = _filename(_safe_base(info.get("title"), f.stem), f.suffix, index=seq)
                saved.append((str(f), name))

        if zip_mode:
            _set(job, phase="packaging zip", progress=99.5)
            zip_path = d / "playlist.zip"
            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
                for path, name in saved:
                    z.write(path, arcname=name)
            _set(
                job,
                status="done",
                progress=100.0,
                phase="done",
                result_path=str(zip_path),
                result_filename="playlist.zip",
                files=[],
                download_url=f"/api/files/{job.id}",
            )
            _record_history(
                job, "youtube", urls[0] if urls else None,
                str(zip_path), "playlist.zip", media_type(str(zip_path)),
            )
        else:
            # return each file directly as mp4 (no zip)
            _set(
                job,
                status="done",
                progress=100.0,
                phase="done",
                files=saved,
                result_path=None,
                result_filename=None,
                download_url=None,
            )
            for path, name in saved:
                _record_history(
                    job, "youtube", None, path, name, media_type(path),
                )
    except Exception as e:
        logger.exception("batch download failed for job %s", job.id)
        _set(job, status="error", error=_friendly_error(e), phase="error")


def _run_http(job: Job, urls: list[str]):
    """HTTP relay worker. Mirrors the non-zip batch path: each URL becomes one
    file served via an indexed ``/api/files/{id}/{i}`` URL. No zip for HTTP.

    ``job.files`` stays the 2-tuple ``(path, filename)`` shape so the schema and
    the file-serving routes are unchanged; the MIME goes to history only.
    """
    total = len(urls)
    _set(job, status="running", phase="starting", total=total, current=0)
    d = storage.job_dir(job.id)
    saved: list = []  # (path, display_filename)

    try:
        for i, url in enumerate(urls):
            _set(job, current=i, phase=f"downloading {i + 1}/{total}")
            base = (i / total) * 100.0 if total else 0.0
            span = (100.0 / total) if total else 100.0

            def hook(ev, base=base, span=span):
                if ev.get("status") == "downloading":
                    t = ev.get("total_bytes") or 0
                    dn = ev.get("downloaded_bytes", 0)
                    sub = (dn / t) if t else 0
                    _set(job, progress=min(99.5, base + span * sub))
                elif ev.get("status") == "finished":
                    _set(job, progress=min(99.5, base + span))

            name, path, _size, mime = http_dl.download_sync(url, d, hook)
            saved.append((str(path), name))
            _record_history(job, "http", url, str(path), name, mime)

        _set(
            job,
            status="done",
            progress=100.0,
            phase="done",
            files=saved,
            # Single file -> direct URL + result_path so the non-indexed
            # /api/files/{id} route serves it (mirrors _run_single). Batch ->
            # indexed URLs via snapshot() (result_path stays None).
            result_path=(saved[0][0] if len(saved) == 1 else None),
            result_filename=(saved[0][1] if len(saved) == 1 else None),
            download_url=(f"/api/files/{job.id}" if len(saved) == 1 else None),
        )
    except Exception as e:
        logger.exception("http download failed for job %s", job.id)
        _set(job, status="error", error=_friendly_error(e), phase="error")
