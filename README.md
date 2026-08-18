# Download Manager

English | [中文](README.zh-CN.md)

A self-hosted web app to download from multiple sources: direct HTTP(S) links,
videos/playlists from mainstream video sites (selectable quality), and
BitTorrent (magnet / .torrent). Paste a URL, pick options, download.

- **Backend**: Python + FastAPI, embedding [yt-dlp](https://github.com/yt-dlp/yt-dlp) (nightly) as a library.
- **Frontend**: React (Vite) SPA, served by the backend.
- **Downloads** run in an in-process threadpool with live progress (SSE); playlist
  selections are zipped; HTTP relay and BitTorrent have their own worker pools.
  Files are TTL-cleaned from disk.
- **Tabs**: an **HTTP** tab (server-as-relay direct downloads), a **Video** tab
  (cookies/proxy configured inline, with automatic cookie-availability checks),
  and a **BT** tab (magnet / .torrent via libtorrent).
- **History**: per-tab, paginated (10 per page), inline under each tab.
- **Theme & language**: dark/light/system theme toggle and 中文/English toggle (top-right);
  choices are remembered.

## Quick start (Docker)

Pre-built image on GHCR:

```bash
docker run -d -p 8000:8000 -v "$PWD/data:/data" \
  -e DATA_DIR=/data -e DOWNLOAD_DIR=/data/downloads \
  --name download-manager ghcr.io/senhao-xu/download-manager:latest
```

Or build from source:

```bash
git clone https://github.com/senhao-xu/download-manager.git
cd download-manager
docker compose up -d --build
# open http://localhost:8000, then open the Video tab's Settings to add cookies/proxy
```

Downloads are stored under `./data/downloads/` and auto-deleted after `TTL_MINUTES`.

## Video downloads need cookies (+ usually a proxy)

Most mainstream video sites block non-residential / datacenter IPs and require a
logged-in session for higher quality. For the **Video** tab to work well,
configure in the web UI:

1. Open the app and switch to the **Video** tab, then expand the **Settings**
   block above the URL box.
2. **Cookies** — export a `cookies.txt` from a logged-in browser session
   (use a "Get cookies.txt" browser extension), paste it into the Cookies box,
   and **Save cookies**. Cookie availability is verified automatically after
   saving (and whenever you enter the tab).
3. **Proxy** — enter an HTTP/SOCKS proxy that can reach the site (e.g.
   `http://host.docker.internal:7890` for a proxy on the host) and **Save**.
4. Click **Test** with a video URL to verify.

Settings are persisted under `DATA_DIR` (`/data` in Docker, `./data` locally) and
take effect immediately — no restart. Env vars `YTDLP_COOKIEFILE` / `YTDLP_PROXY`
are optional fallbacks. The runtime uses **node >= 22** (via NodeSource in Docker)
to solve JS challenges on some sites; deno 2.x and node < 22 are "unsupported" by
yt-dlp-ejs 0.8.0.

Some sites additionally expose their own cookies field in the tab's Settings
(stored separately from the global file) for content that needs a specific login.
When set, that file is used for that site's downloads; otherwise the global file
applies.

> Note: yt-dlp breakages against the larger sites are frequent. The image
> installs the **nightly** yt-dlp. If extraction suddenly fails, rebuild or bump
> yt-dlp: `pip install --pre -U yt-dlp`.

## Local development

```bash
# backend (Python 3.11+)
cd backend
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
pip install --pre -U yt-dlp          # nightly
uvicorn app.main:app --reload --port 8000

# system deps: ffmpeg, node >= 22 (for yt-dlp-ejs / JS challenges)

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

Most download settings (cookies, proxy) are edited inline in each tab's Settings
block, persisted to `DATA_DIR`. These env vars are defaults/fallbacks:

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
| `BT_MAX_CONCURRENT` | `1` | Concurrent BitTorrent download workers (separate pool from video/HTTP) |
| `BT_LISTEN_PORT` | `6881` | TCP+UDP port for BT peers/DHT (publish it for better connectivity) |

## API

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/info` | `{url}` | Video formats or playlist entries |
| POST | `/api/download` | `{url, quality}` | `{job_id}` |
| POST | `/api/download-batch` | `{urls[], quality}` | `{job_id}` |
| POST | `/api/download-http` | `{urls[]}` | `{job_id}` (HTTP relay download) |
| POST | `/api/download-bt` | `{magnet}` | `{job_id}` (BitTorrent magnet) |
| POST | `/api/download-bt/file` | multipart `.torrent` | `{job_id}` (BitTorrent file) |
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

- **Tabs** - a **Video** tab (paste a video/playlist URL, pick quality,
  download; cookies/proxy configured inline with automatic cookie checks), an
  **HTTP** tab (paste one or more direct HTTP(S) links; the server
  stream-downloads them through itself as a relay and serves the files, with
  live progress), and a **BT** tab (paste a magnet link or upload a `.torrent`
  file; downloads via BitTorrent with live progress). The selected tab is
  remembered.
- **BitTorrent** - magnet links and `.torrent` files via `libtorrent` (no
  seeding: the torrent is stopped as soon as it reaches 100%). BT runs on its own
  worker pool (`BT_MAX_CONCURRENT`) so it never blocks video/HTTP downloads, and
  a running BT job is exempt from the TTL cleanup. For best peer/DHT
  connectivity, publish port `BT_LISTEN_PORT` (TCP+UDP) in your compose/run
  config, e.g. add `-p 6881:6881/tcp -p 6881:6881/udp`.
- **Preview** - completed video/audio downloads play in-page (and images for the
  HTTP tab) without re-downloading.
- **History** - every completed download is recorded to `<DATA_DIR>/history.jsonl`
  and listed in the History panel; still-on-disk files can be re-previewed /
  re-downloaded, expired ones are greyed out. History survives restarts.
- **Theme** - dark / light / **system** (follows the OS preference and updates
  live); language toggle 中文 / English. Choices are remembered.

## Legal

Some platforms' terms of service prohibit or restrict downloading their content
unless they provide a download link. This project is intended for **personal use**.
You are responsible for compliance with applicable laws and each platform's terms
in your jurisdiction.
