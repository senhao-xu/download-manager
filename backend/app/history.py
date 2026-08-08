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
