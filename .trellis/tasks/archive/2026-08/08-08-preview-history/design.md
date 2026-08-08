# Design - YouTube preview + persistent history

## Backend

### New module `backend/app/history.py`
JSONL append-only store at `<DATA_DIR>/history.jsonl`.

```python
import json, threading, time
from pathlib import Path
from .config import settings as cfg
from .schemas import HistoryEntry

_lock = threading.Lock()

def _path() -> Path:
    return cfg.data_dir / "history.jsonl"

def append(record: dict) -> None:
    """Append one history record. Adds `created` if missing."""
    rec = {**record}
    rec.setdefault("created", time.time())
    with _lock:
        cfg.data_dir.mkdir(parents=True, exist_ok=True)
        with _path().open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

def list_all() -> list[dict]:
    """Read all records, newest-first. Skips malformed lines."""
    p = _path()
    if not p.exists():
        return []
    out: list[dict] = []
    with _lock:
        with p.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    out.reverse()  # newest first (file is append-order = oldest first)
    return out
```

Thread-safety: a module-level `_lock` guards both read and write. The append
happens from worker threads (`jobs._run_single` etc.), the read from the request
thread. One writer at a time; readers also take the lock (cheap, low traffic).

`time.time()` is allowed here (this is the backend, not a Workflow script).

### Schema additions `backend/app/schemas.py`
```python
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
```
`available` is computed at read time (does the path still exist?), not stored.

### Route `backend/app/routes.py`
```python
@router.get("/history", response_model=HistoryList)
def get_history():
    items = []
    for rec in history.list_all():
        path = rec.get("path")
        available = bool(path) and Path(path).exists()
        items.append(HistoryEntry(
            id=rec["id"], kind=rec.get("kind",""), title=rec.get("title"),
            source=rec.get("source"), filename=rec.get("filename"),
            size=rec.get("size"), mime=rec.get("mime"),
            created=rec.get("created", 0), available=available,
        ))
    return HistoryList(items=items)
```

### Call sites - record on done
`jobs.py` currently sets `status="done"` in three places (`_run_single`,
`_run_batch` zip branch, `_run_batch` non-zip branch). For each file produced,
call `history.append(...)` after the `_set(..., status="done", ...)`.

Helper to avoid duplication:
```python
def _record_history(job: Job, kind: str, source: str | None,
                    path: str, filename: str, mime: str | None):
    try:
        sz = Path(path).stat().st_size
    except OSError:
        sz = None
    history.append({
        "id": job.id, "kind": kind, "title": job.title,
        "source": source, "filename": filename,
        "path": path, "size": sz, "mime": mime,
    })
```
- `_run_single`: one record, kind `"youtube"`, source = the video url. Need to
  thread the url into `_run_single` (it already receives `url`).
- `_run_batch` zip: one record for the zip (kind youtube, source = playlist url
  or first url).
- `_run_batch` non-zip: one record per saved file. The per-file url isn't
  tracked today (only the list of urls is). Record `source` as the batch's
  first url + index, or `None`. Acceptable: source = None for batch items,
  title carries the video title.

`mime`: reuse `routes._media_type(path)` - but that lives in routes. Move
`_media_type` to a small shared spot. Decision: move `_media_type` into
`storage.py` (it already deals with files) and import from both `routes` and
`jobs`. Update the `from . import` in routes accordingly. (Spec: "Do not create
a new module unless a genuinely new concern appears" - reusing storage is fine.)

Wrap `history.append` calls so a failure to write history never breaks a
download (try/except + log).

## Frontend

### New `frontend/src/PreviewModal.tsx`
A media overlay:
```tsx
export function PreviewModal({ src, mime, poster, onClose }: {
  src: string; mime: string | null; poster?: string | null; onClose: () => void
}) {
  const isVideo = mime?.startsWith("video/") || (!mime && /\.(mp4|webm|mkv|mov)$/i.test(src))
  const isAudio = mime?.startsWith("audio/") || (!mime && /\.(mp3|m4a|ogg|opus)$/i.test(src))
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal preview-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head"><h2>{t('preview')}</h2><button className="link" onClick={onClose}>{t('close')}</button></div>
        {isVideo && <video src={src} poster={poster} controls autoPlay className="preview-media" />}
        {isAudio && <audio src={src} controls autoPlay />}
        {!isVideo && !isAudio && <p className="hint">{t('previewNotSupported')}</p>}
      </div>
    </div>
  )
}
```
Reuses `.modal-overlay` / `.modal` styles already in `styles.css`. Add
`.preview-media { width: 100%; border-radius: 8px; }`.

### `JobView.tsx` (shared, extracted in child 1)
Add a Play button next to the download link when the result is media-playable.
`JobView` has `job.download_url` / `download_urls`. Derive mime from the URL
extension (no new field needed; or add `mime` to `JobStatus` - simpler to derive
client-side from filename). Decision: derive client-side via a `mimeFromUrl()`
helper in `JobView.tsx`.

Play button opens `PreviewModal` with `src = urls[0]`.

### New `frontend/src/HistoryPanel.tsx`
Loads `GET /api/history`, renders list. Each row: title, kind badge, time
(relative), size, and Preview/Download buttons gated on `available`.

Add to api.ts:
```ts
export async function getHistory(): Promise<HistoryList> {
  const r = await fetch('/api/history')
  if (!r.ok) throw new Error('Failed to load history')
  return r.json()
}
```
Add types to `types.ts`: `HistoryEntry`, `HistoryList` (mirror schemas).

### Where the History button lives
A **History** button in the header toolbar (next to ⚙) opens the panel as a
modal. Shared across tabs (mounted in `App.tsx` shell). It refreshes when opened.

### i18n keys (zh + en)
`preview`, `previewNotSupported`, `history`, `expired`, `reDownload`,
`kindYoutube`, `kindHttp`, `noHistory`.

## Data flow (cross-layer)

```
worker thread -> jobs._run_single (done) -> history.append (jsonl)
                                                   |
GET /api/history -> history.list_all -> annotate available -> HistoryList
                                                   |
frontend HistoryPanel -> getHistory() -> render rows -> PreviewModal/Download
```
`available` is computed server-side at request time from `Path(path).exists()`,
so it reflects TTL cleanup without needing a cleanup hook into history.

## Risk

- `history.jsonl` grows unbounded. v1: acceptable for self-hosted. Log a count.
  Document in README. No auto-prune in scope.
- Moving `_media_type` to storage: update the one import in `routes.py`.
- Batch non-zip `source`: best-effort (None or first url). Acceptable.
