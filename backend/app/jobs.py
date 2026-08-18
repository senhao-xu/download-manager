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
from . import downloader, history, http_dl, bt_dl, storage
from .errors import JobCancelled
from .schemas import JobStatus
from .storage import media_type

logger = logging.getLogger("jobs")


@dataclass
class Job:
    id: str
    kind: str | None = None  # "youtube" | "http" | "bt" | "bilibili"
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
    # Cancellation/pause signals. Set/cleared by route handlers (event-loop
    # thread), polled by worker threads at download check points. threading.Event
    # is itself thread-safe; they never appear in snapshots.
    cancel_event: threading.Event = field(default_factory=threading.Event)
    pause_event: threading.Event = field(default_factory=threading.Event)


_jobs: dict[str, Job] = {}
_lock = threading.Lock()
_executor = ThreadPoolExecutor(max_workers=settings.max_concurrent, thread_name_prefix="ytdl-worker")
# Dedicated BT pool: long torrents must not occupy yt-dlp/HTTP slots. Defaults to
# 1 (bandwidth-bound; self-hosted). Override with BT_MAX_CONCURRENT.
_bt_executor = ThreadPoolExecutor(max_workers=settings.bt_max_concurrent, thread_name_prefix="bt-worker")


def create_job(kind: str | None = None) -> Job:
    job = Job(id=uuid.uuid4().hex[:12], kind=kind)
    with _lock:
        _jobs[job.id] = job
    return job


def get_job(job_id: str) -> Job | None:
    with _lock:
        return _jobs.get(job_id)


def is_running(job_id: str) -> bool:
    """True if a job with this id exists and is still active (not terminal).

    ``paused`` counts as active so the TTL cleanup sweep protects a paused BT
    job's partial files. Used by the TTL cleanup sweep; job_id is the directory
    name under DOWNLOAD_DIR, which matches the Job id.
    """
    with _lock:
        j = _jobs.get(job_id)
        return bool(j and j.status in ("queued", "running", "paused"))


def _is_terminal(status: str) -> bool:
    return status in ("done", "error", "cancelled")


def list_active(kind: str | None = None) -> list[JobStatus]:
    """Snapshots of all in-flight (queued/running/paused) jobs, newest-first.

    Used by ``GET /api/jobs`` so the frontend can restore live progress after a
    page reload - including paused BT jobs. ``kind`` ("youtube"|"http"|"bt")
    optionally filters; None returns every active job. Terminal jobs are excluded
    (they live in history, except cancelled which is dropped).
    """
    with _lock:
        matched = [
            j for j in _jobs.values()
            if j.status in ("queued", "running", "paused") and (kind is None or j.kind == kind)
        ]
    matched.sort(key=lambda j: j.updated, reverse=True)
    return [snapshot(j) for j in matched]


# ---- Cancel / pause / resume control (called by route handlers) ----

def request_cancel(job_id: str) -> Job | None:
    """Signal a job to cancel. Idempotent: a no-op on terminal/missing jobs.

    Returns the Job (or None if not found). The actual status transition happens
    in the worker when it observes the event; setting the event on an already-
    terminal job is harmless.
    """
    with _lock:
        j = _jobs.get(job_id)
        if j is None:
            return None
        j.cancel_event.set()
        return j


def request_pause(job_id: str) -> tuple[Job | None, str]:
    """Signal a BT job to pause. Returns (job, code).

    code is one of: ``not_found`` / ``wrong_kind`` (not BT) / ``no_op`` (status
    not running or already paused) / ``ok``. Pause is honored only in the BT
    download poll loop.
    """
    with _lock:
        j = _jobs.get(job_id)
        if j is None:
            return None, "not_found"
        if j.kind != "bt":
            return j, "wrong_kind"
        if j.status not in ("running", "paused"):
            return j, "no_op"
        j.pause_event.set()
        return j, "ok"


def request_resume(job_id: str) -> tuple[Job | None, str]:
    """Clear a BT job's pause. Returns (job, code); same codes as request_pause."""
    with _lock:
        j = _jobs.get(job_id)
        if j is None:
            return None, "not_found"
        if j.kind != "bt":
            return j, "wrong_kind"
        if j.status not in ("running", "paused"):
            return j, "no_op"
        j.pause_event.clear()
        return j, "ok"


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
            kind=job.kind,
        )


