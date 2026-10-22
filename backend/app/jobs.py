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
from . import downloader, history, http_dl, bt_dl, storage, thumbnails
from .errors import JobCancelled
from .schemas import JobStatus
from .progress import TransferProgress
from .storage import media_type

logger = logging.getLogger("jobs")


@dataclass
class Job:
    id: str
    kind: str | None = None  # "youtube" | "http" | "bt" | "bilibili"
    status: str = "queued"  # queued | running | done | error
    progress: float = 0.0
    downloaded_bytes: int = 0
    total_bytes: int | None = None
    total_bytes_estimated: bool = False
    speed: float | None = None
    eta: float | None = None
    current: int | None = None
    total: int | None = None
    phase: str | None = None
    title: str | None = None
    source: str | None = None
    thumbnail: str | None = None
    thumbnail_candidates: list[str] = field(default_factory=list)
    resolution: str | None = None
    fps: float | None = None
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
            downloaded_bytes=job.downloaded_bytes,
            total_bytes=job.total_bytes,
            total_bytes_estimated=job.total_bytes_estimated,
            speed=job.speed,
            eta=job.eta,
            current=job.current,
            total=job.total,
            phase=job.phase,
            title=job.title,
            thumbnail=job.thumbnail,
            thumbnail_candidates=list(job.thumbnail_candidates),
            resolution=job.resolution,
            fps=job.fps,
            error=job.error,
            download_url=urls[0] if urls else None,
            download_urls=urls,
            kind=job.kind,
            source=job.source,
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
    _set(job, source=url)
    _executor.submit(_run_single, job, url, quality, "youtube", "default")
    return job


def queue_videos(entries, quality: str, skip_downloaded: bool = True) -> tuple[list[Job], int, int]:
    prepared = []
    for entry in entries:
        video_id = thumbnails.youtube_video_id(entry.url)
        if not video_id:
            raise ValueError("Select individual YouTube video links to add to the queue.")
        prepared.append((video_id, entry.title, f"https://www.youtube.com/watch?v={video_id}"))
    available = history.available_video_ids() if skip_downloaded else set()
    created = []
    skipped_downloaded = skipped_active = 0
    # Reserve every ID before submitting workers, atomically across requests.
    with _lock:
        active = set()
        for job in _jobs.values():
            video_id = thumbnails.youtube_video_id(job.source) if job.kind == "youtube" else None
            if video_id and job.status in {"queued", "running", "paused"}:
                active.add(video_id)
            elif (video_id and skip_downloaded and job.status == "done"
                  and job.result_path and Path(job.result_path).is_file()):
                # A worker can finish just before its history record is written.
                available.add(video_id)
        for video_id, title, url in prepared:
            if video_id in available:
                skipped_downloaded += 1
                continue
            if video_id in active:
                skipped_active += 1
                continue
            covers = thumbnails.source_candidates(url)
            job = Job(id=uuid.uuid4().hex[:12], kind="youtube", source=url, title=title,
                      thumbnail=covers[0] if covers else None, thumbnail_candidates=covers)
            _jobs[job.id] = job
            created.append(job)
            active.add(video_id)
    for job in created:
        _executor.submit(_run_single, job, job.source, quality, "youtube", "default")
    return created, skipped_downloaded, skipped_active


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
    if kw.get("status") in ("done", "error", "cancelled", "paused"):
        kw.update(speed=None, eta=None)
    with _lock:
        for k, v in kw.items():
            setattr(job, k, v)
        job.updated = time.time()


def _completed_bytes(paths) -> dict:
    size = sum(Path(path).stat().st_size for path in paths)
    return {"downloaded_bytes": size, "total_bytes": size, "total_bytes_estimated": False}


def _video_metadata(info: dict) -> dict:
    covers = downloader.thumbnail_candidates(info)
    # Use the selected stream, not the full format catalogue or requested tier.
    video = next((fmt for fmt in (info.get("requested_formats") or [info])
                  if fmt.get("height")), {})
    width, height = video.get("width"), video.get("height")
    resolution = f"{width}x{height}" if width and height else f"{height}p" if height else None
    return {"thumbnail": covers[0] if covers else None, "thumbnail_candidates": covers,
            "resolution": resolution, "fps": video.get("fps") if height else None}


