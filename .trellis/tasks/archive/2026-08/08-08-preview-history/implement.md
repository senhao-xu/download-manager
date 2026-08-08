# Implement - YouTube preview + persistent history

Depends on child `08-08-header-tabs` being done (JobView extracted, tab shell).

## Execution checklist

### Backend - history store
- [ ] Create `backend/app/history.py` with `append(record)` and `list_all()`
      (thread-safe, JSONL, skip malformed lines).
- [ ] Add `HistoryEntry` + `HistoryList` to `backend/app/schemas.py`.
- [ ] Move `_media_type` from `routes.py` to `storage.py`; update `routes.py`
      import (`from .storage import _media_type` or a public `media_type`).
      Rename to `media_type` (drop leading `_`) since it's now shared/public.

### Backend - record on done
- [ ] In `jobs.py`, add `_record_history(job, kind, source, path, filename, mime)`
      helper (try/except + log on failure).
- [ ] Call it in `_run_single` (kind `youtube`, source=url, mime via media_type).
- [ ] Call it in `_run_batch` zip branch (one record for the zip).
- [ ] Call it in `_run_batch` non-zip branch (one record per saved file).
- [ ] Thread `url` into `_run_single` signature is already there; for batch,
      pass the batch url list/first url as source.

### Backend - route
- [ ] Add `GET /api/history` (response_model `HistoryList`) to `routes.py`,
      annotating `available` from `Path(path).exists()`.

### Backend - validate
- [ ] `cd backend && .venv/bin/python -c "from app.main import app"` imports
      cleanly.
- [ ] `curl /api/history` returns `{"items":[]}` initially.

### Frontend - preview
- [ ] Create `frontend/src/PreviewModal.tsx` (video/audio/unsupported).
- [ ] Add `mimeFromUrl(url)` helper + Play button in `JobView.tsx`; Play opens
      `PreviewModal` with `src=urls[0]`.
- [ ] Thumbnail in `YouTubeTab.tsx` single card: make it clickable to open
      preview (poster = thumbnail; needs a completed file - if none yet, ignore
      or just show poster image). Keep simple: Play only on completed job.

### Frontend - history
- [ ] Add `getHistory()` to `api.ts`; add `HistoryEntry`/`HistoryList` to
      `types.ts`.
- [ ] Create `frontend/src/HistoryPanel.tsx` (list + per-row Preview/Download
      gated on `available`; expired badge otherwise).
- [ ] Add a History button to the header toolbar in `App.tsx`; opens panel;
      refresh on open and after a download completes (lift a `historyVersion`
      counter or just re-fetch on open).

### Frontend - i18n + styles
- [ ] Add keys (zh+en): `preview`, `previewNotSupported`, `history`, `expired`,
      `reDownload`, `kindYoutube`, `kindHttp`, `noHistory`.
- [ ] Add `.preview-media`, history-row styles to `styles.css`.

### Validate
- [ ] `cd frontend && npm run build` passes.
- [ ] Manual: download a youtube video -> Play works -> history shows it ->
      reload -> history still there -> wait for TTL -> entry shows expired.
- [ ] `curl /api/history` after a download returns the record with
      `available:true`.

## Validation commands

```bash
cd backend && .venv/bin/python -c "from app.main import app; print('ok')"
cd frontend && npm run build
```

## Review gates

- After backend steps: grep that every `status="done"` site in `jobs.py` calls
  `_record_history` (zip + non-zip + single).
- `_media_type` rename: grep for old name; only `routes.py` referenced it.
- Frontend: no hardcoded strings; `t()` for every label (zh+en entries exist).

## Rollback

- Backend: revert `history.py`, schema additions, the route, and the call sites
  in `jobs.py` + the `_media_type` move. Single commit scope; no data migration
  (history.jsonl is a new file, deleting it is harmless).
- Frontend: revert the new components + JobView Play button + history button.
