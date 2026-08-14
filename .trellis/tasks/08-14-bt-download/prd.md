# BT download module

## Goal

Add BitTorrent download support (magnet links + `.torrent` file upload) to the
self-hosted downloader, surfaced as a new "BT" tab alongside YouTube and HTTP.
A BT download must behave like an HTTP relay download from the user's POV: submit
source → live progress via SSE → serve the resulting file(s) through the existing
`/api/files/{job_id}` layer → record to history.

## Background (architecture facts)

The app is a single-process FastAPI server + React SPA with a threadpool-backed,
in-memory job system. Three download "kinds" already exist as parallel `_run_*`
workers that all feed one `Job` model and one progress contract:

- **Engine-as-module pattern**: each source is a synchronous `download_sync(...)`
  run in a `ThreadPoolExecutor`; progress is reported via a yt-dlp-shaped hook
  dict `{"status","downloaded_bytes","total_bytes"}`. `http_dl.py`
  (`backend/app/http_dl.py:112`) is the cleanest template — it deliberately
  mimics yt-dlp's hook shape so `jobs.py` progress logic is unchanged. BT follows
  this exact pattern.
- **Job orchestration**: `backend/app/jobs.py` — `Job` dataclass (`:27`),
  in-memory `_jobs` dict (`:45`), single `ThreadPoolExecutor(max_workers=3)`
  (`:47`). Entry points `start_*` → `_run_*` workers. `_run_http`
  (`jobs.py:276-323`) is the template for `_run_bt`: per-URL files become an
  indexed `/api/files/{job_id}/{i}` list, history `kind="http"`.
- **Progress transport**: SSE at `/api/jobs/{job_id}/events` (`routes.py:87`),
  0.4s snapshot polling; frontend subscribes via `useJobSubscription.ts`.
- **File serving**: `/api/files/{job_id}` (single) and `/api/files/{job_id}/{index}`
  (multi, `routes.py:112-133`); MIME via `storage.media_type`.
- **History**: append-only JSONL `<DATA_DIR>/history.jsonl`, `kind` field;
  `available` computed on read (`routes.py:136-154`).
- **Config**: env (`config.py`) + runtime `settings.json` (`settings.py`),
  UI-first/env-fallback merge via `effective_opts()`.
- **Lifecycle**: TTL cleanup thread `rmtree`s job dirs older than `TTL_MINUTES`
  (default 60) — `storage.py:46-75`, started in `main.py` lifespan.
- **Frontend**: tab system `useTab()` (`i18n.tsx:241`, `Tab='youtube'|'http'`),
  tab nav in `App.tsx:42-58`, `HttpTab.tsx` is the tab template, `api.ts`
  `postJSON` helper, `types.ts` mirrors `schemas.py`, i18n strings in `i18n.tsx`.
- **Engine choice**: `libtorrent` 2.1.1 — PyPI has
  `cp311-cp311-manylinux_2_17_x86_64.whl` (verified), so `pip install libtorrent`
  works with zero compilation and zero system packages; matches `python:3.11-slim`.
  Keeps the recently-shrunk Docker image (~1.3GB) stable.

## Confirmed facts (from evidence / user decisions)

- MVP inputs: **magnet links** (`magnet:?xt=urn:btih:…`) AND **`.torrent` file
  upload**. (user decision)
- BT uses an **independent `ThreadPoolExecutor`**, not the shared 3-slot yt-dlp
  pool — long BT jobs must not block YouTube/HTTP downloads. (user decision)
- Engine: **libtorrent** (Python bindings), process-in-library, no second daemon.
- All existing APIs are JSON (`postJSON`); `.torrent` upload needs a new
  `multipart/form-data` endpoint (technical necessity, not a product choice).
- Multi-file torrents map to the indexed `/api/files/{job_id}/{i}` list — same
  shape as `_run_http` non-zip batch. No new file-serving route needed.

## Requirements

