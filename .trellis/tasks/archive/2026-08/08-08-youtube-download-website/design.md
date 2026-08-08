# Design: YouTube Download Website

## Architecture

Single-container self-hosted app. A Python/FastAPI backend embeds yt-dlp and
serves a built React SPA. Downloads run in an in-process threadpool worker
(yt-dlp is synchronous/blocking) with job IDs and SSE progress.

```
Browser (React SPA: i18n zh/en, dark/light theme, settings modal)
   |  JSON + SSE over HTTP
FastAPI backend (uvicorn)
   |-- app.downloader  : yt-dlp wrapper (extract_info, download)  [threadpool]
   |-- app.jobs        : in-memory job registry + worker (single / batch-mp4 / batch-zip)
   |-- app.storage     : temp dir + TTL cleanup
   |-- app.settings    : persisted cookies + proxy + js_runtimes (DATA_DIR)
   |-- StaticFiles     : serves built frontend
yt-dlp (nightly) + ffmpeg + node>=22  (system deps in image)
DATA_DIR/  (settings.json, cookies.txt, downloads/ - TTL-cleaned)
```

### Boundaries / modules

| Module | Responsibility |
|---|---|
| `backend/app/main.py` | FastAPI app, CORS, routes, lifespan (starts cleanup task), mounts StaticFiles |
| `backend/app/schemas.py` | Pydantic request/response models |
| `backend/app/downloader.py` | yt-dlp wrapper: `extract_info(url)`, `download(url, quality, hook, dest)`; always run in threadpool; before/after dir diff to avoid cross-file duplication |
| `backend/app/jobs.py` | `Job` model, in-memory `dict[job_id, Job]`, `ThreadPoolExecutor`; single / batch-mp4 (order-prefixed names) / batch-zip workers |
| `backend/app/storage.py` | temp dir per job, `cleanup_expired()` TTL sweep |
| `backend/app/settings.py` | persisted `settings.json` + `cookies.txt`; `effective_opts()` merges UI settings over env fallbacks (cookiefile, proxy, `js_runtimes={'node':{}}`) |
| `backend/app/routes.py` | `/api/info`, `/api/download`, `/api/download-batch`, `/api/jobs/{id}`, `/api/jobs/{id}/events` (SSE), `/api/files/{id}`, `/api/files/{id}/{index}`, `/api/settings*`, `/api/settings/check-cookies` |
| `frontend/src/` | React app: URL input, format picker, playlist list+select, progress UI |

## Data Flow & Contracts

### Single video

1. UI pastes URL -> `POST /api/info {url}`
2. Backend: `extract_info(url, download=False)` in threadpool -> formats list
3. UI picks a format -> `POST /api/download {url, format_id}` -> `{job_id}`
4. UI subscribes `GET /api/jobs/{id}/events` (SSE) -> progress events
5. Worker: `download()` with `progress_hooks` updating `Job`; ffmpeg merges A/V
6. `done` event carries `download_url`; UI `GET /api/files/{id}`
7. File TTL-cleaned later

### Playlist

1. UI pastes playlist URL -> `POST /api/info {url}`
2. Backend returns `is_playlist=true` + `entries[]`
3. UI lists entries with checkboxes + "select all" + quality picker -> `POST /api/download-batch {urls[], format_id}` -> `{job_id}`
4. SSE streams per-file progress `{current, total, percent}`
5. Worker: download each selected video, then zip all -> `Job.result_path = .zip`
6. UI `GET /api/files/{id}` -> zip

### API contracts (Pydantic)

```python
# /api/info response
class Format(BaseModel):
    format_id: str; ext: str; resolution: str | None
    fps: float | None; vcodec: str | None; acodec: str | None
    filesize: int | None

class Entry(BaseModel):
    id: str; url: str; title: str; duration: int | None

class InfoResponse(BaseModel):
    is_playlist: bool
    title: str | None; thumbnail: str | None; duration: int | None
    formats: list[Format] = []        # single video
    entries: list[Entry] = []          # playlist

# requests
class DownloadRequest(BaseModel):  url: str; format_id: str
class BatchRequest(BaseModel):     urls: list[str]; format_id: str
class JobCreated(BaseModel):       job_id: str

# job status / SSE event
class JobStatus(BaseModel):
    id: str; status: Literal["queued","running","done","error"]
    progress: float; current: int | None; total: int | None
    error: str | None; download_url: str | None
```