def _friendly_error(e: Exception) -> str:
    if isinstance(e, JobCancelled):
        return "Cancelled"
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
    # ---- Bilibili ----
    if "upgrade to the bilibili app" in low or "app to watch" in low \
            or ("bilibili" in low and any(k in low for k in ("login", "sign in", "登录", "会员"))):
        return (
            "This Bilibili video requires a login (or is app/member-only). Open the "
            "Bilibili tab > Settings and paste cookies from a logged-in browser "
            "(must include bilibili.com, e.g. SESSDATA) to unlock it."
        )
    if "http error 412" in low:
        return (
            "Bilibili rejected the request (412 anti-hotlink). This usually happens "
            "for anonymous/unauthorized access - configure Bilibili cookies and/or "
            "a proxy in the Bilibili tab settings."
        )
    # ---- HTTP relay: connection / stall failures ----
    if "timed out" in low or "operation timed out" in low or "could not resolve host" in low \
            or "connection refused" in low or "connection reset" in low or "failed to connect" in low:
        return "Could not reach the server, or it stopped sending data (stalled). Check the URL, your network/proxy, and try again."
    # ---- BitTorrent / libtorrent ----
    if "missing info-hash" in low or "invalid info-hash" in low:
        return "That magnet link has a missing or invalid info-hash. Check the link and try again."
    if "timed out fetching torrent metadata" in low:
        return "Timed out fetching torrent metadata. The magnet link may be dead (no peers) or the swarm is unreachable."
    if "timed out waiting for the torrent to start" in low:
        return "No peers sent any data in time. The torrent's swarm may be dead - try another source or again later."
    if "download stalled" in low and "swarm went quiet" in low:
        return "The download stalled with no progress for too long. The swarm went quiet - try again later."
    if "invalid or corrupt" in low and "torrent" in low:
        return "That .torrent file is invalid or corrupt."
    if "could not be read" in low and "torrent" in low:
        return "That .torrent file could not be read. Please re-download it and try again."
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


def _basename(p: str | None) -> str | None:
    """Display name from a progress-hook `filename` (a full path, possibly .part)."""
    if not p:
        return None
    from pathlib import Path
    return Path(p).name


def start_single(url: str, quality: str) -> Job:
    job = create_job("youtube")
    _executor.submit(_run_single, job, url, quality, "youtube", "default")
    return job


def start_batch(urls: list[str], quality: str, zip_mode: bool = False, title: str | None = None) -> Job:
    job = create_job("youtube")
    job.total = len(urls)
    _executor.submit(_run_batch, job, urls, quality, zip_mode, title, "youtube", "default")
    return job


def start_bilibili(url: str, quality: str) -> Job:
    """Start a Bilibili download (single video, or one URL of a multi-part set).

    Reuses the yt-dlp pipeline (yt-dlp natively supports bilibili.com), with
    ``site="bilibili"`` so the Bilibili-specific cookie file is used.
    """
    job = create_job("bilibili")
    _executor.submit(_run_single, job, url, quality, "bilibili", "bilibili")
    return job


def start_bilibili_batch(urls: list[str], quality: str, zip_mode: bool = False, title: str | None = None) -> Job:
    """Start a Bilibili multi-part / playlist (分P/合集) download."""
    job = create_job("bilibili")
    job.total = len(urls)
    _executor.submit(_run_batch, job, urls, quality, zip_mode, title, "bilibili", "bilibili")
    return job


def start_http(urls: list[str]) -> Job:
    """Start an HTTP relay download job for one or more direct URLs."""
    job = create_job("http")
    job.total = len(urls)
    _executor.submit(_run_http, job, urls)
    return job


def start_bt(source: str) -> Job:
    """Start a BitTorrent download job for a magnet link or .torrent file path.

    Runs on the dedicated BT executor so it does not occupy a yt-dlp/HTTP slot.
    """
    job = create_job("bt")
    job.total = 1
    _bt_executor.submit(_run_bt, job, source)
    return job


