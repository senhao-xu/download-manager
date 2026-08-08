# Backend Quality Guidelines

> Code quality standards for backend development.

## Overview

Python 3.11+ / FastAPI. No linter is wired into CI yet, but code is expected to
follow these conventions. Type hints are used on all function signatures and
module-level constants.

## Forbidden Patterns

- **Calling yt-dlp on the event loop.** yt-dlp is synchronous/blocking. Always
  go through `run_blocking()` (threadpool). A route that does
  `ydl.extract_info(...)` inline will stall the server under load.
- **Mutating `Job` without the lock.** Job fields are read by the SSE route
  while workers write them. Use `_set(job, **kw)` (acquires `_lock`).
- **Globbing the whole download dir to find outputs.** A batch job dir holds
  multiple videos; globbing returns other videos' files (caused a real
  duplication bug). Use the before/after diff in `downloader._new_files`.
- **`--pre` in requirements for non-yt-dlp packages.** It pulls beta deps
  (e.g. pydantic beta). yt-dlp nightly is pinned explicitly instead.
- **Hardcoding secrets / cookies in code.** Cookies live in `DATA_DIR/cookies.txt`
  (user-pasted via Settings); proxy via Settings/env. Never commit them.

## Required Patterns

- **Type hints** on every function signature and public attribute.
  Use `X | None` (PEP 604) syntax, not `Optional[X]`.
- **Pydantic models** (`schemas.py`) for all request bodies and responses.
  Routes declare `response_model=` so the contract is enforced.
- **Env config via `config.py`** (`Settings` class). User-mutable runtime config
  (cookies/proxy) goes through `settings.py`, not env.
- **Friendly errors** through `_friendly_error` for anything yt-dlp raises.
- **`logger` per module** (`logging.getLogger(__name__)`), not `print`.

## Testing Requirements

No formal test suite yet. Verification is done via:
- `curl` against the running API (`/api/info`, `/api/download`, `/api/settings/*`).
- `ffprobe` to confirm merged mp4 validity.
- A Playwright smoke test (`frontend/*-smoke.mjs`, ad-hoc) for UI flows.

When adding tests, mirror these: hit the real API, assert observable outcomes.

## Code Review Checklist

- [ ] yt-dlp calls wrapped in `run_blocking`?
- [ ] New endpoint has a Pydantic model + `response_model`?
- [ ] Errors caught and mapped (no 500 with a traceback)?
- [ ] Job mutations go through `_set` (locked)?
- [ ] No `.venv`/`data`/`node_modules` committed?
- [ ] README/config table updated if a new env var was added?
