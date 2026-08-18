"""Persistent, user-editable settings (cookies + proxy + JS runtime).

Stored on disk so they survive restarts and can be edited from the web UI:
  <data_dir>/settings.json            -> {proxy, js_runtimes}
  <data_dir>/cookies.txt              -> global Netscape cookies.txt (pasted by user)
  <data_dir>/bilibili_cookies.txt     -> Bilibili-specific cookies (SESSDATA etc.)

effective_opts() merges UI settings over env-var fallbacks to produce the
yt-dlp options used for every request. Passing ``site="bilibili"`` prefers the
Bilibili-specific cookie file so a user can log in to bilibili.com without
mixing its cookies into the global file used for every other site.
"""
import json
import threading
from pathlib import Path

from .config import settings as cfg

_lock = threading.Lock()
_cache: dict | None = None

_DEFAULTS = {"proxy": "", "js_runtimes": "node"}
# JS runtimes we allow the user to pick. deno 2.x is often "unsupported" by
# yt-dlp-ejs, so node is the safe default.
_ALLOWED_RUNTIMES = {"node", "deno", "bun"}


def _settings_path() -> Path:
    return cfg.data_dir / "settings.json"


def _cookies_path() -> Path:
    return cfg.data_dir / "cookies.txt"


def _bilibili_cookies_path() -> Path:
    return cfg.data_dir / "bilibili_cookies.txt"


def load() -> dict:
    global _cache
    with _lock:
        if _cache is None:
            try:
                _cache = json.loads(_settings_path().read_text("utf-8"))
                if not isinstance(_cache, dict):
                    _cache = {}
            except (FileNotFoundError, json.JSONDecodeError):
                _cache = {}
        return {**_DEFAULTS, **_cache}


def save(data: dict) -> dict:
    global _cache
    proxy = str(data.get("proxy", "") or "").strip()[:500]
    jr = str(data.get("js_runtimes", "node") or "node").strip().lower()
    if jr not in _ALLOWED_RUNTIMES:
        jr = "node"
    with _lock:
        _cache = {"proxy": proxy, "js_runtimes": jr}
        cfg.data_dir.mkdir(parents=True, exist_ok=True)
        _settings_path().write_text(json.dumps(_cache), "utf-8")
        return dict(_cache)


def save_cookies(content: str) -> None:
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    _cookies_path().write_text(content, "utf-8")


def has_cookies() -> bool:
    p = _cookies_path()
    try:
        return p.exists() and p.stat().st_size > 0
    except OSError:
        return False


def clear_cookies() -> None:
    try:
        _cookies_path().unlink()
    except FileNotFoundError:
        pass


def save_bilibili_cookies(content: str) -> None:
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    _bilibili_cookies_path().write_text(content, "utf-8")


def has_bilibili_cookies() -> bool:
    p = _bilibili_cookies_path()
    try:
        return p.exists() and p.stat().st_size > 0
    except OSError:
        return False


def clear_bilibili_cookies() -> None:
    try:
        _bilibili_cookies_path().unlink()
    except FileNotFoundError:
        pass


def _js_runtimes_opt(value: str) -> dict:
    # yt-dlp expects {runtime: config-dict}; the value MUST be a dict (not None),
    # because YoutubeDL._js_runtimes does config.get('path').
    runtimes = [r.strip().lower() for r in (value or "node").split(",") if r.strip()]
    return {r: {} for r in runtimes if r in _ALLOWED_RUNTIMES} or {"node": {}}


def effective_opts(site: str = "default") -> dict:
    """yt-dlp opts derived from UI settings (over env fallbacks).

    ``site="bilibili"`` prefers the Bilibili-specific cookie file so a user can
    log in to bilibili.com (SESSDATA) for high quality / member content. Falls
    back to the global cookie file (which may already contain bilibili.com),
    then env-var fallbacks.
    """
    s = load()
    opts: dict = {"js_runtimes": _js_runtimes_opt(s.get("js_runtimes", "node"))}

    # cookies: site-specific UI file > global UI file > env fallback
    if site == "bilibili":
        if has_bilibili_cookies():
            opts["cookiefile"] = str(_bilibili_cookies_path())
        elif has_cookies():
            opts["cookiefile"] = str(_cookies_path())
        elif cfg.bilibili_cookiefile or cfg.cookiefile:
            opts["cookiefile"] = cfg.bilibili_cookiefile or cfg.cookiefile
    elif has_cookies():
        opts["cookiefile"] = str(_cookies_path())
    elif cfg.cookiefile:
        opts["cookiefile"] = cfg.cookiefile

    # proxy: UI setting takes precedence over env YTDLP_PROXY
    proxy = s.get("proxy") or cfg.proxy
    if proxy:
        opts["proxy"] = proxy

    if cfg.impersonate:
        opts["impersonate"] = cfg.impersonate
    if cfg.sleep_interval:
        opts["sleep_interval"] = cfg.sleep_interval
        opts["max_sleep_interval"] = cfg.sleep_interval
    return opts


def public_state() -> dict:
    """What the UI sees: no raw cookie content, just whether it's configured."""
    s = load()
    return {
        "proxy": s.get("proxy", ""),
        "js_runtimes": s.get("js_runtimes", "node"),
        "cookies_configured": has_cookies(),
        "cookiefile_env": bool(cfg.cookiefile),
        "bilibili_cookies_configured": has_bilibili_cookies(),
        "bilibili_cookiefile_env": bool(cfg.bilibili_cookiefile),
    }
