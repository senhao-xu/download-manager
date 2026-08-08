# Tabs, preview & history, HTTP download

## Goal

Evolve the single-purpose YouTube downloader into a multi-source downloader with
a tabbed UI: a **YouTube** tab (existing features + preview + persistent history)
and a new **HTTP** tab (stream-download arbitrary HTTP(S) direct links, with the
server acting as a download relay).

## Background

Today the app is a single YouTube-only page (`App.tsx`). Downloads are tracked in
an in-memory `_jobs` dict (`jobs.py`) and stored under `download_dir/<job_id>/`;
a TTL thread (`storage.py`) deletes files after `TTL_MINUTES` (default 60). There
is no persistent history and no way to preview a downloaded file - once the job
card is dismissed or the page reloads, the file is effectively lost (and gone for
real after TTL).

## Requirements

### R1 - Header tabs
- A tab bar under the header switches between **YouTube** and **HTTP** views.
- The chosen tab persists across reloads (localStorage, like theme/lang).
- Global controls (language, theme, settings) stay in the header and apply to both
  tabs. Settings modal is shared.
- The existing YouTube flow (URL -> info -> single/playlist -> download) is
  preserved as the YouTube tab's content, refactored into its own component.

### R2 - YouTube preview + history
- **Preview**: a completed single-video download can be played in-page via a
  `<video>` element pointing at `/api/files/{job_id}` (mp4 is browser-native).
  Thumbnail on the info card is also clickable to open a preview. Audio-only
  results play via `<audio>`.
- **History (persistent)**: every completed download (YouTube + HTTP) is recorded
  to a persistent index on disk under `DATA_DIR` (survives restart). The history
  lists title/source, type, time, and file size.
- From history, if the underlying file still exists (within TTL), the user can
  **re-preview** and **re-download** it. If the file was TTL-cleaned, the entry is
  shown as "expired/cleaned" (greyed out) and re-download is disabled.
- History is per-instance (single user, self-hosted) - no auth/multi-tenant.

### R3 - HTTP download (stream + relay)
- The HTTP tab takes one or more HTTP(S) direct URLs and stream-downloads each
  through the server (server fetches the remote, writes to `download_dir`,
  exposes the result via the existing `/api/files` mechanism).
- Progress is reported through the same job/SSE pipeline so the existing
  `JobView` component is reused.
- Filename is derived from the URL path / `Content-Disposition` when available,
  sanitized; size is read from `Content-Length` when present.
- The server-side fetch uses `curl_cffi` (already a dependency; supports browser
  TLS impersonation, useful for links that block plain clients) and respects the
  configured proxy from Settings.
- Completed HTTP downloads also appear in history and are previewable when the
  media type is browser-playable (image/video/audio); other types offer
  download-only.

### Non-goals
- No authenticated multi-user accounts.
- No HTTP range/resume (partial-content) download in v1; a fresh full download on
  retry is acceptable.
- No scheduling / queue prioritization beyond the existing threadpool.
- HTTP tab is not a general web proxy (it downloads files to disk, it does not
  proxy arbitrary browsing traffic).

## Acceptance Criteria

- [ ] Header shows YouTube / HTTP tabs; switching swaps the view and the choice
      survives a page reload.
- [ ] YouTube tab preserves all current behavior (info, single, playlist, zip,
      settings) - no regression.
- [ ] A completed YouTube single-video download shows a Play button that opens an
      in-page `<video>` preview; audio-only results play via `<audio>`.
- [ ] A persisted history list shows prior downloads (YouTube + HTTP) with
      title/source, type, timestamp, size.
- [ ] From history, a still-on-disk file can be re-previewed (media) and
      re-downloaded; an expired file is clearly marked and disabled.
- [ ] History survives a backend restart (re-read from disk).
- [ ] HTTP tab: submitting one or more HTTP URLs streams them through the server
      with live progress (JobView), produces downloadable files, and records
      them in history.
- [ ] HTTP download uses the configured proxy and curl_cffi; a link that 404s or
      fails shows a friendly error (no 500/traceback).
- [ ] `npm run build` succeeds; backend imports cleanly (`uvicorn app.main:app`
      boots); new env vars (if any) are documented in README.

## Subtask map

This is a parent task. Deliverables split into three independently verifiable
children:

1. `08-08-header-tabs` - the tab shell + YouTube-component refactor (R1).
2. `08-08-preview-history` - YouTube preview + persistent download history (R2).
3. `08-08-http-download` - HTTP stream-download module + tab content (R3).

Children 2 and 3 both depend on the tab shell from child 1 being in place (UI
land), but their backend work (history persistence, HTTP downloader) is
independent of each other. Ordering is written in each child's `implement.md`.

## Notes

- Keep `prd.md` focused on requirements and acceptance criteria.
- Technical design lives in `design.md`; execution plan in `implement.md`.
