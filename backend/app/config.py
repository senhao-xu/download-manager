"""Runtime configuration, all via environment variables.

Settings that the user can change at runtime (cookies, proxy, JS runtime) live
in a persisted settings file managed by app.settings - see app/settings.py.
The env vars here are fallback defaults / one-shot overrides.
"""
import os
from pathlib import Path

_data_dir = Path(os.getenv("DATA_DIR", "./data"))


class Settings:
    data_dir: Path = _data_dir
    # downloads go under <data_dir>/downloads by default
    download_dir: Path = Path(os.getenv("DOWNLOAD_DIR", str(_data_dir / "downloads")))
    ttl_minutes: int = int(os.getenv("TTL_MINUTES", "60"))
    max_concurrent: int = int(os.getenv("MAX_CONCURRENT", "3"))
    port: int = int(os.getenv("PORT", "8000"))

    # yt-dlp network/auth knobs (fallbacks; the settings UI overrides these)
    cookiefile: str | None = os.getenv("YTDLP_COOKIEFILE") or None
    # Bilibili-specific cookie file (SESSDATA etc. for 1080P+/member content).
    # Used by Bilibili downloads when no bilibili_cookies.txt was pasted in the UI.
    bilibili_cookiefile: str | None = os.getenv("YTDLP_BILIBILI_COOKIEFILE") or None
    proxy: str | None = os.getenv("YTDLP_PROXY") or None
    impersonate: str | None = os.getenv("YTDLP_IMPERSONATE") or None
    sleep_interval: float = float(os.getenv("YTDLP_SLEEP_INTERVAL", "0") or 0)

    # BitTorrent: a dedicated worker pool (separate from yt-dlp/HTTP) so long
    # torrents don't block video downloads. BT listens on TCP+UDP for peers/DHT.
    bt_max_concurrent: int = int(os.getenv("BT_MAX_CONCURRENT", "1"))
    bt_listen_port: int = int(os.getenv("BT_LISTEN_PORT", "6881"))
    # How long (s) to wait for the first byte from a magnet before giving up.
    bt_no_data_timeout: int = int(os.getenv("BT_NO_DATA_TIMEOUT", "120"))
    # How long (s) a download may stall (no new bytes) mid-download before
    # giving up. Bounds a torrent whose swarm goes quiet after starting.
    bt_stall_timeout: int = int(os.getenv("BT_STALL_TIMEOUT", "300"))

    # HTTP relay connect/read timeouts (curl_cffi tuple). The read value is also
    # the LOW_SPEED_TIME window (curl aborts if speed stays < 1 B/s this long),
    # so a stalled server can't hang the worker. HTTP_STALL_TIMEOUT overrides the
    # read half only; connect stays short for fast failure on dead hosts.
    http_connect_timeout: float = float(os.getenv("HTTP_CONNECT_TIMEOUT", "15"))
    http_stall_timeout: float = float(os.getenv("HTTP_STALL_TIMEOUT", "60"))


settings = Settings()
settings.data_dir.mkdir(parents=True, exist_ok=True)
settings.download_dir.mkdir(parents=True, exist_ok=True)
