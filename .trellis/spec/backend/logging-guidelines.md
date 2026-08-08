# Backend Logging Guidelines

> How logging is done in this project.

## Overview

Standard library `logging`. Each module gets its own logger:
`logger = logging.getLogger(__name__)` (e.g. `downloader`, `jobs`, `storage`).
Configured once in `main.py` via `logging.basicConfig(level=INFO)`.

uvicorn also emits access logs (`INFO: <ip> - "GET /api/..." 200 OK`).

## Log Levels

- **INFO** - normal lifecycle: app startup, cleanup sweeps (at most one line per
  sweep, not per file).
- **WARNING** - recoverable degradation: a TTL sweep failed but the thread
  keeps running; yt-dlp `no_warnings` are routed here via the `logger` opt.
- **ERROR / `.exception`** - a download job failed. Use `logger.exception(...)`
  so the traceback is captured, then swallow (the job status carries the
  friendly message to the UI).

## Structured Logging

No structured-logging library (no JSON formatter). Format is the
`basicConfig` default:

```
%(asctime)s %(levelname)s %(name)s: %(message)s
```

This is a personal/single-user app; plain text is fine. If scale ever matters,
swap in `structlog` without changing call sites.

## What to Log

- Job failures (with job id) - for post-hoc debugging.
- yt-dlp's own diagnostic output - it is given our `logger` via the `logger`
  YoutubeDL opt, so its warnings/errors land in `downloader` logs.
- Cleanup sweeps (info: which dir was removed).

## What NOT to Log

- **Cookies / cookie file contents.** Never log the cookies.txt body or the
  `cookiefile` path contents.
- **Full request bodies** (a pasted cookie could land there).
- Personal data from the video being downloaded (titles are fine; don't log
  user account info from cookies).
