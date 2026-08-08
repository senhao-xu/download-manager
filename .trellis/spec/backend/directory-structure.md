# Backend Directory Structure

> How backend code is organized in this project.

## Overview

The backend is a single FastAPI application under `backend/app/`. There is one
flat package (`app/`) with one module per concern - no nested packages, no
`routers/` subfolder. Routes live in `routes.py`; business logic in
`downloader.py` / `jobs.py` / `settings.py` / `storage.py`.

## Directory Layout

```
backend/
├── app/
│   ├── __init__.py        # package marker
│   ├── main.py            # FastAPI app, lifespan, CORS, StaticFiles mount
│   ├── config.py          # env-var Settings class (data_dir, port, etc.)
│   ├── schemas.py         # Pydantic request/response models
│   ├── routes.py          # all API routes (APIRouter, prefix /api)
│   ├── downloader.py      # yt-dlp wrapper (sync, run via run_blocking)
│   ├── jobs.py            # in-memory Job registry + ThreadPoolExecutor workers
│   ├── storage.py         # per-job temp dir + TTL cleanup thread
│   └── settings.py        # persisted user settings (cookies/proxy/js_runtimes)
├── requirements.txt
└── (no tests/ yet)
```

## Module Organization

- **One concern per module.** A new feature that needs request/response shapes
  adds them to `schemas.py`; a new endpoint goes in `routes.py`; a new yt-dlp
  interaction goes in `downloader.py`. Do not create a new module unless a
  genuinely new concern appears.
- **`routes.py` is thin.** Routes validate input (Pydantic), call a function in
  `downloader`/`jobs`/`settings`, and return. No business logic in routes.
- **Blocking work stays out of the event loop.** yt-dlp is synchronous; it is
  always wrapped in `run_blocking()` (threadpool). Async routes may `await` the
  result.

## Naming Conventions

- Files: `snake_case.py`.
- Pydantic models: `PascalCase` (e.g. `InfoResponse`, `JobStatus`).
- Functions: `snake_case`; private helpers prefixed `_` (e.g. `_friendly_error`).
- Route paths: `/api/<resource>` plural where it returns a collection
  (`/api/jobs`, `/api/settings`).
