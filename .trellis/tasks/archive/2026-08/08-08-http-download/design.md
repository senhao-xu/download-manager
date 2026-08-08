# Design - HTTP stream-download module

## Backend

### New module `backend/app/http_dl.py`

```python
import re
from pathlib import Path
from urllib.parse import urlparse, unquote
from curl_cffi import requests as cffi_requests
from .config import settings as cfg
from .settings import effective_opts

def _proxy() -> str | None:
    return effective_opts().get("proxy")

def _impersonate() -> str | None:
    return cfg.impersonate

def _filename_from(url: str, resp) -> str:
    # 1. Content-Disposition
    cd = resp.headers.get("content-disposition")
    if cd:
        m = re.search(r"filename\*=(?:UTF-8'')?([^;]+)", cd, re.I) \
            or re.search(r'filename="?([^";]+)"?', cd, re.I)
        if m:
            return _sanitize(unquote(m.group(1)).strip())
    # 2. URL path tail
    path = urlparse(url).path
    base = unquote(Path(path).name) if path else ""
    if base:
        return _sanitize(base)
    # 3. fallback from content-type
    return "download"

def _sanitize(name: str) -> str:
    keep = "".join(c for c in name if c.isalnum() or c in " -_().")
    return keep.strip(" .") or "download"

def _ext_from_mime(mime: str | None) -> str:
    # minimal map; curl_cffi resp doesn't always give ext
    m = {
        "video/mp4": ".mp4", "video/webm": ".webm", "audio/mpeg": ".mp3",
        "audio/mp4": ".m4a", "image/jpeg": ".jpg", "image/png": ".png",
        "image/gif": ".gif", "image/webp": ".webp", "application/pdf": ".pdf",
    }
    return m.get((mime or "").split(";")[0].strip().lower(), "")

def download_sync(url: str, dest_dir: Path, progress_hook) -> tuple[str, Path, int, str]:
    """Stream-download one URL. Returns (filename, path, size, mime)."""
    resp = cffi_requests.get(
        url, stream=True, impersonate=_impersonate(), proxy=_proxy(),
        timeout=60, allow_redirects=True,
    )
    if resp.status_code >= 400:
        raise RuntimeError(f"HTTP {resp.status_code} for {url}")
    mime = resp.headers.get("content-type")
    total = _content_length(resp.headers)
    name = _filename_from(url, resp)
    if "." not in name:
        ext = _ext_from_mime(mime)
        if ext:
            name += ext
    name = _unique(dest_dir, name)
    path = dest_dir / name
    done = 0
    with path.open("wb") as f:
        for chunk in resp.iter_content(64 * 1024):
            if not chunk:
                continue
            f.write(chunk)
            done += len(chunk)
            progress_hook({
                "status": "downloading",
                "downloaded_bytes": done,
                "total_bytes": total or 0,
            })
    progress_hook({"status": "finished"})
    return name, path, done, mime or "application/octet-stream"
```

`_content_length`: parse `Content-Length` header -> int or None.
`_unique(dir, name)`: if exists, append ` (1)`, ` (2)` before extension.

The progress_hook dict mimics yt-dlp's hook shape (`status`,
`downloaded_bytes`, `total_bytes`) so `jobs.py`'s existing hook logic
translates it to `job.progress` unchanged.

### `jobs.py` additions

```python
def start_http(urls: list[str]) -> Job:
    job = create_job()
    job.total = len(urls)
    _executor.submit(_run_http, job, urls)
    return job

def _run_http(job: Job, urls: list[str]):
    total = len(urls)
    _set(job, status="running", phase="starting", total=total, current=0)
    d = storage.job_dir(job.id)
    saved = []
    try:
        for i, url in enumerate(urls):
            _set(job, current=i, phase=f"downloading {i+1}/{total}")
            base = (i / total) * 100.0 if total else 0.0
            span = (100.0 / total) if total else 100.0
            def hook(ev, base=base, span=span):
                if ev.get("status") == "downloading":
                    t = ev.get("total_bytes") or 0
                    dn = ev.get("downloaded_bytes", 0)
                    sub = (dn / t) if t else 0
                    _set(job, progress=min(99.5, base + span * sub))
                elif ev.get("status") == "finished":
                    _set(job, progress=min(99.5, base + span))
            name, path, size, mime = http_dl.download_sync(url, d, hook)
            saved.append((str(path), name, mime))
            _record_history(job, "http", url, str(path), name, mime) \
                if history else None
        _set(job, status="done", progress=100.0, phase="done",
             files=[(p, n) for (p, n, _m) in saved],
             download_url=(f"/api/files/{job.id}" if len(saved) == 1 else None))
    except Exception as e:
        logger.exception("http download failed for job %s", job.id)
        _set(job, status="error", error=_friendly_error(e), phase="error")
```

