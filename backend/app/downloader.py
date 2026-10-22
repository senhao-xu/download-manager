"""yt-dlp wrapper.

All yt-dlp calls are synchronous and blocking; the public async functions run
them in the default threadpool via run_blocking(). Never call YoutubeDL on the
event loop.
"""
import asyncio
import functools
import logging
import re
import threading
from pathlib import Path
from urllib.parse import unquote, urlparse, urlunparse

from yt_dlp import YoutubeDL
from yt_dlp.postprocessor.common import PostProcessor
from yt_dlp.utils import DownloadError

from .schemas import Entry, Format, InfoResponse
from .config import settings as cfg
from .settings import effective_opts
from .thumbnails import source_candidates, thumbnail_url, youtube_video_id
from .video_dl import VideoYoutubeDL

logger = logging.getLogger("downloader")

MEDIA_EXTS = {".mp4", ".webm", ".mkv", ".m4a", ".mp3", ".ogg", ".opus", ".mov", ".avi"}


async def run_blocking(fn, *args, **kwargs):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, functools.partial(fn, *args, **kwargs))


def _base_opts(extra: dict | None = None, site: str = "default") -> dict:
    # Start from user settings (cookies / proxy / js_runtimes), then app defaults.
    # site="bilibili" makes effective_opts pick the Bilibili cookie file.
    opts: dict = {
        **effective_opts(site=site),
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "logger": logger,
        "merge_output_format": "mp4",
        "ignoreerrors": False,
        "concurrent_fragment_downloads": cfg.video_connections,
        # The Python API defaults to zero retries (unlike the yt-dlp CLI).
        # Resume interrupted HTTP streams and retry transient fragment errors.
        "retries": 5,
        "fragment_retries": 5,
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


def _https_thumbnail(url: str | None) -> str | None:
    # Some extractors (Bilibili) return http:// cover URLs. Serving them from an
    # https page gets blocked as mixed content, so upgrade to https where the
    # CDN supports it (Bilibili's i*.hdslb.com does).
    if url and url.startswith("//"):
        return "https:" + url
    if url and url.startswith("http://"):
        return "https://" + url[len("http://"):]
    return url


def thumbnail_candidates(info: dict) -> list[str]:
    alternatives = [t["url"] for t in reversed(info.get("thumbnails") or []) if t.get("url")]
    # yt-dlp may prefer a localized /vi_lc/ cover which the CDN no longer
    # serves. Keep that preference, then try standard covers before variants.
    def standard_youtube_cover(url):
        parsed = urlparse(_https_thumbnail(url))
        return (parsed.hostname or "").endswith(".ytimg.com") and parsed.path.startswith("/vi/")

    alternatives.sort(key=lambda url: not standard_youtube_cover(url))
    candidates = []
    for url in [info.get("thumbnail"), *(info.get("thumbnail_candidates") or []), *alternatives]:
        if not url:
            continue
        source = thumbnail_url(_https_thumbnail(url))
        if source not in candidates:
            candidates.append(source)
    if not candidates:
        for entry in info.get("entries") or []:
            if entry:
                candidates = thumbnail_candidates(entry)
                if candidates:
                    break
    return candidates[:12]


def _normalize_info(info: dict) -> InfoResponse:
    if info.get("_type") == "playlist":
        raw_entries = list(info.get("entries") or [])
        covers = thumbnail_candidates({**info, "entries": raw_entries})
        entries = []
        for e in raw_entries:
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
            thumbnail=covers[0] if covers else None,
            thumbnail_candidates=covers,
            entries=entries,
        )
    formats = [
        Format(
            format_id=f.get("format_id"),
            format_note=f.get("format_note"),
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
    covers = thumbnail_candidates(info)
    return InfoResponse(
        is_playlist=False,
        title=info.get("title"),
        thumbnail=covers[0] if covers else None,
        thumbnail_candidates=covers,
        duration=int(dur) if dur else None,
        qualities=heights[:8],
        formats=formats,
    )


def channel_url(url: str) -> str | None:
    """Channel landing pages resolve to uploads; explicit video tabs stay put."""
    try:
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or parsed.hostname not in {
            "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
        }:
            return None
        match = re.fullmatch(
            r"/(@[^/]+|(?:channel|user|c)/[^/]+)(?:/(videos|shorts|streams|featured))?/?",
            unquote(parsed.path),
        )
        if not match:
            return None
        tab = match[2] if match[2] not in {None, "featured"} else "videos"
        return urlunparse(("https", "www.youtube.com", f"/{match[1]}/{tab}", "", parsed.query, ""))
    except ValueError:
        return None


def _normalize_channel(info: dict, page: int, page_size: int) -> InfoResponse:
    # yt-dlp's range is bounded to this page plus one look-ahead entry.
    raw_entries = list(info.get("entries") or [])
    entries = []
    for raw in raw_entries[:page_size]:
        if not raw:
            continue
        video_id = youtube_video_id(raw.get("webpage_url") or raw.get("url"))
        if not video_id and re.fullmatch(r"[\w-]{11}", str(raw.get("id", "")), re.ASCII):
            video_id = raw["id"]
        if not video_id:
            continue
        url = f"https://www.youtube.com/watch?v={video_id}"
        covers = thumbnail_candidates(raw) or source_candidates(url)
        entries.append(Entry(
            id=video_id, url=url, title=raw.get("title"),
            duration=int(raw["duration"]) if raw.get("duration") else None,
            thumbnail=covers[0] if covers else None, thumbnail_candidates=covers,
        ))
    covers = thumbnail_candidates(info)
    if entries:
        covers = list(dict.fromkeys([*covers, *entries[0].thumbnail_candidates]))[:12]
    return InfoResponse(
        is_playlist=True, is_channel=True, title=info.get("title"),
        thumbnail=covers[0] if covers else None, thumbnail_candidates=covers,
        entries=entries, page=page, page_size=page_size, has_more=len(raw_entries) > page_size,
        qualities=[4320, 2160, 1440, 1080, 720, 480, 360],
    )


def extract_info_sync(url: str, site: str = "default", *, page: int = 1, page_size: int = 20) -> InfoResponse:
    channel = channel_url(url) if site == "default" else None
    extra = {"extract_flat": False}
    if channel:
        start = (page - 1) * page_size + 1
        extra.update(extract_flat="in_playlist", playliststart=start, playlistend=start + page_size)
    with YoutubeDL(_base_opts(extra, site=site)) as ydl:
        info = ydl.extract_info(channel or url, download=False)
    if info is None:
        raise DownloadError("No information could be extracted from that URL.")
    if channel:
        return _normalize_channel(info, page, page_size)
    return _normalize_info(info)


async def extract_info(url: str, site: str = "default", *, page: int = 1, page_size: int = 20) -> InfoResponse:
    return await run_blocking(extract_info_sync, url, site, page=page, page_size=page_size)


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


class _TransferMetadataPP(PostProcessor):
    """Report selected stream sizes before yt-dlp starts either stream."""
    def __init__(self, progress_hook):
        super().__init__()
        self.progress_hook = progress_hook

    def run(self, info):
        self.progress_hook({"status": "metadata", "info_dict": info})
        return [], info


def download_sync(url: str, quality: str, dest_dir: Path, progress_hook,
                  site: str = "default") -> tuple[dict, list[Path]]:
    """Download one video; returns (info_dict, [newly-created file paths]).

    Uses a before/after diff of the dest dir so that batch downloads (which share
    one dir) only report this video's file, not files from earlier videos.
    ``site="bilibili"`` selects Bilibili-specific cookies (see settings.py).
    """
    fmt = format_for_quality(quality)
    progress_lock = threading.Lock()

    def report(event):
        # Native fragment workers may invoke hooks from different threads.
        with progress_lock:
            progress_hook(event)

    opts = _base_opts({
        "format": fmt,
        "outtmpl": str(dest_dir / "%(id)s.%(ext)s"),
        "progress_hooks": [report],
    }, site=site)
    before = {p.name for p in dest_dir.iterdir()} if dest_dir.is_dir() else set()
    with VideoYoutubeDL(opts) as ydl:
        ydl.add_post_processor(_TransferMetadataPP(report), when="before_dl")
        info = ydl.extract_info(url, download=True)
    files = _new_files(dest_dir, before)
    if not files:
        raise DownloadError("Download finished but no output file was produced.")
    return info, files


async def download(url: str, quality: str, dest_dir: Path, progress_hook):
    return await run_blocking(download_sync, url, quality, dest_dir, progress_hook)
