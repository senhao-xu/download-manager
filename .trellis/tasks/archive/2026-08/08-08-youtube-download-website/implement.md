# Implement: YouTube Download Website

Ordered execution plan. Validate at each gate before proceeding. Do **not** run
`task.py start` until the final planning summary is explicitly approved.

## Pre-start checklist (Phase 2 gate)

- [ ] `prd.md` converged (no duplicate facts, no blocking open questions).
- [ ] `design.md` present (complex task).
- [ ] `implement.md` present (this file).
- [ ] If using sub-agent dispatch: curate real entries in `implement.jsonl` and
      `check.jsonl` (the seed `_example` row does not count). Inline workflows
      skip this (Phase 2 loads context via `trellis-before-dev`).
- [ ] Bootstrap spec task `00-bootstrap-guidelines` is still open - fill backend
      /frontend spec files as part of step 1 below, or accept generic sub-agent
      output for now.

## Implementation steps

### 1. Project scaffold + spec
- Create `backend/` (Python 3.11, `pyproject.toml` or `requirements.txt`) and
  `frontend/` (Vite + React + TS).
- Fill `.trellis/spec/backend/*` and `.trellis/spec/frontend/*` with the real
  conventions chosen here (FastAPI layout, React structure) so sub-agents match.
- Pin `yt-dlp` nightly; list `fastapi`, `uvicorn[standard]`, `pydantic` deps.

### 2. yt-dlp wrapper + /api/info
- `backend/app/downloader.py`: `extract_info(url)` (detects playlist), returns
  schemas. All yt-dlp calls go through `run_blocking()` threadpool helper.
- `routes.py`: `POST /api/info`. Test with a real public video URL and a
  playlist URL -> verify formats/entries returned.

### 3. Single-video download + job worker + SSE
- `jobs.py`: `Job` model, in-memory dict, `ThreadPoolExecutor`, `create_job()`.
- `POST /api/download {url, format_id}` -> `{job_id}`.
- Worker: `download()` with `progress_hooks` -> updates `Job.progress`.
- `GET /api/jobs/{id}/events` -> SSE `StreamingResponse` of `JobStatus`.
- `GET /api/files/{id}` -> `FileResponse`.
- **Gate**: download a 1080p video end-to-end; confirm A/V merged (ffprobe shows
  both streams) and progress events flow.

### 4. Playlist batch + zip
- `POST /api/download-batch {urls[], format_id}` -> `{job_id}`.
- Worker: download each to per-job temp dir, zip to disk, set `result_path`.
- SSE reports `{current, total, percent}` per file.
- **Gate**: paste a small playlist (3-5 videos), select 2, confirm zip contains
  exactly those 2 playable mp4s.

### 5. TTL cleanup
- `storage.py`: per-job temp dir; `cleanup_expired()` sweep on a background
  task started in FastAPI lifespan (interval from `TTL_MINUTES`).
- **Gate**: create a job, advance clock / shorten TTL, confirm files removed.

### 6. Frontend
- URL input -> `/api/info`; render format picker (single) or playlist list with
  checkboxes + "select all" + quality picker (playlist).
- Subscribe to SSE; render progress bar (single) or per-file progress (batch).
- On `done`, trigger `download_url`.
- **Gate**: full click-through for single video and for a playlist multi-select.

### 7. Dockerize
- Dockerfile: Python 3.11 + `ffmpeg` + `deno` + `yt-dlp` nightly; build frontend,
  copy into image, serve via `StaticFiles`.
- `docker-compose.yml`; env config (`PORT`, `DOWNLOAD_DIR`, `TTL_MINUTES`,
  `MAX_CONCURRENT`).
- **Gate**: `docker compose up` -> app reachable; single + playlist download work.

### 8. Hardening / errors
- Map `yt_dlp.utils.DownloadError` messages to user-friendly UI errors.
- Invalid/private/age-restricted URLs -> clear error, no 500.
- `--impersonate` config via env; sensible `--sleep-interval` defaults.
- **Gate**: test an age-restricted/private URL and a garbage URL -> clean errors.

## Validation commands (representative)

```bash
# backend
cd backend && pip install -r requirements.txt
uvicorn app.main:app --reload           # smoke: GET /healthz -> 200

# info + download (single)
curl -s localhost:8000/api/info   -H 'Content-Type: application/json' -d '{"url":"<VIDEO_URL>"}'
curl -s localhost:8000/api/download -H 'Content-Type: application/json' -d '{"url":"<VIDEO_URL>","format_id":"<id>"}'

# frontend
cd frontend && npm install && npm run dev   # then click-through
# build
cd frontend && npm run build                # output served by backend

# docker
docker compose up --build
```

## Risky points / rollback

- **yt-dlp blocking the event loop**: every yt-dlp call must go through
  `run_blocking()` in `downloader.py`. If a route awaits yt-dlp inline, the
  server stalls under load. Review this first if progress stutters.
- **nightly breakage**: if extraction suddenly fails on a previously-working
  URL, bump the pinned yt-dlp nightly before debugging deeper.
- **zip memory**: current design zips on disk (safe). If someone swaps in an
  in-memory zip for "speed," large selections will OOM - keep disk-based.
- **Rollback**: `docker compose up -d` with the prior image tag; no state to
  migrate (in-memory jobs are disposable).
