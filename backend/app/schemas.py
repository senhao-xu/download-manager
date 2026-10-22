"""Pydantic request/response schemas (API contracts)."""
from typing import Literal

from pydantic import BaseModel, Field


class Format(BaseModel):
    format_id: str | None = None
    format_note: str | None = None
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
    thumbnail: str | None = None
    thumbnail_candidates: list[str] = Field(default_factory=list)
    downloaded: bool = False


class InfoResponse(BaseModel):
    is_playlist: bool
    title: str | None = None
    thumbnail: str | None = None
    thumbnail_candidates: list[str] = Field(default_factory=list)
    duration: int | None = None
    # distinct video heights available, descending (e.g. [1080, 720, 480])
    qualities: list[int] = Field(default_factory=list)
    formats: list[Format] = Field(default_factory=list)
    entries: list[Entry] = Field(default_factory=list)
    is_channel: bool = False
    page: int = 1
    page_size: int = 20
    has_more: bool = False


class InfoRequest(BaseModel):
    url: str
    page: int = Field(default=1, ge=1, le=1000)
    page_size: int = Field(default=20, ge=1, le=50)


class QueueVideo(BaseModel):
    url: str = Field(max_length=2000)
    title: str | None = Field(default=None, max_length=500)


class VideoQueueRequest(BaseModel):
    entries: list[QueueVideo] = Field(min_length=1, max_length=100)
    quality: str = "best"
    skip_downloaded: bool = True


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


class BilibiliDownloadRequest(BaseModel):
    url: str
    quality: str = "best"


class BilibiliBatchRequest(BaseModel):
    urls: list[str]
    quality: str = "best"
    zip: bool = False
    # multi-part / list title (from /info); used to name the zip when zip=True.
    title: str | None = None


class JobCreated(BaseModel):
    job_id: str


class JobStatus(BaseModel):
    id: str
    status: str  # queued | running | paused | done | error | cancelled
    progress: float  # 0..100
    # Current item's transfer bytes (all selected audio/video streams).
    # For a completed batch these become the aggregate output file sizes.
    downloaded_bytes: int = 0
    total_bytes: int | None = None
    total_bytes_estimated: bool = False
    speed: float | None = None  # bytes per second
    eta: float | None = None  # seconds remaining for the current item
    current: int | None = None
    total: int | None = None
    phase: str | None = None
    title: str | None = None
    thumbnail: str | None = None
    thumbnail_candidates: list[str] = Field(default_factory=list)
    resolution: str | None = None
    fps: float | None = None
    error: str | None = None
    download_url: str | None = None
    download_urls: list[str] = Field(default_factory=list)
    # "youtube" | "http" | "bt" - lets the frontend group active jobs by tab and
    # merge them with the kind-filtered history. None only if unset (legacy).
    kind: str | None = None
    source: str | None = None


class VideoQueueResponse(BaseModel):
    jobs: list[JobStatus]
    skipped_downloaded: int = 0
    skipped_active: int = 0


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
    key: str = ""
    download_url: str | None = None
    kind: str  # "youtube" | "http"
    stream_url: str | None = None
    title: str | None = None
    thumbnail: str | None = None
    thumbnail_candidates: list[str] = Field(default_factory=list)
    resolution: str | None = None
    fps: float | None = None
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


class HistoryBatchDeleteRequest(BaseModel):
    keys: list[str] = Field(min_length=1, max_length=100)
    delete_files: bool = False


class HistoryDeleteFailure(BaseModel):
    key: str
    reason: Literal["active_job", "shared_file", "invalid_path", "delete_failed"]


class HistoryBatchDeleteResult(BaseModel):
    removed: list[str]
    missing: list[str]
    failed: list[HistoryDeleteFailure]

