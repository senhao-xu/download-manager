"""Pydantic request/response schemas (API contracts)."""
from pydantic import BaseModel, Field


class Format(BaseModel):
    format_id: str | None = None
    ext: str | None = None
    resolution: str | None = None
    fps: float | None = None
    vcodec: str | None = None
    acodec: str | None = None
    filesize: int | None = None


class Entry(BaseModel):
    id: str | None = None
    url: str | None = None
    title: str | None = None
    duration: int | None = None


class InfoResponse(BaseModel):
    is_playlist: bool
    title: str | None = None
    thumbnail: str | None = None
    duration: int | None = None
    # distinct video heights available, descending (e.g. [1080, 720, 480])
    qualities: list[int] = Field(default_factory=list)
    formats: list[Format] = Field(default_factory=list)
    entries: list[Entry] = Field(default_factory=list)


class InfoRequest(BaseModel):
    url: str


class DownloadRequest(BaseModel):
    url: str
    # "best" or a height string like "1080". Defaults to "best".
    quality: str = "best"


class BatchRequest(BaseModel):
    urls: list[str]
    quality: str = "best"
    zip: bool = False
    # playlist title (from /info); used to name the zip when zip=True.
    title: str | None = None


class HttpDownloadRequest(BaseModel):
    urls: list[str]


class BtMagnetRequest(BaseModel):
    magnet: str


class JobCreated(BaseModel):
    job_id: str


class JobStatus(BaseModel):
    id: str
    status: str  # queued | running | paused | done | error | cancelled
    progress: float  # 0..100
    current: int | None = None
    total: int | None = None
    phase: str | None = None
    title: str | None = None
    error: str | None = None
    download_url: str | None = None
    download_urls: list[str] = Field(default_factory=list)
    # "youtube" | "http" | "bt" - lets the frontend group active jobs by tab and
    # merge them with the kind-filtered history. None only if unset (legacy).
    kind: str | None = None


class SettingsUpdate(BaseModel):
    proxy: str = ""
    js_runtimes: str = "node"


class TestRequest(BaseModel):
    url: str


class TestResult(BaseModel):
    ok: bool
    title: str | None = None
    error: str | None = None


class CookieCheckResult(BaseModel):
    # working | blocked | no_cookies | network_error | error
    state: str
    title: str | None = None
    detail: str | None = None


class HistoryEntry(BaseModel):
    id: str
    kind: str  # "youtube" | "http"
    title: str | None = None
    source: str | None = None
    filename: str | None = None
    size: int | None = None
    mime: str | None = None
    created: float
    available: bool = False


class HistoryList(BaseModel):
    items: list[HistoryEntry]
    total: int = 0
    page: int = 1
    page_size: int = 10

