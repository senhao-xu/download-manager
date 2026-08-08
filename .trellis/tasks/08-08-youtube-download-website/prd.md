# YouTube Download Website

## Goal

Build a self-hosted web app where the user pastes a YouTube URL and downloads
the video (selectable quality) or a selection of videos from a playlist. This
task is the planning/research phase: implementation begins only after the final
planning summary below is explicitly approved.

## Background (Research Findings)

Greenfield project - no application code exists; `.trellis/spec/` backend +
frontend scaffolding is unfilled (bootstrap task `00-bootstrap-guidelines` still
open). No prescribed tech stack; it is ours to choose.

### Core downloader: yt-dlp

`yt-dlp` (Python, fork of youtube-dl) is the only credible foundation. Confirmed
from upstream docs:

- **Runtime**: Python 3.10+. Embeddable as a library (`from yt_dlp import
  YoutubeDL`), not just a CLI subprocess.
- **Hard deps for YouTube**:
  - `ffmpeg` / `ffprobe` - merges split DASH video + audio streams (1080p+ is
    served as separate video-only + audio-only tracks).
  - `yt-dlp-ejs` + a JS runtime (deno recommended) - "Required for full YouTube
    support"; YouTube now requires executing JS to derive some player
    signatures.
- **Anti-blocking knobs**: `--proxy`, `--impersonate` (browser TLS/JA3 mimic via
  curl_cffi), `--sleep-requests` / `--sleep-interval`, `--throttled-rate`. PO
  tokens increasingly required for some content.
- **Channel**: upstream recommends **nightly**; stable is "often stale and prone
  to external breakage." Must pin nightly / auto-update.
- **Embedding model**: fresh `YoutubeDL(opts)` per job (not reentrant/global);
  `extract_info(url, download=False)` for metadata; `progress_hooks` for
  progress; catch `yt_dlp.utils.DownloadError`; pass a logger for diagnostics.

### Architectural patterns considered

| Pattern | How | Pros | Cons |
|---|---|---|---|
| A. Sync store-and-forward | inline yt-dlp, write disk, return file | simplest; reliable | blocks worker; storage/bandwidth |
| B. Async queue + progress | enqueue -> worker -> SSE/poll -> link | decouples; scales; live progress | more moving parts |
| C. Streaming proxy | pipe yt-dlp to response, no disk | no storage | breaks on A/V merge; slow clients fail |

Chosen: a **hybrid of A + B-light** - metadata extraction is synchronous;
downloads run in an in-process background worker (threadpool, since yt-dlp is
blocking) with job IDs + SSE progress + local-disk store-and-forward. Avoids a
full Redis queue while giving live progress and bounded batch jobs. (See
`design.md`.)

### Stack choice

- Backend: **Python + FastAPI** (native yt-dlp embed, async endpoints, SSE).
- Frontend: **React (Vite)** - matches the spec scaffolding's React-style guides.
- Runtime image: Python + ffmpeg + deno + yt-dlp nightly.

## Legal / Risk Considerations

YouTube ToS prohibits downloading unless YouTube shows a download link; a
**public** service carries real ToS/legal exposure (youtube-dl was RIAA-DMCA'd
in 2020, later restored). Scope here is **personal/private**, which keeps this
exposure low. This is a user-owned risk posture, confirmed by the scale decision.

## Key Decisions

1. **Usage scale = personal / small-scale self-hosted** (user-confirmed). Keeps
   the site low-risk and skips proxy-pool / PO-token / rate-limit infra.
2. **Tech stack**: Python 3.11 + FastAPI backend; React (Vite) frontend; Docker
   runtime with ffmpeg + deno + yt-dlp nightly.
3. **Download architecture**: metadata via sync `extract_info`; downloads via an
   in-process background worker (threadpool executor) with job IDs, SSE progress,
   local-disk storage, and TTL cleanup. No Redis/queue for v1.
4. **Content scope** (user-confirmed): video **mp4** (default) + **selectable
   quality/format** + **playlist support**. Audio-only (mp3) deferred (cheap to
   add later via `-x`).
5. **Playlist interaction** (user-confirmed): parse playlist -> list all videos
   -> user selects single / multiple / all -> download; multi-select packaged as
   a zip.
6. **Anti-blocking**: yt-dlp defaults only (`--impersonate`, sensible sleep
   intervals).
7. **Host exposure** (defaulted, confirmable): localhost/LAN first. If exposed
   to the internet later, add basic auth + a reverse proxy (Caddy/nginx) as a
   deployment step - not core app logic.

## Requirements

- Web UI: paste a YouTube URL (single video or playlist), trigger download.
- Backend embeds yt-dlp (nightly) for metadata + download; ffmpeg + node>=22 in
  the runtime image (node, not deno - deno 2.x / node<22 are "unsupported" by
  yt-dlp-ejs for YouTube's JS challenge).
- Single video: return available formats; user picks quality; download with live
  progress (0-100%) via SSE; serve the merged mp4; clean up after.
- Playlist: list entries; user selects single/multiple/all. Default returns each
  video as a separate mp4 (order-prefixed: `01 - title.mp4`); an optional "Package
  as zip" toggle bundles them into one zip. Live per-file progress.
- Settings UI: user configures YouTube cookies (cookies.txt paste), proxy, and JS
  runtime from the web page; persisted under DATA_DIR, takes effect immediately.
  Includes a cookie-availability check and a connection test.
- Dark/light theme + zh/en language toggles, persisted.
- Downloaded files are deleted after delivery or a TTL (disk stays bounded).
- Graceful errors for invalid URLs, private/age-restricted content, or YouTube
  blocking (surface yt-dlp's error to the UI, no crash).

## Acceptance Criteria

- [x] Pasting a public video URL returns title + available formats within a few
      seconds (`extract_info(download=False)`).
- [x] User can select a quality/format and start a download; UI shows live
      progress 0-100% via SSE.
- [x] Finished mp4 downloads and plays correctly (A/V merged via ffmpeg for
      1080p+).
- [x] Pasting a playlist URL lists its videos with per-item selection (single /
      multiple / all).
- [x] Multi-select playlist downloads default to separate mp4 files (order-
      prefixed); the optional zip toggle produces a single zip of the chosen
      videos; single-select downloads the file directly.
- [x] Invalid / unsupported URLs show a clear error, not a crash.
- [x] Files are deleted from disk after delivery or a TTL; disk does not grow
      unbounded across many uses.
- [x] YouTube bot-wall is surfaced with an actionable message pointing to the
      Settings UI; cookies + proxy configurable from the web page and verified
      via a one-click check.
- [x] Dark/light theme and zh/en language toggles work and persist.

## Out of Scope (v1)

- Public multi-user service, proxy rotation, PO-token infra, rate limiting.
- User accounts / download-history persistence.
- Object storage (S3/R2); local disk only.
- Audio-only (mp3) extraction (deferred - cheap to add).
- Subtitles / metadata embedding / SponsorBlock.

## Deferred / Non-blocking Items

- mp3 audio-only output (trivial via `-x`).
- Internet exposure path (reverse proxy + basic auth) - deployment step, not v1
  core.
- Swapping the in-memory job store for SQLite/Redis if scale or restart-safety
  ever matters.