### R1 — BT engine module (`backend/app/bt_dl.py`)
- `download_sync(source, dest_dir, progress_hook) -> (name, path, size, mime)` for
  a magnet link. Signature mirrors `http_dl.download_sync` (`http_dl.py:112`).
- Emits hook dicts `{"status":"downloading","downloaded_bytes":N,"total_bytes":S}`
  and `{"status":"finished"}` so `jobs.py` hook logic is reused unchanged.
- Saves the torrent payload into `dest_dir` (the job dir); multi-file torrents
  produce a file list.
- Accepts a `.torrent` file path as `source` too (uploaded file written to a temp
  path by the route, then passed in).

### R2 — Job path (`backend/app/jobs.py`)
- `start_bt(source) -> Job` + `_run_bt` worker, mirroring `start_http`/`_run_http`.
- BT runs on a **dedicated `ThreadPoolExecutor`** (e.g. `max_workers=1` by default,
  env-configurable), separate from the yt-dlp pool.
- History `kind="bt"`.
- Single-file torrent → direct `download_url`; multi-file → indexed list via
  `snapshot()` (same branching as `_run_http`).

### R3 — API (`backend/app/routes.py`, `schemas.py`)
- `POST /api/download-bt` accepting JSON `{magnet: "magnet:?…"}`.
- `POST /api/download-bt/file` accepting `multipart/form-data` `.torrent` upload,
  writing it to the job's temp dir, then starting the job. Returns `{job_id}`.

### R4 — Frontend (`BtTab.tsx`, `App.tsx`, `api.ts`, `types.ts`, `i18n.tsx`)
- New "BT" tab. Input: magnet textarea + `.torrent` file picker.
- Reuses `JobView` + `useJobSubscription` for live progress.
- New i18n strings (zh + en), new `kindBt: 'BT'` history label.

### R5 — Dependencies & build
- `libtorrent` added to `backend/requirements.txt`.
- Dockerfile: no system package needed (wheel). Document the BT listen port if
  NAT/firewall relevant (best-effort; DHT may need UDP).

### R6 — TTL / lifecycle safety
- Active (running) BT job dirs must NOT be `rmtree`'d by the TTL sweep — a slow
  torrent can exceed 60min. Exempt dirs whose job is still `running`, or extend
  BT TTL. (mechanism in design.md)

## Out of scope (v2)

- Restart-resume of in-flight torrents (process restart still loses `_jobs` state,
  same limitation as all current job types).
- Seed-ratio config / scheduled seeding (MVP does no seeding at all).
- Tracker-specific auth, private-tracker passkeys.
- Bandwidth rate-limiting UI (env defaults only for MVP).
- Streaming/sequential download (play while downloading).

## Resolved decisions

- **Seeding behavior**: download to 100%, then immediately stop the torrent
  (`session.remove_torrent`), mark the job `done`, and release the worker slot.
  No seeding. (user decision) - simplifies the job lifecycle: the only terminal
  states are `done` (file(s) on disk) or `error`; no long-running "seeding" phase
  to model. The BT worker blocks until the torrent reaches `is_finished`, then stops.

## Acceptance criteria

- [ ] Submitting a magnet link in the BT tab starts a job; SSE progress updates
      flow to `JobView` (0→100%).
- [ ] Uploading a `.torrent` file starts a job and downloads the same payload.
- [ ] A single-file torrent completes → one `download_url` is served and
      downloadable via `/api/files/{job_id}`.
- [ ] A multi-file torrent completes → each file is downloadable via indexed
      `/api/files/{job_id}/{i}`, with a "download all" set.
- [ ] BT job appears in history with `kind="bt"` and correct size/mime.
- [ ] A BT job running > 60min is NOT deleted by the TTL sweep.
- [ ] A long BT job does not block a concurrent YouTube download (separate pool).
- [ ] `docker compose build` succeeds with `libtorrent` installed via pip wheel,
      no apt system package added.
- [ ] Invalid magnet / unreadable `.torrent` returns a friendly error, not a 500.
