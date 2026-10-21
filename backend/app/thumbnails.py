"""Fetch supported cover images through the server's configured connection."""
from urllib.parse import urlencode, urlparse

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