def _record_history(job: Job, kind: str, source: str | None,
                    path: str, filename: str, mime: str | None,
                    metadata: dict | None = None) -> None:
    """Append a history record for one completed file.

    Failure to record is logged but never re-raised: a history write must not
    break a download. `mime` is derived via `storage.media_type(path)`.
    """
    try:
        sz = Path(path).stat().st_size
    except OSError:
        sz = None
    metadata = metadata or {}
    try:
        history.append({
            "id": job.id,
            "kind": kind,
            "title": metadata.get("title") or job.title,
            "thumbnail": metadata.get("thumbnail", job.thumbnail),
            "thumbnail_candidates": metadata.get("thumbnail_candidates", job.thumbnail_candidates),
            "resolution": metadata.get("resolution", job.resolution),
            "fps": metadata.get("fps", job.fps),
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
    transfer = TransferProgress()

    def hook(ev):
        if job.cancel_event.is_set():
            raise JobCancelled()
        st = ev.get("status")
        if st in ("metadata", "downloading", "finished"):
            metrics = transfer.update(ev)
            phase = "processing (merging)" if transfer.finished else "downloading"
            kw = {**metrics, "progress": transfer.fraction * 99.0, "phase": phase}
            if st == "metadata":
                kw.update(_video_metadata(ev.get("info_dict") or {}))
            title = (ev.get("info_dict") or {}).get("title")
            fn = ev.get("filename")
            if title or fn:
                kw["title"] = title or _basename(fn)
            _set(job, **kw)

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
            **_completed_bytes([f]),
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
    saved_metadata: dict[str, dict] = {}

    try:
        if job.cancel_event.is_set():
            raise JobCancelled()
        for i, url in enumerate(urls):
            if job.cancel_event.is_set():
                raise JobCancelled()
            _set(job, current=i, phase=f"downloading {i + 1}/{total}",
                 downloaded_bytes=0, total_bytes=None, total_bytes_estimated=False, speed=None, eta=None)
            transfer = TransferProgress()
            base = (i / total) * 100.0 if total else 0.0

            def hook(ev, base=base, span=(100.0 / total if total else 100.0)):
                if job.cancel_event.is_set():
                    raise JobCancelled()
                if ev.get("status") in ("metadata", "downloading", "finished"):
                    metrics = transfer.update(ev)
                    kw = {**metrics, "progress": min(99.5, base + span * transfer.fraction)}
                    if ev.get("status") == "metadata":
                        kw.update(_video_metadata(ev.get("info_dict") or {}))
                    title = (ev.get("info_dict") or {}).get("title")
                    fn = ev.get("filename")
                    if title or fn:
                        kw["title"] = title or _basename(fn)
                    if transfer.finished:
                        kw["phase"] = "processing (merging)"
                    _set(job, **kw)

            info, files = downloader.download_sync(url, quality, d, hook, site)
            seq = i + 1
            for f in files:
                name = _filename(_safe_base(info.get("title"), f.stem), f.suffix, index=seq)
                saved.append((str(f), name))
                saved_metadata[str(f)] = {"title": info.get("title"), "source": url, **_video_metadata(info)}

        if zip_mode:
            _set(job, phase="packaging zip", progress=99.5, speed=None, eta=None)
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
                **_completed_bytes([zip_path]),
            )
            first = saved_metadata.get(saved[0][0], {}) if saved else {}
            _record_history(
                job, kind, urls[0] if urls else None,
                str(zip_path), zip_name, media_type(str(zip_path)),
                metadata={"thumbnail": first.get("thumbnail"),
                          "thumbnail_candidates": first.get("thumbnail_candidates", []),
                          "resolution": None, "fps": None},
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
                **_completed_bytes(path for path, _ in saved),
            )
            for path, name in saved:
                _record_history(
                    job, kind, saved_metadata[path]["source"], path, name, media_type(path),
                    metadata=saved_metadata[path],
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
            _set(job, current=i, phase=f"downloading {i + 1}/{total}",
                 downloaded_bytes=0, total_bytes=None, total_bytes_estimated=False, speed=None, eta=None)
            transfer = TransferProgress()
            base = (i / total) * 100.0 if total else 0.0
            span = (100.0 / total) if total else 100.0

            def hook(ev, base=base, span=span):
                if ev.get("status") in ("downloading", "finished"):
                    metrics = transfer.update(ev)
                    kw = {**metrics, "progress": min(99.5, base + span * transfer.fraction)}
                    fn = ev.get("filename")
                    if fn:
                        kw["title"] = fn
                    _set(job, **kw)

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
            **_completed_bytes(path for path, _ in saved),
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
    transfer = TransferProgress()

    def hook(ev):
        st = ev.get("status")
        if st in ("downloading", "finished"):
            metrics = transfer.update(ev)
            kw = {**metrics, "progress": min(99.5, transfer.fraction * 100.0),
                  "phase": "finishing" if st == "finished" else "downloading"}
            fn = ev.get("filename")
            if fn:
                kw["title"] = fn
            _set(job, **kw)
        elif st == "paused":
            _set(job, status="paused", phase="paused")
        elif st == "resumed":
            _set(job, status="running", phase="downloading", speed=None, eta=None)

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
                **_completed_bytes([path]),
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
                **_completed_bytes(fp for fp, _ in saved),
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