Note: `job.files` is `list[(path, filename)]` (2-tuple) in the existing code.
HTTP keeps the same shape; mime is recorded into history but not stored on the
job (mime is derivable from filename client-side for preview). This avoids
changing the `Job`/`JobStatus` schema.

`history` import is conditional/guarded so this task compiles even if
`preview-history` isn't merged yet - but in practice both land together.

### Route `routes.py`

```python
class HttpDownloadRequest(BaseModel):
    urls: list[str]

@router.post("/download-http", response_model=JobCreated)
def post_download_http(req: HttpDownloadRequest):
    cleaned = [u.strip() for u in req.urls if u.strip()]
    if not cleaned:
        raise HTTPException(400, "No URLs provided.")
    bad = [u for u in cleaned if not u.lower().startswith(("http://","https://"))]
    if bad:
        raise HTTPException(400, f"Invalid URL(s): {bad[:3]}")
    job = jobs.start_http(cleaned)
    return JobCreated(job_id=job.id)
```
Add `HttpDownloadRequest` to `schemas.py`.

## Frontend

### `HttpTab.tsx` (replace placeholder)
```tsx
export function HttpTab() {
  const { t } = useLang()
  const [text, setText] = useState('')
  const [job, setJob] = useState<JobStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { subscribe } = useJobSubscription(setJob, setError)
  async function onStart() {
    const urls = text.split('\n').map(s => s.trim()).filter(Boolean)
    if (!urls.length) { setError(t('noUrls')); return }
    setError(null)
    try {
      const id = await startHttpDownload(urls)
      setJob({ id, status: 'queued', progress: 0, current: 0, total: urls.length,
               phase: 'queued', title: null, error: null,
               download_url: null, download_urls: [] })
      subscribe(id)
    } catch (e) { setError(e instanceof Error ? e.message : t('startFailed')) }
  }
  return ( ... textarea + button + JobView ... )
}
```

### Shared `useJobSubscription` hook
Extract from `YouTubeTab`'s `subscribe` into `frontend/src/useJobSubscription.ts`
(or in `JobView.tsx`). Both YouTube and HTTP use it. Returns `{ subscribe }`
that manages an internal EventSource ref + cleanup.

```ts
export function useJobSubscription(onJob, onError?) {
  const esRef = useRef<EventSource | null>(null)
  const triggeredRef = useRef<string | null>(null)
  useEffect(() => () => esRef.current?.close(), [])
  const subscribe = (jobId: string, { autoDownload = true } = {}) => {
    esRef.current?.close()
    const es = new EventSource(`/api/jobs/${jobId}/events`)
    esRef.current = es
    es.onmessage = (ev) => {
      const j = JSON.parse(ev.data) as JobStatus
      onJob(j)
      if (autoDownload && j.status === 'done' && triggeredRef.current !== jobId) {
        triggeredRef.current = jobId
        const urls = j.download_urls?.length ? j.download_urls : (j.download_url ? [j.download_url] : [])
        if (urls.length === 1) triggerDownload(urls[0])
      }
      if (j.status === 'done' || j.status === 'error') es.close()
    }
    es.onerror = () => es.close()
  }
  const reset = () => { esRef.current?.close(); esRef.current = null; triggeredRef.current = null }
  return { subscribe, reset }
}
```
Put `triggerDownload`/`downloadAll` (from child 1's `JobView.tsx`) as imports.

### api.ts / types.ts
```ts
export async function startHttpDownload(urls: string[]): Promise<string> {
  const r = await postJSON('/api/download-http', { urls })
  if (!r.ok) throw new Error(await readError(r))
  return (await r.json()).job_id as string
}
```

### Preview for HTTP media
`JobView` Play button (from child 2) already handles video/audio. Add image
support: if mime/extension is an image, PreviewModal shows `<img>`. Extend
`PreviewModal`'s detection to images.

### i18n keys (zh+en)
`httpTabTitle`, `httpPlaceholder` ("One URL per line…"), `downloadHttp`,
`noUrls`, `httpHint`.

## Cross-layer data flow

```
HttpTab textarea -> POST /api/download-http {urls}
  -> jobs.start_http -> _run_http (threadpool)
       -> http_dl.download_sync (curl_cffi stream)
            -> progress_hook -> _set(job) -> SSE -> JobView
       -> on done: history.append(kind=http) + files set
  <- JobCreated {job_id}
GET /api/jobs/{id}/events (SSE) -> JobView
GET /api/files/{id}[/i] -> download / preview
GET /api/history -> HistoryPanel (shared)
```

## Risks

- Large files: streaming to disk is fine; SSE progress uses byte ratio. No
  in-memory buffering of the whole file.
- `curl_cffi` `iter_content` blocking in the threadpool - correct (same as
  yt-dlp). Never call on the event loop.
- Redirects: `allow_redirects=True` handles them.
- Filename collisions across batch urls: `_unique` handles within one job dir.
- `history` import guard: import at top of `jobs.py` normally; both children
  ship together. If needed, wrap the `history.append` call in try/except.
