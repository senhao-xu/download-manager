"""HTTP stream-downloader (relay).

Synchronous stream download of one HTTP(S) URL using ``curl_cffi``. The server
acts as a relay: it streams the remote file to disk under the job's temp dir,
reporting byte progress through the same progress-hook shape yt-dlp uses, so
``jobs.py`` translates it to ``job.progress`` unchanged.

This module is blocking (``curl_cffi`` is synchronous). It is always called from
the ``jobs`` ThreadPoolExecutor - never on the event loop.
"""
import logging
import re
from pathlib import Path
from urllib.parse import unquote, urlparse

from curl_cffi import requests as cffi_requests

from .config import settings as cfg
from .errors import JobCancelled
from .settings import effective_opts

logger = logging.getLogger("http_dl")

_CHUNK = 64 * 1024

# Minimal MIME -> extension map for the filename fallback. ``storage.media_type``
# covers the reverse direction; this is only used to name a file when the URL and
# Content-Disposition give no usable extension.
_MIME_EXT = {
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
}


def _proxy() -> str | None:
    """Configured proxy (UI setting takes precedence over env). Empty -> None."""
    p = effective_opts().get("proxy")
    return p or None


def _impersonate() -> str | None:
    """Browser to impersonate (YTDLP_IMPERSONATE), shared with yt-dlp."""
    return cfg.impersonate


def _content_length(headers) -> int | None:
    """Parse ``Content-Length`` -> int, or None if absent/invalid."""
    raw = headers.get("content-length")
    if not raw:
        return None
    try:
        return int(str(raw).strip())
    except (TypeError, ValueError):
        return None


def _ext_from_mime(mime: str | None) -> str:
    """Extension for a MIME type, or "" if unknown."""
    if not mime:
        return ""
    key = mime.split(";")[0].strip().lower()
    return _MIME_EXT.get(key, "")


def _sanitize(name: str) -> str:
    """Keep alnum + `` -_().`` ; strip leading/trailing dots/spaces; fallback."""
    keep = "".join(c for c in name if c.isalnum() or c in " -_().")
    return keep.strip(" .") or "download"


def _filename_from(url: str, resp) -> str:
    """Pick a download filename.

    Order: RFC 5987 ``filename*`` -> ``filename`` -> URL path tail -> "download".
    """
    cd = resp.headers.get("content-disposition")
    if cd:
        # RFC 5987 ext-value: filename*=UTF-8''<pct-encoded>
        m = re.search(r"filename\*=(?:UTF-8'')?([^;]+)", cd, re.I)
        if not m:
            m = re.search(r'filename="?([^";]+)"?', cd, re.I)
        if m:
            return _sanitize(unquote(m.group(1)).strip())

    path = urlparse(url).path
    base = unquote(Path(path).name) if path else ""
    if base:
        return _sanitize(base)
    return "download"


def _unique(dest_dir: Path, name: str) -> str:
    """Append `` (1)``, `` (2)`` ... before the extension to avoid collisions."""
    if not (dest_dir / name).exists():
        return name
    stem = Path(name).stem
    suffix = Path(name).suffix
    i = 1
    while True:
        candidate = f"{stem} ({i}){suffix}"
        if not (dest_dir / candidate).exists():
            return candidate
        i += 1


def download_sync(url: str, dest_dir: Path, progress_hook, cancel_event=None) -> tuple[str, Path, int, str]:
    """Stream-download one URL into ``dest_dir``.

    Returns ``(filename, path, size, mime)``. Raises ``RuntimeError`` on an HTTP
    error status (>=400) or a connection failure, mapped to a friendly message by
    the caller via ``_friendly_error``. Raises ``JobCancelled`` if ``cancel_event``
    is set mid-stream (the existing except block unlinks the partial file).

    ``progress_hook`` receives dicts shaped like yt-dlp's hooks
    (``{"status", "downloaded_bytes", "total_bytes"}``) so the existing
    ``jobs.py`` hook logic works unchanged.
    """
    resp = cffi_requests.get(
        url,
        stream=True,
        impersonate=_impersonate(),
        proxy=_proxy(),
        # Tuple (connect, read). Under stream=True curl_cffi maps this to
        # CONNECTTIMEOUT + a LOW_SPEED_TIME window (connect+read), so a server
        # that connects but then stops sending bytes is aborted rather than
        # hanging the worker. See curl_cffi requests/utils.py.
        timeout=(cfg.http_connect_timeout, cfg.http_stall_timeout),
        allow_redirects=True,
    )
    if resp.status_code >= 400:
        raise RuntimeError(f"HTTP {resp.status_code} for {url}")

    mime = resp.headers.get("content-type")
    total = _content_length(resp.headers)
    name = _filename_from(url, resp)
    if "." not in name:
        ext = _ext_from_mime(mime)
        if ext:
            name += ext
    name = _unique(dest_dir, name)
    path = dest_dir / name

    done = 0
    try:
        with path.open("wb") as f:
            for chunk in resp.iter_content(_CHUNK):
                if cancel_event is not None and cancel_event.is_set():
                    raise JobCancelled()
                if not chunk:
                    continue
                f.write(chunk)
                done += len(chunk)
                progress_hook({
                    "status": "downloading",
                    "downloaded_bytes": done,
                    "total_bytes": total or 0,
                    "filename": name,
                })
    except Exception:
        # Don't leave a partial file behind on failure.
        try:
            path.unlink()
        except OSError:
            pass
        raise
    finally:
        try:
            resp.close()
        except Exception:  # pragma: no cover - defensive
            pass

    progress_hook({"status": "finished"})
    logger.info("http download ok: %s -> %s (%d bytes)", url, path, done)
    return name, path, done, mime or "application/octet-stream"
