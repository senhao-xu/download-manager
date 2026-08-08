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
    proxy: str | None = os.getenv("YTDLP_PROXY") or None
    impersonate: str | None = os.getenv("YTDLP_IMPERSONATE") or None
    sleep_interval: float = float(os.getenv("YTDLP_SLEEP_INTERVAL", "0") or 0)


settings = Settings()
settings.data_dir.mkdir(parents=True, exist_ok=True)
settings.download_dir.mkdir(parents=True, exist_ok=True)
