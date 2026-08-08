# Implement - HTTP stream-download module

Depends on child `08-08-header-tabs` (HttpTab placeholder + tab shell + shared
JobView) and integrates `history.append` from child `08-08-preview-history`.

## Execution checklist

### Backend - http_dl module
- [ ] Create `backend/app/http_dl.py`:
  - `download_sync(url, dest_dir, progress_hook) -> (filename, path, size, mime)`.
  - Helpers: `_filename_from` (Content-Disposition -> URL path -> fallback),
    `_sanitize`, `_ext_from_mime`, `_content_length`, `_unique`.
  - Uses `curl_cffi.requests.get(stream=True, impersonate=cfg.impersonate,
        proxy=effective_opts().get("proxy"), allow_redirects=True)`.
  - Raises `RuntimeError` on >=400; iter_content writes 64KB chunks + hook.
- [ ] Verify curl_cffi API: `resp.iter_content(n)`, `resp.headers`, `resp.status_code`
      (confirmed: 0.16.0 supports these).

### Backend - jobs
- [ ] Add `start_http(urls)` + `_run_http(job, urls)` to `jobs.py`.
- [ ] Hook shape mirrors yt-dlp (`status`/`downloaded_bytes`/`total_bytes`).
- [ ] On done: set `files=[(path,name)...]`, `download_url` for single.
- [ ] Call `history.append` per file (kind `http`, source=url) - guarded by
      try/except so a history write failure doesn't fail the download.

### Backend - schema + route
- [ ] Add `HttpDownloadRequest(BaseModel): urls: list[str]` to `schemas.py`.
- [ ] Add `POST /api/download-http` to `routes.py`: validate non-empty + http(s)
      scheme, return `JobCreated`.

### Backend - validate
- [ ] `cd backend && .venv/bin/python -c "from app.main import app; print('ok')"`.
- [ ] `curl -s localhost:8000/api/healthz` ok.
- [ ] `curl -s -X POST localhost:8000/api/download-http -H 'Content-Type: application/json' \
        -d '{"urls":["https://httpbin.org/bytes/1024"]}'` -> `{job_id}`; poll
        `/api/jobs/{id}` until done; `GET /api/files/{id}` returns bytes.

### Frontend - shared hook
- [ ] Extract `useJobSubscription` (subscribe/reset) into `JobView.tsx` or a new
      `frontend/src/useJobSubscription.ts`. Refactor `YouTubeTab` to use it.

### Frontend - HttpTab
- [ ] Replace placeholder `HttpTab.tsx` with: textarea + Download button + error
      + JobView. Use `useJobSubscription`.
- [ ] Add `startHttpDownload(urls)` to `api.ts`.

### Frontend - preview images
- [ ] Extend `PreviewModal` (from child 2) to render `<img>` for image mime/ext.

### Frontend - i18n + styles
- [ ] Add keys (zh+en): `httpTabTitle`, `httpPlaceholder`, `downloadHttp`,
      `noUrls`, `httpHint`.
- [ ] Textarea styles reuse `.modal textarea` look; add `.url-textarea` if needed.

### Validate
- [ ] `cd frontend && npm run build` passes.
- [ ] Manual: paste a direct image url -> downloads -> preview shows image;
      paste a small file url -> downloads; multiple urls -> Download all;
      bad url -> friendly error; history shows http entries.

## Validation commands

```bash
cd backend && .venv/bin/python -c "from app.main import app; print('ok')"
cd frontend && npm run build
# functional:
curl -s -X POST localhost:8000/api/download-http -H 'Content-Type: application/json' \
  -d '{"urls":["https://httpbin.org/bytes/2048"]}'
```

## Review gates

- curl_cffi call runs inside the threadpool (via `_executor.submit`), never on
  the event loop. Grep: no `http_dl.download_sync` called from an `async def`
  without `run_blocking` (here it's submitted to the executor directly - ok).
- Every error path maps to `job.error` via `_friendly_error` (no raw 500).
- `_run_http` records history for each file.
- `Job`/`JobStatus` schema unchanged (mime not added; derived client-side).

## Rollback

- Backend: revert `http_dl.py`, the `start_http`/`_run_http` additions in
  `jobs.py`, `HttpDownloadRequest`, and the `/download-http` route.
- Frontend: restore `HttpTab.tsx` placeholder, revert api/types additions.
- No data migration; `history.jsonl` http entries are just ignored if code is
  reverted (they reference files that TTL will clean).