def start_bt_with_job(job: Job, source: str) -> Job:
    """Submit an already-created BT job (used by the .torrent upload route, which
    creates the job first to obtain a temp dir for the uploaded file).

    Sets the total and submits _run_bt on the dedicated BT executor.
    """
    job.total = 1
    _bt_executor.submit(_run_bt, job, source)
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


def _run_single(job: Job, url: str, quality: str, kind: str = "youtube", site: str = "default"):
    _set(job, status="running", phase="starting")
    d = storage.job_dir(job.id)

    def hook(ev):
        if job.cancel_event.is_set():
            raise JobCancelled()
        st = ev.get("status")
        if st == "downloading":
            total = ev.get("total_bytes") or ev.get("total_bytes_estimate") or 0
            done = ev.get("downloaded_bytes", 0)
            pct = (done / total * 99.0) if total else job.progress
            kw = {"progress": max(job.progress, pct), "phase": "downloading"}
            fn = ev.get("filename")
            if fn:
                kw["title"] = _basename(fn)
            _set(job, **kw)
        elif st == "finished":
            _set(job, progress=max(job.progress, 99.0), phase="processing (merging)")

    try:
        if job.cancel_event.is_set():
            raise JobCancelled()
        info, files = downloader.download_sync(url, quality, d, hook, site)
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
        _record_history(job, kind, url, str(f), name, media_type(str(f)))
    except JobCancelled:
        _set(job, status="cancelled", phase="cancelled")
    except Exception as e:
        if job.cancel_event.is_set():
            _set(job, status="cancelled", phase="cancelled")
        else:
            logger.exception("single download failed for job %s", job.id)
            _set(job, status="error", error=_friendly_error(e), phase="error")


def _run_batch(job: Job, urls: list[str], quality: str, zip_mode: bool, title: str | None = None,
               kind: str = "youtube", site: str = "default"):
    total = len(urls)
    _set(job, status="running", phase="starting", total=total, current=0)
    d = storage.job_dir(job.id)
    saved: list = []  # (path, display_filename)

    try:
        if job.cancel_event.is_set():
            raise JobCancelled()
        for i, url in enumerate(urls):
            if job.cancel_event.is_set():
                raise JobCancelled()
            _set(job, current=i, phase=f"downloading {i + 1}/{total}")
            base = (i / total) * 100.0 if total else 0.0

            def hook(ev, base=base, span=(100.0 / total if total else 100.0)):
                if job.cancel_event.is_set():
                    raise JobCancelled()
                if ev.get("status") == "downloading":
                    t = ev.get("total_bytes") or ev.get("total_bytes_estimate") or 0
                    done = ev.get("downloaded_bytes", 0)
                    sub = (done / t) if t else 0
                    kw = {"progress": min(99.5, base + span * sub)}
                    fn = ev.get("filename")
                    if fn:
                        kw["title"] = _basename(fn)
                    _set(job, **kw)
                elif ev.get("status") == "finished":
                    _set(job, progress=min(99.5, base + span))

            info, files = downloader.download_sync(url, quality, d, hook, site)
            seq = i + 1
            for f in files:
                name = _filename(_safe_base(info.get("title"), f.stem), f.suffix, index=seq)
                saved.append((str(f), name))

        if zip_mode:
            _set(job, phase="packaging zip", progress=99.5)
            zip_name = _filename(_safe_base(title, "playlist"), "zip")
            zip_path = d / zip_name
            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
                for path, name in saved:
                    z.write(path, arcname=name)
            _set(
                job,
                status="done",
                progress=100.0,
                phase="done",
                result_path=str(zip_path),
                result_filename=zip_name,
                files=[],
                download_url=f"/api/files/{job.id}",
            )
            _record_history(
                job, kind, urls[0] if urls else None,
                str(zip_path), zip_name, media_type(str(zip_path)),
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
                    job, kind, None, path, name, media_type(path),
                )
    except JobCancelled:
        _set(job, status="cancelled", phase="cancelled")
    except Exception as e:
        if job.cancel_event.is_set():
            _set(job, status="cancelled", phase="cancelled")
        else:
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
        if job.cancel_event.is_set():
            raise JobCancelled()
        for i, url in enumerate(urls):
            if job.cancel_event.is_set():
                raise JobCancelled()
            _set(job, current=i, phase=f"downloading {i + 1}/{total}")
            base = (i / total) * 100.0 if total else 0.0
            span = (100.0 / total) if total else 100.0

            def hook(ev, base=base, span=span):
                if ev.get("status") == "downloading":
                    t = ev.get("total_bytes") or 0
                    dn = ev.get("downloaded_bytes", 0)
                    sub = (dn / t) if t else 0
                    kw = {"progress": min(99.5, base + span * sub)}
                    fn = ev.get("filename")
                    if fn:
                        kw["title"] = fn
                    _set(job, **kw)
                elif ev.get("status") == "finished":
                    _set(job, progress=min(99.5, base + span))

            name, path, _size, mime = http_dl.download_sync(url, d, hook, cancel_event=job.cancel_event)
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
    except JobCancelled:
        _set(job, status="cancelled", phase="cancelled")
    except Exception as e:
        if job.cancel_event.is_set():
            _set(job, status="cancelled", phase="cancelled")
        else:
            logger.exception("http download failed for job %s", job.id)
            _set(job, status="error", error=_friendly_error(e), phase="error")


