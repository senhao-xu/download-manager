"""Persistent, user-editable settings (cookies + proxy + JS runtime).

Stored on disk so they survive restarts and can be edited from the web UI:
  <data_dir>/settings.json  -> {proxy, js_runtimes}
  <data_dir>/cookies.txt    -> Netscape cookies.txt pasted by the user

effective_opts() merges UI settings over env-var fallbacks to produce the
yt-dlp options used for every request.
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


def _js_runtimes_opt(value: str) -> dict:
    # yt-dlp expects {runtime: config-dict}; the value MUST be a dict (not None),
    # because YoutubeDL._js_runtimes does config.get('path').
    runtimes = [r.strip().lower() for r in (value or "node").split(",") if r.strip()]
    return {r: {} for r in runtimes if r in _ALLOWED_RUNTIMES} or {"node": {}}


def effective_opts() -> dict:
    """yt-dlp opts derived from UI settings (over env fallbacks)."""
    s = load()
    opts: dict = {"js_runtimes": _js_runtimes_opt(s.get("js_runtimes", "node"))}

    # cookies: UI-saved file takes precedence over env YTDLP_COOKIEFILE
    if has_cookies():
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
    }
