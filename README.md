# Download Manager

English | [中文](README.zh-CN.md)

A self-hosted web app to download from multiple sources: direct HTTP(S) links,
YouTube videos/playlists (selectable quality), Bilibili videos/playlists, and
BitTorrent (magnet / .torrent). Paste a URL, pick options, download.

- **Backend**: Python + FastAPI, embedding [yt-dlp](https://github.com/yt-dlp/yt-dlp) (nightly) as a library.
- **Frontend**: React (Vite) SPA, served by the backend.
- **Downloads** run in an in-process threadpool with live progress (SSE); playlist
  selections are zipped; HTTP relay and BitTorrent have their own worker pools.
  Files are TTL-cleaned from disk.
- **Tabs**: an **HTTP** tab (server-as-relay direct downloads), a **YouTube** tab
  (cookies/proxy configured inline, with automatic cookie-availability checks),
  a **Bilibili** tab (single videos + multi-part/playlist, with its own cookies
  for 1080P+ / member content), and a **BT** tab (magnet / .torrent via libtorrent).
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
# open http://localhost:8000, then open the YouTube tab to add cookies/proxy
```

Downloads are stored under `./data/downloads/` and auto-deleted after `TTL_MINUTES`.

## ⚠️ YouTube requires cookies (+ usually a proxy)

YouTube blocks non-residential / datacenter IPs with a "Sign in to confirm you're
not a bot" wall, and is unreachable from some regions. For YouTube to work,
configure **both** in the web UI:

1. Open the app and switch to the **YouTube** tab, then expand the **Settings**
   block above the URL box.
2. **Cookies** — export a `cookies.txt` from a logged-in YouTube browser session
   (use a "Get cookies.txt" browser extension), paste it into the Cookies box,
   and **Save cookies**. Cookie availability is verified automatically after
   saving (and whenever you enter the YouTube tab).
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

## Bilibili: cookies unlock higher quality

Bilibili caps **anonymous** access at roughly 720P (often less); **1080P and above,
and 大会员 (VIP) content, require a logged-in account**. To unlock them, switch to
the **Bilibili** tab, expand **Settings**, and paste a `cookies.txt` exported from
a logged-in browser (it must include the `bilibili.com` domain, e.g. `SESSDATA`).
These are stored in a **separate** file from the global YouTube cookies. If no
Bilibili cookies are set, a global `cookies.txt` that already contains
`bilibili.com` is used as a fallback. Multi-part (分P) videos and collections are
supported via the checkbox list / batch download, same as YouTube playlists.

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

Most YouTube-related settings are edited inline in the **YouTube** tab's Settings
block (persisted to `DATA_DIR`). These env vars are defaults/fallbacks:

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `8000` | Backend port |
| `DATA_DIR` | `./data` | Settings + cookies + downloads root |
| `DOWNLOAD_DIR` | `$DATA_DIR/downloads` | Where downloaded files are stored |
| `TTL_MINUTES` | `60` | Files older than this are deleted |
| `MAX_CONCURRENT` | `3` | Concurrent download workers |
| `YTDLP_COOKIEFILE` | _(none)_ | Fallback path to a `cookies.txt` (UI overrides) |
| `YTDLP_BILIBILI_COOKIEFILE` | _(none)_ | Fallback path to a Bilibili `cookies.txt` (UI overrides) |
| `YTDLP_PROXY` | _(none)_ | Fallback HTTP/SOCKS proxy (UI overrides) |
| `YTDLP_IMPERSONATE` | _(none)_ | Browser TLS impersonation target (e.g. `chrome`) |
| `YTDLP_SLEEP_INTERVAL` | `0` | Delay between requests (anti-throttle) |
| `BT_MAX_CONCURRENT` | `1` | Concurrent BitTorrent download workers (separate pool from YouTube/HTTP) |
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
| POST | `/api/download-bilibili` | `{url, quality}` | `{job_id}` (Bilibili video) |
| POST | `/api/download-bilibili-batch` | `{urls[], quality}` | `{job_id}` (Bilibili multi-part/playlist) |
| GET | `/api/jobs/{id}` | - | Job status snapshot |
| GET | `/api/jobs/{id}/events` | - | SSE progress stream |
| GET | `/api/files/{id}` | - | The downloaded file or zip |
| GET | `/api/files/{id}/{index}` | - | One file from a multi-file job |
| GET | `/api/history` | - | Past downloads with on-disk availability |
| GET | `/api/settings` | - | Current settings (no cookie content) |
| PUT | `/api/settings` | `{proxy, js_runtimes}` | Updated settings |
| PUT | `/api/settings/cookies` | raw `cookies.txt` text | `{cookies_configured}` |
| DELETE | `/api/settings/cookies` | - | `{cookies_configured}` |
| PUT | `/api/settings/bilibili-cookies` | raw `cookies.txt` text | `{bilibili_cookies_configured}` |
| DELETE | `/api/settings/bilibili-cookies` | - | `{bilibili_cookies_configured}` |
| POST | `/api/settings/test` | `{url}` | `{ok, title, error}` connection check |
| POST | `/api/settings/check-cookies` | `{url}` | `{state, title, detail}` cookie-availability check |
| POST | `/api/settings/bilibili-check-cookies` | `{url}` | `{state, title, detail}` Bilibili cookie check |

`quality` is `"best"` (default) or a height like `"1080"`.

## Features

- **Tabs** - a **YouTube** tab (paste a video/playlist URL, pick quality,
  download), a **Bilibili** tab (paste a `bilibili.com` / `b23.tv` video or
  multi-part/collection URL, pick quality; own cookies for 1080P+ / member
  content), an **HTTP** tab (paste one or more direct HTTP(S) links; the
  server stream-downloads them through itself as a relay and serves the files,
  with live progress), and a **BT** tab (paste a magnet link or upload a
  `.torrent` file; downloads via BitTorrent with live progress). The selected
  tab is remembered.
- **BitTorrent** - magnet links and `.torrent` files via `libtorrent` (no
  seeding: the torrent is stopped as soon as it reaches 100%). BT runs on its own
  worker pool (`BT_MAX_CONCURRENT`) so it never blocks YouTube/HTTP downloads,
  and a running BT job is exempt from the TTL cleanup. For best peer/DHT
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

YouTube's Terms of Service prohibit downloading content unless YouTube provides a
download link, and Bilibili restricts access to its services through its own
terms. This project is intended for **personal use**. You are responsible for
compliance with applicable laws and each platform's terms in your jurisdiction.
