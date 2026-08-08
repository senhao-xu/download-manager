"""yt-dlp wrapper.

All yt-dlp calls are synchronous and blocking; the public async functions run
them in the default threadpool via run_blocking(). Never call YoutubeDL on the
event loop.
"""
import asyncio
import functools
import logging
import re
from pathlib import Path

from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError

from .schemas import Entry, Format, InfoResponse
from .settings import effective_opts

logger = logging.getLogger("downloader")

MEDIA_EXTS = {".mp4", ".webm", ".mkv", ".m4a", ".mp3", ".ogg", ".opus", ".mov", ".avi"}


async def run_blocking(fn, *args, **kwargs):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, functools.partial(fn, *args, **kwargs))


def _base_opts(extra: dict | None = None) -> dict:
    # Start from user settings (cookies / proxy / js_runtimes), then app defaults.
    opts: dict = {
        **effective_opts(),
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "logger": logger,
        "merge_output_format": "mp4",
        "ignoreerrors": False,
    }
    if extra:
        opts.update(extra)
    return opts


def _resolution(f: dict) -> str | None:
    w, h = f.get("width"), f.get("height")
    if w and h:
        return f"{w}x{h}"
    if h:
        return f"{h}p"
    return None


def _normalize_info(info: dict) -> InfoResponse:
    if info.get("_type") == "playlist":
        entries = []
        for e in info.get("entries") or []:
            if not e:
                continue
            entries.append(
                Entry(
                    id=e.get("id"),
                    url=e.get("webpage_url") or e.get("url"),
                    title=e.get("title"),
                    duration=int(e["duration"]) if e.get("duration") else None,
                )
            )
        return InfoResponse(
            is_playlist=True,
            title=info.get("title"),
            entries=entries,
        )
    formats = [
        Format(
            format_id=f.get("format_id"),
            ext=f.get("ext"),
            resolution=_resolution(f),
            fps=f.get("fps"),
            vcodec=f.get("vcodec"),
            acodec=f.get("acodec"),
            filesize=f.get("filesize") or f.get("filesize_approx"),
        )
        for f in (info.get("formats") or [])
    ]
    # distinct video heights with a video stream, descending
    heights = sorted(
        {f["height"] for f in (info.get("formats") or [])
         if f.get("height") and f.get("vcodec") and f.get("vcodec") != "none"},
        reverse=True,
    )
    dur = info.get("duration")
    return InfoResponse(
        is_playlist=False,
        title=info.get("title"),
        thumbnail=info.get("thumbnail"),
        duration=int(dur) if dur else None,
        qualities=heights[:8],
        formats=formats,
    )


def extract_info_sync(url: str) -> InfoResponse:
    with YoutubeDL(_base_opts({"extract_flat": False})) as ydl:
        info = ydl.extract_info(url, download=False)
    if info is None:
        raise DownloadError("No information could be extracted from that URL.")
    return _normalize_info(info)


async def extract_info(url: str) -> InfoResponse:
    return await run_blocking(extract_info_sync, url)


def format_for_quality(quality: str) -> str:
    """Map a quality token to a yt-dlp format selector string."""
    q = (quality or "best").strip().lower()
    if q in ("", "best"):
        return "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"
    if q == "audio":
        # deferred from v1 scope but supported if requested
        return "bestaudio/best"
    # numeric height, e.g. "1080"
    if re.fullmatch(r"\d+", q):
        return (
            f"bestvideo[height<={q}][ext=mp4]+bestaudio[ext=m4a]/"
            f"best[height<={q}][ext=mp4]/best[height<={q}]/best"
        )
    # treat as a raw format_id
    return q


def _new_files(dest_dir: Path, before: set[str]) -> list[Path]:
    """Media files added since `before` (snapshot of filenames before download)."""
    new = [
        p for p in dest_dir.iterdir()
        if p.name not in before and p.is_file()
        and p.suffix.lower() in MEDIA_EXTS and not p.name.endswith(".part")
    ]
    new.sort(key=lambda p: p.name)
    return new


def download_sync(url: str, quality: str, dest_dir: Path, progress_hook) -> tuple[dict, list[Path]]:
    """Download one video; returns (info_dict, [newly-created file paths]).

    Uses a before/after diff of the dest dir so that batch downloads (which share
    one dir) only report this video's file, not files from earlier videos.
    """
    fmt = format_for_quality(quality)
    opts = _base_opts({
        "format": fmt,
        "outtmpl": str(dest_dir / "%(id)s.%(ext)s"),
        "progress_hooks": [progress_hook],
    })
    before = {p.name for p in dest_dir.iterdir()} if dest_dir.is_dir() else set()
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
    files = _new_files(dest_dir, before)
    if not files:
        raise DownloadError("Download finished but no output file was produced.")
    return info, files


async def download(url: str, quality: str, dest_dir: Path, progress_hook):
    return await run_blocking(download_sync, url, quality, dest_dir, progress_hook)
