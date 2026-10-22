"""Fetch supported cover images through the server's configured connection."""
import re
from urllib.parse import parse_qs, urlencode, urlparse

from curl_cffi import requests

from .config import settings
from .settings import effective_opts

_MAX_BYTES = 5 * 1024 * 1024
_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"}


def _allowed(url: str) -> bool:
    try:
        parsed = urlparse(url)
        host = parsed.hostname or ""
        return (
            parsed.scheme == "https" and parsed.port in (None, 443)
            and not parsed.username and not parsed.password
            and (host == "img.youtube.com" or any(host.endswith(suffix) for suffix in (
                ".ytimg.com", ".hdslb.com", ".biliimg.com",
            )))
        )
    except ValueError:
        return False


def thumbnail_url(url: str) -> str:
    # Other extractors retain their original cover URLs; this endpoint is
    # deliberately restricted to the image CDNs of the two supported sites.
    return "/api/thumbnail?" + urlencode({"url": url}) if _allowed(url) else url


def youtube_video_id(source: str | None) -> str | None:
    """Identify a video across watch, short-link, Shorts and embed URLs."""
    if not source:
        return None
    try:
        parsed = urlparse(source)
        host = (parsed.hostname or "").lower()
        parts = parsed.path.strip("/").split("/")
        video_id = ""
        if host == "youtu.be":
            video_id = parts[0]
        elif host in {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
                      "www.youtube-nocookie.com"}:
            if parsed.path == "/watch":
                video_id = parse_qs(parsed.query).get("v", [""])[0]
            elif len(parts) > 1 and parts[0] in {"shorts", "embed", "live"}:
                video_id = parts[1]
        if parsed.scheme not in {"http", "https"} or not re.fullmatch(r"[\w-]{11}", video_id, re.ASCII):
            return None
        return video_id
    except ValueError:
        return None


def source_candidates(source: str | None) -> list[str]:
    """Recover covers for old YouTube history without re-extracting videos."""
    video_id = youtube_video_id(source)
    return [thumbnail_url(f"https://i.ytimg.com/vi/{video_id}/{size}.jpg")
            for size in ("mqdefault", "hqdefault")] if video_id else []


def fetch_thumbnail(url: str) -> tuple[bytes, str]:
    if not _allowed(url):
        raise ValueError("Unsupported thumbnail URL.")
    host = urlparse(url).hostname or ""
    referer = "https://www.youtube.com/" if host.endswith(".ytimg.com") or host == "img.youtube.com" else "https://www.bilibili.com/"
    response = requests.get(
        url, stream=True, allow_redirects=False, timeout=(5, 15),
        headers={"Referer": referer},
        proxy=effective_opts().get("proxy") or None,
        impersonate=settings.impersonate,
    )
    try:
        mime = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if response.status_code != 200 or mime not in _IMAGE_TYPES:
            raise RuntimeError("Cover image is unavailable.")
        content = bytearray()
        for chunk in response.iter_content(64 * 1024):
            content.extend(chunk)
            if len(content) > _MAX_BYTES:
                raise RuntimeError("Cover image exceeds the size limit.")
        if not content:
            raise RuntimeError("Cover image is empty.")
        return bytes(content), mime
    finally:
        response.close()
