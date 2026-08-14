"""Persistent download history (append-only JSONL at <DATA_DIR>/history.jsonl).

One record per completed download. Read by the `/api/history` route, written by
job workers when a download reaches `done`. The index is never pruned by TTL;
entries persist and their `available` flag is computed at read time from whether
the file still exists on disk.
"""
import json
import logging
import threading
import time
from pathlib import Path

from .config import settings as cfg

logger = logging.getLogger("history")

_lock = threading.Lock()


def _path() -> Path:
    return cfg.data_dir / "history.jsonl"


def append(record: dict) -> None:
    """Append one history record. Adds `created` if missing.

    Called from worker threads. Safe to call repeatedly; a write failure is
    logged but never re-raised (history must not break a download).
    """
    rec = {**record}
    rec.setdefault("created", time.time())
    try:
        with _lock:
            cfg.data_dir.mkdir(parents=True, exist_ok=True)
            with _path().open("a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:
        logger.exception("failed to append history record for job %s", rec.get("id"))


def list_all() -> list[dict]:
    """Read all records, newest-first. Skips malformed lines."""
    p = _path()
    if not p.exists():
        return []
    out: list[dict] = []
    with _lock:
        with p.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    logger.warning("skipping malformed history line: %r", line[:120])
                    continue
    out.reverse()  # newest first (file is append-order = oldest first)
    if out:
        logger.info("history loaded: %d records", len(out))
    return out


def delete_by_id(job_id: str) -> dict | None:
    """Remove all records with the given `id`, returning the first deleted record.

    JSONL is append-only, so this rewrites the whole file minus the removed
    lines. Returns the removed record (with its `path`) so the caller can also
    delete the on-disk file if requested; None if no record matched.
    """
    recs = list_all()
    kept = [r for r in recs if r.get("id") != job_id]
    removed = next((r for r in recs if r.get("id") == job_id), None)
    if removed is None:
        return None
    # list_all returns newest-first; write oldest-first (append order) back.
    with _lock:
        cfg.data_dir.mkdir(parents=True, exist_ok=True)
        with _path().open("w", encoding="utf-8") as f:
            for r in reversed(kept):
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
    return removed


def list_page(kind: str | None = None, page: int = 1, page_size: int = 10):
    """Return a (page_records, total) slice of the newest-first records.

    `kind` filters by the record's `kind` field ("youtube" | "http" | "bt");
    a record with a missing/non-matching kind is excluded when a filter is set.
    `page` is 1-indexed; `page_size` is clamped to [1, 100]. total is the count
    AFTER filtering (so callers can render "page X / ceil(total/page_size)").
    """
    recs = list_all()
    if kind:
        recs = [r for r in recs if r.get("kind") == kind]
    total = len(recs)
    page = max(1, page)
    page_size = max(1, min(page_size, 100))
    start = (page - 1) * page_size
    return recs[start:start + page_size], total
