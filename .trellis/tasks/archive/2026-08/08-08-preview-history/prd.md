# YouTube preview + persistent history

Parent: `08-08-tabs-preview-http` (R2). Depends on child `08-08-header-tabs`
for the tab shell + `JobView` extraction.

## Goal

1. Let the user **preview** a completed download in-page (video for mp4, audio
   for audio-only results) without leaving the app.
2. Keep a **persistent history** of completed downloads on disk so past downloads
   can be re-viewed / re-downloaded while the file still exists, and are visibly
   marked expired after TTL cleanup.

## Requirements

### Preview
- On a completed single-video job (`JobView` with `status === 'done'` and a
  media file), show a **Play** button alongside the existing Download button.
- Play opens an in-page media element in a modal/overlay:
  - `<video controls>` for video files (mp4/webm).
  - `<audio controls>` for audio-only results (mp3/m4a/ogg/opus).
  - For non-previewable types (zip, unknown), Play is hidden (download-only).
- The media `src` is the existing `/api/files/{job_id}` (or indexed URL for
  batch). The backend already sets the right `Content-Type` via `_media_type`.
- The info-card thumbnail is clickable to open a preview too (uses the
  thumbnail URL for the poster; for actual playback a download must exist).
- Previewing does NOT trigger a download; it streams via the file endpoint.

### History - backend
- A persistent index at `<DATA_DIR>/history.jsonl` (append-only JSON Lines).
  Each line is one record:
  ```json
  {"id":"<job_id>","kind":"youtube|http","title":"...","source":"<url>",
   "filename":"...","path":"<abs path under download_dir>","size":12345,
   "mime":"video/mp4","created":<unix ts>}
  ```
- A record is appended when a job reaches `done` with at least one file
  (YouTube single, each file of a non-zip batch, the zip of a zip-batch, and
  HTTP downloads from the sibling task).
- New module `backend/app/history.py` owns read/append. Thread-safe (lock),
  resilient to missing/corrupt file (skip bad lines).
- New routes:
  - `GET /api/history` -> list of records (newest first), each annotated with
    `available: bool` (file still on disk). Response model `HistoryList`.
- The existing `/api/files/{job_id}` and `/api/files/{job_id}/{index}` routes
  already serve files by job_id; history re-uses them for re-download/preview.
  No new file-serving route needed.
- TTL cleanup (`storage.cleanup_expired`) stays as-is; it removes job dirs. The
  history index is NOT cleaned by TTL (entries persist), but their `available`
  flag flips to false once the file is gone. (Optional: prune very old entries
  later; out of scope for v1.)

### History - frontend
- A **History** panel, shown in the YouTube tab (and HTTP tab) as a collapsible
  section or a third header affordance. Decision: a button in the toolbar /
  tab area opens a `HistoryPanel` (modal or inline card list).
- Each entry shows: title/source, kind badge, timestamp (relative + absolute),
  size, and actions:
  - **Preview** (if media-playable AND available) -> opens the same preview
    overlay, `src=/api/files/{id}`.
  - **Download** (if available) -> triggers `/api/files/{id}` download.
  - Expired entries: greyed, "expired" badge, actions disabled.
- History loads on mount of the panel (`GET /api/history`) and refreshes after a
  download completes.

### Persistence across restart
- On boot, `history.py` reads the existing `history.jsonl`. The in-memory list is
  the file contents. No DB.

## Acceptance Criteria

- [ ] Completed single-video YouTube download shows a Play button; clicking
      opens a `<video>` overlay playing `/api/files/{job_id}`.
- [ ] Audio-only result plays via `<audio>`.
- [ ] Zip / non-media results do not show Play.
- [ ] `GET /api/history` returns past downloads newest-first with correct
      `available` flags.
- [ ] A record is appended to `history.jsonl` on each successful download.
- [ ] History panel lists entries with title/source/kind/time/size and actions.
- [ ] Re-download from history works while the file exists.
- [ ] Re-preview from history works for media while the file exists.
- [ ] After TTL cleans a file, its history entry shows expired + disabled.
- [ ] Restarting the backend preserves history (re-read from `history.jsonl`).
- [ ] `npm run build` + backend boot both succeed; no 500s on history routes.

## Out of scope

- HTTP-specific download recording is wired in sibling task `08-08-http-download`
  (it calls the same `history.append` helper). This task delivers the helper +
  the YouTube call sites.
- Editing / deleting history entries manually.
- Pagination of history (load all; cap at a reasonable number if huge - log it).

## Notes

- History is shared across tabs (one index). The HTTP task will reuse
  `history.append` so all downloads appear together.
