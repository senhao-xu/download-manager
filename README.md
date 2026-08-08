# YouTube Downloader

A self-hosted web app to download YouTube videos (selectable quality) or a
selection of videos from a playlist. Paste a URL, pick a quality, download.

- **Backend**: Python + FastAPI, embedding [yt-dlp](https://github.com/yt-dlp/yt-dlp) (nightly) as a library.
- **Frontend**: React (Vite) SPA, served by the backend.
- **Downloads** run in an in-process threadpool with live progress (SSE); playlist
  selections are zipped. Files are TTL-cleaned from disk.
- **Settings UI**: configure YouTube cookies + proxy from the web page (no env editing),
  with a one-click cookie-availability check.
- **Theme & language**: dark/light theme toggle and 中文/English toggle (top-right);
  choices are remembered.

## Quick start (Docker)

Pre-built image on GHCR:

```bash
docker run -d -p 8000:8000 -v "$PWD/data:/data" \
  -e DATA_DIR=/data -e DOWNLOAD_DIR=/data/downloads \
  --name ytb-dl ghcr.io/senhao-xu/ytb-dl:latest
```

Or build from source:

```bash
git clone https://github.com/senhao-xu/ytb-dl.git
cd ytb-dl
docker compose up -d --build
# open http://localhost:8000, then click Settings to add cookies/proxy for YouTube
```

Downloads are stored under `./data/downloads/` and auto-deleted after `TTL_MINUTES`.

## ⚠️ YouTube requires cookies (+ usually a proxy)

YouTube blocks non-residential / datacenter IPs with a "Sign in to confirm you're
not a bot" wall, and is unreachable from some regions. For YouTube to work,
configure **both** in the web UI:

1. Open the app and click **Settings** (top-right).
2. **Cookies** — export a `cookies.txt` from a logged-in YouTube browser session
   (use a "Get cookies.txt" browser extension), paste it into the Cookies box,
   and **Save cookies**.
3. **Proxy** — enter an HTTP/SOCKS proxy that can reach YouTube (e.g.
   `http://host.docker.internal:7890` for a proxy on the host) and **Save**.
4. Click **Test** with a YouTube URL to verify.

Settings are persisted under `DATA_DIR` (`/data` in Docker, `./data` locally) and
take effect immediately — no restart. Env vars `YTDLP_COOKIEFILE` / `YTDLP_PROXY`
are optional fallbacks. The runtime uses **node >= 22** (via NodeSource in Docker)
to solve YouTube's JS challenge; deno 2.x and node < 22 are "unsupported" by
yt-dlp-ejs 0.8.0.

Without cookies/proxy, YouTube URLs return a clear "blocked as a bot" error;
non-YouTube sources supported by yt-dlp (e.g. archive.org) work without them.

> Note: yt-dlp breakages against YouTube are frequent. The image installs the
> **nightly** yt-dlp. If extraction suddenly fails, rebuild or bump yt-dlp:
> `pip install --pre -U yt-dlp`.

## Local development

```bash
# backend (Python 3.11+)
cd backend
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
pip install --pre -U yt-dlp          # nightly
uvicorn app.main:app --reload --port 8000

# system deps: ffmpeg, node >= 22 (for yt-dlp-ejs / YouTube's JS challenge)

# frontend (separate terminal)
cd frontend
npm install
npm run dev      # http://localhost:5173 (proxies /api -> :8000)
```

Build the frontend for the backend to serve:

```bash
cd frontend && npm run build      # outputs frontend/dist/, served by backend at /
```

## Configuration

Most YouTube-related settings are edited in the **Settings UI** (persisted to
`DATA_DIR`). These env vars are defaults/fallbacks:

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `8000` | Backend port |
| `DATA_DIR` | `./data` | Settings + cookies + downloads root |
| `DOWNLOAD_DIR` | `$DATA_DIR/downloads` | Where downloaded files are stored |
| `TTL_MINUTES` | `60` | Files older than this are deleted |
| `MAX_CONCURRENT` | `3` | Concurrent download workers |
| `YTDLP_COOKIEFILE` | _(none)_ | Fallback path to a `cookies.txt` (UI overrides) |
| `YTDLP_PROXY` | _(none)_ | Fallback HTTP/SOCKS proxy (UI overrides) |
| `YTDLP_IMPERSONATE` | _(none)_ | Browser TLS impersonation target (e.g. `chrome`) |
| `YTDLP_SLEEP_INTERVAL` | `0` | Delay between requests (anti-throttle) |

## API

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/info` | `{url}` | Video formats or playlist entries |
| POST | `/api/download` | `{url, quality}` | `{job_id}` |
| POST | `/api/download-batch` | `{urls[], quality}` | `{job_id}` |
| POST | `/api/download-http` | `{urls[]}` | `{job_id}` (HTTP relay download) |
| GET | `/api/jobs/{id}` | - | Job status snapshot |
| GET | `/api/jobs/{id}/events` | - | SSE progress stream |
| GET | `/api/files/{id}` | - | The downloaded file or zip |
| GET | `/api/files/{id}/{index}` | - | One file from a multi-file job |
| GET | `/api/history` | - | Past downloads with on-disk availability |
| GET | `/api/settings` | - | Current settings (no cookie content) |
| PUT | `/api/settings` | `{proxy, js_runtimes}` | Updated settings |
| PUT | `/api/settings/cookies` | raw `cookies.txt` text | `{cookies_configured}` |
| DELETE | `/api/settings/cookies` | - | `{cookies_configured}` |
| POST | `/api/settings/test` | `{url}` | `{ok, title, error}` connection check |
| POST | `/api/settings/check-cookies` | `{url}` | `{state, title, detail}` cookie-availability check |

`quality` is `"best"` (default) or a height like `"1080"`.

## Features

- **Tabs** - a **YouTube** tab (paste a video/playlist URL, pick quality,
  download) and an **HTTP** tab (paste one or more direct HTTP(S) links; the
  server stream-downloads them through itself as a relay and serves the files,
  with live progress). The selected tab is remembered.
- **Preview** - completed video/audio downloads play in-page (and images for the
  HTTP tab) without re-downloading.
- **History** - every completed download is recorded to `<DATA_DIR>/history.jsonl`
  and listed in the History panel; still-on-disk files can be re-previewed /
  re-downloaded, expired ones are greyed out. History survives restarts.
- **Theme** - dark / light / **system** (follows the OS preference and updates
  live); language toggle 中文 / English. Choices are remembered.

## Legal

YouTube's Terms of Service prohibit downloading content unless YouTube provides a
download link. This project is intended for **personal use**. You are responsible
for compliance with applicable laws and YouTube's ToS in your jurisdiction.