- `GET /api/jobs/{id}/events` -> `text/event-stream` of `JobStatus` JSON.
- `GET /api/files/{id}` -> `FileResponse` (mp4 or zip) with download header.

## Key Design Choices & Trade-offs

- **In-memory job store** (`dict`): simple, no DB. Lost on restart - acceptable
  for personal use. Swap path noted in PRD deferred items (SQLite/Redis).
- **Threadpool for yt-dlp**: yt-dlp is blocking; never run it on the event loop.
  Bounded `ThreadPoolExecutor(max_workers=MAX_CONCURRENT)` (default ~3). SSE is
  produced by reading job state from a background `asyncio` task.
- **SSE over WebSocket**: progress is one-directional; SSE is simpler and
  reconnects cheaply. Implemented via `StreamingResponse`.
- **Zip strategy**: for v1, download each file to a per-job temp dir, then zip to
  disk, serve, cleanup. Avoids streaming-zip complexity; fine for personal
  selection sizes. If large selections become common, switch to `zipstream-ng`.
- **nightly yt-dlp**: pinned to a specific nightly (`YTDLP_VERSION` build arg in
  the Dockerfile, currently `2026.8.4.234419.dev0`) for reproducible builds.
  Bump when YouTube breaks an extractor.
- **YouTube access = cookies + proxy + node 22** (material finding from
  implementation): the "Sign in to confirm you're not a bot" error is a **JS
  challenge** that yt-dlp must solve, plus a PO-token/cookie requirement.
  - deno 2.1.4 and node < 22 are "unsupported" by yt-dlp-ejs 0.8.0 -> the JS
    challenge can't be solved. Fix: `js_runtimes={'node': {}}` with node >= 22
    (NodeSource in Docker; the dict value MUST be `{}`, not `None` - yt-dlp does
    `config.get('path')`). Verified: JSC `node` becomes available.
  - Even with node, the bot-wall needs cookies + (usually) a proxy. Configured via
    a **Settings UI** (cookies.txt paste + proxy + JS-runtime select + test
    button), persisted to `DATA_DIR` (`app/settings.py`), taking effect
    immediately. Env vars are fallbacks. A PO-token provider (bgutil) was
  prototyped and works standalone but was NOT integrated (user chose the cookie
  path); non-YouTube sources work without any of this.
- **Single video "default"**: when no format chosen, default to best mp4
  (`-f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"`).

## Compatibility / Migration

Greenfield - no migration. No existing data, users, or APIs to preserve.

## Operational / Rollback

- **Deploy**: `docker compose up -d` (multi-stage Dockerfile: node builds the
  frontend, python:3.11-slim runtime adds ffmpeg + deno + yt-dlp nightly). Build
  uses `network: host` because the Docker bridge truncated PyPI responses in this
  environment.
- **Config (env)**: `PORT`, `DOWNLOAD_DIR`, `TTL_MINUTES`, `MAX_CONCURRENT`,
  `YTDLP_COOKIEFILE`, `YTDLP_PROXY`, `YTDLP_IMPERSONATE`, `YTDLP_SLEEP_INTERVAL`.
- **Rollback**: redeploy previous pinned image (`docker compose up -d` with the
  prior `YTDLP_VERSION`). No state to migrate (in-memory jobs are disposable).

## Risks

- YouTube breaks the yt-dlp extractor -> update pinned nightly; document the
  `pip install --upgrade` path.
- Large playlist selection spikes disk/CPU -> cap `MAX_CONCURRENT`; consider a
  soft cap on batch size with a UI warning.
- yt-dlp blocking the event loop if misused -> enforce threadpool usage in
  `downloader.py` (a single `run_blocking(fn)` helper all calls go through).
