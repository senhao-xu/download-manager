# HTTP stream-download module

Parent: `08-08-tabs-preview-http` (R3). Depends on child `08-08-header-tabs`
(tab shell + `HttpTab.tsx` placeholder) and shares the history helper from
child `08-08-preview-history` (`history.append`).

## Goal

An **HTTP** tab where the user pastes one or more HTTP(S) direct links; the
server stream-downloads each (acting as a relay) and serves the result through
the existing job/SSE/file pipeline. Completed downloads appear in history and
are previewable when the media type is browser-playable.

## Requirements

### Input
- The HTTP tab has a textarea (one URL per line) + a **Download** button.
- Empty lines and surrounding whitespace are ignored. At least one valid URL
  required. Each line is validated to start with `http://` or `https://`;
  invalid lines are reported back, not silently dropped.
- Single URL = single-file job (like YouTube single). Multiple URLs = batch
  job (like playlist), reusing `JobView` + `download_urls`.

### Backend - downloader
- New module `backend/app/http_dl.py`:
  - `download_sync(url, dest_dir, progress_hook) -> (filename, path, size, mime)`
    using `curl_cffi.requests` with `stream=True`, `impersonate` from settings
    (optional), and the configured proxy from `settings.effective_opts()`.
  - Streams `iter_content()` to a temp file in `dest_dir`, calling the progress
    hook with byte counts (map to the same `downloaded_bytes`/`total_bytes`
    shape yt-dlp uses, so `jobs.py` hooks work unchanged).
  - Filename: prefer `Content-Disposition` (RFC 5987 / filename*), else last URL
    path segment, else `download.<ext-from-content-type>`. Sanitize via the
    existing `_safe_base` rule. Avoid collisions within `dest_dir`.
  - Read `Content-Length` for total; if absent, progress is indeterminate (phase
    "downloading", progress stays at 0 until done -> jump to 100).
  - On HTTP error status (>=400): raise with a friendly message (reuse
    `_friendly_error` shape). On connection error: friendly message.
- `curl_cffi` is synchronous -> run via the existing `ThreadPoolExecutor` (same
  pattern as yt-dlp). No new executor.

### Backend - jobs
- Reuse `jobs.create_job` + the executor. Add `jobs.start_http(urls)` that
  submits `_run_http(job, urls)`.
- `_run_http`: for each url, call `http_dl.download_sync`, set progress via the
  same `_set`/hook mechanism, collect `(path, filename, mime)` like the
  non-zip batch path. On done, set `files=[(path, name)]` and
  `download_url=/api/files/{id}` (single) or indexed URLs (batch). No zip for
  HTTP (keep simple; multiple files served individually).
- Record each completed file via `history.append` (kind `"http"`, source=url).

### Backend - route
- `POST /api/download-http` body `{"urls": ["..."]}` -> `{"job_id": "..."}`.
- Reuses `GET /api/jobs/{id}`, `/events`, `/files/{id}[/index]` unchanged.

### Frontend - HttpTab
- Replace the placeholder from child 1 with the real UI: textarea + Download
  button + error area + `JobView` (reuse the shared `JobView`).
- Subscribe to SSE like YouTube (`subscribe(jobId)` - extract a shared
  `useJobSubscription` hook OR duplicate the small EventSource logic; prefer a
  shared hook to avoid duplication per frontend spec code-reuse guide).
- On single-file done: auto-trigger download (same as YouTube single).
- Completed HTTP media is previewable via the shared `PreviewModal` (image/video/
  audio). Images (`<img>`), video (`<video>`), audio (`<audio>`). Non-media:
  download-only.

### Settings
- The HTTP download honors the proxy from Settings (same `effective_opts().get
  ("proxy")`). No new settings UI field required; the existing proxy applies.
- Optional: `impersonate` env var already exists (`YTDLP_IMPERSONATE`); HTTP
  download uses it too if set.

## Acceptance Criteria

- [ ] HTTP tab: textarea accepts multiple URLs; Download starts a job per batch.
- [ ] A single HTTP URL streams through the server with live progress (JobView
      SSE), then offers a download link.
- [ ] Multiple URLs produce multiple files served via indexed `/api/files` URLs
      and a "Download all" button.
- [ ] Filename comes from Content-Disposition / URL path; sanitized, no
      collisions.
- [ ] A 404 / error URL yields a friendly error in the job card (no 500,
      no traceback to the client).
- [ ] Completed HTTP downloads are recorded in history (`kind: "http"`) and
      appear in the History panel with re-download; media types preview.
- [ ] The configured proxy is applied to the HTTP fetch.
- [ ] Invalid (non-http) lines are reported, not silently dropped.
- [ ] `npm run build` passes; backend boots; `POST /api/download-http` works via
      curl against a small test file.

## Out of scope

- Range/resume (partial content) downloads.
- Authenticated HTTP (cookies/headers UI for HTTP) - v1 uses no creds.
- Recursive / webpage scraping (only direct file URLs).
- Choosing a custom output directory per download.

## Notes

- Shares `history.append` (delivered by sibling `08-08-preview-history`). If that
  child isn't done yet, this task can stub the call but should integrate once
  available. Order: do `preview-history` before or alongside this.
- `curl_cffi` import: `from curl_cffi import requests`. Already installed (0.16).
