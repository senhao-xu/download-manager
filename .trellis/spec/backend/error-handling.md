# Backend Error Handling

> How errors are caught, mapped, and returned.

## Overview

Two layers: (1) yt-dlp / runtime exceptions are caught at the route or worker
boundary and converted to friendly messages; (2) HTTP errors are returned as
FastAPI `HTTPException` with a `detail` string. The frontend renders `detail`.

## Error Types

No custom exception classes. The code deals in:
- `yt_dlp.utils.DownloadError` - raised by yt-dlp on extraction/download failure.
- `asyncio.TimeoutError` - from `asyncio.wait_for` on the test/check endpoints.
- Generic `Exception` - caught defensively in background workers.

## Error Handling Patterns

### HTTP errors (routes)

```python
from fastapi import HTTPException

# Client errors -> 4xx with a plain-language detail
raise HTTPException(status_code=400, detail="No URLs selected.")
raise HTTPException(status_code=404, detail="Job not found.")
```

- `400` for bad input / unsupported URL / yt-dlp extraction failure.
- `404` for unknown job / file-not-ready.
- Never return a 500 with a stack trace; catch and map.

### yt-dlp errors -> friendly messages

`DownloadError` (and any exception from `extract_info`/`download`) is passed
through `jobs._friendly_error(e)`, which pattern-matches the message to a
user-actionable hint:

```python
if "sign in to confirm" in low or "not a bot" in low:
    return "YouTube blocked the request as a bot. Open Settings ..."
```

Routes reuse the same helper via `_friendly(e)`.

### BitTorrent / libtorrent errors -> friendly messages

`bt_dl.download_sync` raises `RuntimeError` with a short cause; `jobs._friendly_error`
pattern-matches the libtorrent-specific failures (same helper, extended for BT):

```python
if "missing info-hash" in low or "invalid info-hash" in low:
    return "That magnet link has a missing or invalid info-hash. ..."
if "timed out fetching torrent metadata" in low:
    return "Timed out fetching torrent metadata. The magnet link may be dead ..."
```

BT failure modes worth a friendly mapping: invalid/corrupt `.torrent`, unreadable
`.torrent`, magnet metadata timeout (dead swarm), missing/invalid info-hash. Raw
libtorrent messages (e.g. `"missing info-hash from URI [libtorrent:22]"`) are not
user-actionable - always add a pattern rather than letting them fall through.

### Background workers (jobs)

Workers run in a threadpool and **must not raise** - they catch every exception
and set the job status:

```python
try:
    ...download...
    _set(job, status="done", ...)
except Exception as e:
    logger.exception("... failed for job %s", job.id)
    _set(job, status="error", error=_friendly_error(e), phase="error")
```

The job's `error` field surfaces to the UI via the SSE stream; the server stays
up. Errors are logged (`logger.exception`) before being swallowed.

## API Error Responses

All errors use FastAPI's default `{"detail": "..."}` JSON shape. The frontend
reads `detail` and shows it. No custom error envelope.

## Common Mistakes

- Returning raw exception strings (e.g. `'NoneType' object has no attribute`) as
  the user message - add a pattern to `_friendly_error`, or it falls back to the
  last non-empty line of the error.
- Letting a `DownloadError` propagate to uvicorn as a 500.
- Letting a background worker raise (would kill the worker thread silently).
