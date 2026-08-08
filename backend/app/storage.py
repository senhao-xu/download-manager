"""Per-job temp directory management + TTL cleanup."""
import logging
import shutil
import threading
import time

from .config import settings

logger = logging.getLogger("storage")


def job_dir(job_id: str):
    d = settings.download_dir / job_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def media_type(path: str) -> str:
    """Content-Type for a downloaded file by extension.

    Shared by the file-serving routes and the history recorder (which stores
    the mime alongside the path so the frontend can pick a preview element).
    """
    p = path.lower()
    if p.endswith(".zip"):
        return "application/zip"
    if p.endswith(".mp4"):
        return "video/mp4"
    if p.endswith(".webm"):
        return "video/webm"
    if p.endswith(".mkv"):
        return "video/x-matroska"
    if p.endswith(".mov"):
        return "video/quicktime"
    if p.endswith(".m4a"):
        return "audio/mp4"
    if p.endswith(".mp3"):
        return "audio/mpeg"
    if p.endswith(".ogg"):
        return "audio/ogg"
    if p.endswith(".opus"):
        return "audio/opus"
    return "application/octet-stream"


def cleanup_expired():
    """Remove job dirs older than TTL_MINUTES. Safe to run on a background thread."""
    now = time.time()
    ttl = settings.ttl_minutes * 60
    for d in settings.download_dir.iterdir():
        if not d.is_dir():
            continue
        try:
            age = now - d.stat().st_mtime
        except OSError:
            continue
        if age > ttl:
            shutil.rmtree(d, ignore_errors=True)
            logger.info("cleaned up expired job dir %s", d)


def start_cleanup_thread():
    interval = max(60, settings.ttl_minutes * 60 // 2)

    def loop():
        while True:
            time.sleep(interval)
            try:
                cleanup_expired()
            except Exception:  # never let the sweep thread die
                logger.exception("cleanup sweep failed")

    t = threading.Thread(target=loop, daemon=True, name="ttl-cleanup")
    t.start()
    return t
