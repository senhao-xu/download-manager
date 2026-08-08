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
