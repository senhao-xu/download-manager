# Backend Database Guidelines

> Database patterns and conventions for this project.

## Overview

**There is no database.** All state is in-memory and on the local filesystem:

| State | Location | Notes |
|---|---|---|
| Active jobs | `_jobs: dict[job_id, Job]` in `jobs.py` | in-memory; lost on restart |
| Downloaded files | `DATA_DIR/downloads/<job_id>/` | TTL-cleaned by `storage` |
| User settings | `DATA_DIR/settings.json` | cookies/proxy/js_runtimes |
| YouTube cookies | `DATA_DIR/cookies.txt` | Netscape format, user-pasted |

This is intentional for a personal/self-hosted tool - no DB ops, no migrations,
trivial backup (copy `DATA_DIR`).

## If a DB Is Ever Needed

If restart-safety or history becomes a requirement (deferred item in the PRD),
the migration path is:

- Jobs -> SQLite (`sqlite3` stdlib, no ORM needed) or Redis.
- Settings -> SQLite (replace `settings.json`).
- Keep the in-memory `Job` as the hot cache; persist on transition.

Do not introduce an ORM for a single-table use case; `sqlite3` + SQL is enough.

## Common Mistakes

- Treating the in-memory `Job` as durable - it isn't. A restart drops all
  active jobs (the file on disk remains until TTL).
- Writing to `settings.json` without the lock (`settings._lock`) - the SSE
  reader and the writer can race.