def _run_bt(job: Job, source: str):
    """BitTorrent worker. Mirrors _run_http: download_sync emits the same hook
    dict shape, so the hook closure is reused. The torrent is stopped (no seeding)
    the instant it finishes; files are kept on disk for serving.

    Single-file torrent -> direct download_url (mirrors _run_single / _run_http
    single-URL path). Multi-file -> indexed /api/files/<id>/<i> list via
    snapshot() (mirrors _run_http batch path). History kind="bt".
    """
    _set(job, status="running", phase="connecting to swarm", total=1, current=0)
    d = storage.job_dir(job.id)

    def hook(ev):
        st = ev.get("status")
        if st == "downloading":
            t = ev.get("total_bytes") or 0
            dn = ev.get("downloaded_bytes", 0)
            sub = (dn / t) if t else 0
            kw = {"progress": min(99.5, sub * 100.0), "phase": "downloading"}
            fn = ev.get("filename")
            if fn:
                kw["title"] = fn
            _set(job, **kw)
        elif st == "finished":
            _set(job, progress=99.5, phase="finishing")
        elif st == "paused":
            _set(job, status="paused", phase="paused")
        elif st == "resumed":
            _set(job, status="running", phase="downloading")

    try:
        if job.cancel_event.is_set():
            raise JobCancelled()
        name, path, size, mime = bt_dl.download_sync(
            source, d, hook,
            cancel_event=job.cancel_event, pause_event=job.pause_event,
        )

        if path.is_file():
            # Single-file torrent: serve directly.
            _set(
                job,
                status="done",
                progress=100.0,
                phase="done",
                title=name,
                result_path=str(path),
                result_filename=name,
                files=[(str(path), name)],
                download_url=f"/api/files/{job.id}",
            )
            _record_history(job, "bt", source, str(path), name, mime)
        else:
            # Multi-file torrent: scan the folder into an indexed file list.
            saved: list = []
            for fp in sorted(p for p in path.rglob("*") if p.is_file()):
                saved.append((str(fp), fp.name))
            if not saved:
                # libtorrent reported multi-file but produced nothing scannable;
                # fall back to whatever is directly in the job dir.
                saved = [(str(p), p.name) for p in sorted(d.iterdir()) if p.is_file()]
            if not saved:
                raise RuntimeError("Download finished but no output files were produced.")
            _set(
                job,
                status="done",
                progress=100.0,
                phase="done",
                title=name,
                files=saved,
                result_path=None,
                result_filename=None,
                download_url=None,
            )
            for fp_str, fname in saved:
                _record_history(job, "bt", source, fp_str, fname, media_type(fp_str))
    except JobCancelled:
        _set(job, status="cancelled", phase="cancelled")
    except Exception as e:
        if job.cancel_event.is_set():
            _set(job, status="cancelled", phase="cancelled")
        else:
            logger.exception("bt download failed for job %s", job.id)
            _set(job, status="error", error=_friendly_error(e), phase="error")
