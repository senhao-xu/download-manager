"""Persistent download history (append-only JSONL at <DATA_DIR>/history.jsonl).

One record per completed download. Read by the `/api/history` route, written by
job workers when a download reaches `done`. The index is never pruned by TTL;
entries persist and their `available` flag is computed at read time from whether
the file still exists on disk.
"""
import hashlib
import json
import logging
import os
import tempfile
import threading
import time
from collections.abc import Callable
from pathlib import Path

from .config import settings as cfg
from .thumbnails import youtube_video_id

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


def _read_unlocked() -> list[dict]:
    p = _path()
    if not p.exists():
        return []
    out: list[dict] = []
    with p.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
                if isinstance(record, dict):
                    out.append(record)
            except json.JSONDecodeError:
                logger.warning("skipping malformed history line: %r", line[:120])
    out.reverse()  # newest first (file is append-order = oldest first)
    if out:
        logger.info("history loaded: %d records", len(out))
    return out


def list_all() -> list[dict]:
    """Read all records, newest-first. Skips malformed lines."""
    with _lock:
        return _read_unlocked()


def _write_unlocked(records: list[dict]) -> None:
    """Replace the index atomically; caller holds the read/modify/write lock."""
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=cfg.data_dir,
                                         prefix=".history-", delete=False) as f:
            temporary = Path(f.name)
            for record in reversed(records):
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
        os.replace(temporary, _path())
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def record_key(record: dict) -> str:
    """Stable per-file identity for existing JSONL records; no migration needed."""
    identity = {name: record.get(name) for name in ("id", "kind", "path", "filename", "created", "source")}
    return hashlib.sha256(json.dumps(identity, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def find_by_key(key: str) -> dict | None:
    return next((record for record in list_all() if record_key(record) == key), None)


def record_path(record: dict) -> Path:
    """Resolve a file strictly inside its own job directory, including symlinks."""
    job_id = record.get("id") or ""
    if not isinstance(job_id, str) or not job_id or Path(job_id).name != job_id or job_id in {".", ".."}:
        raise ValueError("Invalid job directory")
    root = cfg.download_dir.resolve()
    job_root = (root / job_id).resolve()
    path = Path(record.get("path") or "").resolve()
    if job_root.parent != root or job_root not in path.parents:
        raise ValueError("File is outside its job directory")
    return path


def delete_by_keys(keys: list[str], delete_files: bool = False,
                   is_active: Callable[[str], bool] | None = None) -> dict:
    """Delete precise records in one locked transaction, reporting each outcome."""
    wanted = set(keys)
    with _lock:
        records = _read_unlocked()
        selected = {record_key(record): record for record in records if record_key(record) in wanted}
        removed, failed = [], []
        shared_paths = set()
        if delete_files:
            for record in records:
                if record_key(record) not in wanted and record.get("path"):
                    try:
                        shared_paths.add(Path(record["path"]).resolve())
                    except (OSError, ValueError, RuntimeError):
                        pass
        for key, record in selected.items():
            reason = None
            if delete_files:
                try:
                    path = record_path(record)
                    if is_active is not None and is_active(record["id"]):
                        reason = "active_job"
                    elif path in shared_paths:
                        reason = "shared_file"
                    else:
                        path.unlink(missing_ok=True)
                except (ValueError, RuntimeError):
                    reason = "invalid_path"
                except OSError:
                    logger.warning("failed to remove history file for %s", key, exc_info=True)
                    reason = "delete_failed"
            if reason:
                failed.append({"key": key, "reason": reason})
            else:
                removed.append(key)
        if removed:
            removed_keys = set(removed)
            _write_unlocked([record for record in records if record_key(record) not in removed_keys])
        return {"removed": removed, "missing": sorted(wanted - selected.keys()), "failed": failed}


def delete_by_id(job_id: str) -> dict | None:
    """Remove all records with the given `id`, returning the first deleted record.

    JSONL is append-only, so this rewrites the whole file minus the removed
    lines. Returns the removed record (with its `path`) so the caller can also
    delete the on-disk file if requested; None if no record matched.
    """
    with _lock:
        recs = _read_unlocked()
        removed = next((r for r in recs if r.get("id") == job_id), None)
        if removed is not None:
            _write_unlocked([r for r in recs if r.get("id") != job_id])
        return removed


def available_video_ids() -> set[str]:
    """Only skip completed YouTube downloads whose local file still exists."""
    return {
        video_id for record in list_all()
        if record.get("kind") == "youtube"
        and (video_id := youtube_video_id(record.get("source")))
        and record.get("path") and Path(record["path"]).is_file()
    }


def list_page(kind: str | None = None, page: int = 1, page_size: int = 10):
    """Return a (page_records, total) slice of the newest-first records.

    `kind` filters by the record's `kind` field ("youtube" | "http" | "bt");
    a record with a missing/non-matching kind is excluded when a filter is set.
    `page` is 1-indexed; `page_size` is clamped to [1, 100]. total is the count
    AFTER filtering (so callers can render "page X / ceil(total/page_size)").
    """
    recs = list_all()
    # Identical repeated records represent the same selectable file.
    unique = {}
    for record in recs:
        unique.setdefault(record_key(record), record)
    recs = list(unique.values())
    if kind:
        recs = [r for r in recs if r.get("kind") == kind]
    total = len(recs)
    page = max(1, page)
    page_size = max(1, min(page_size, 100))
    start = (page - 1) * page_size
    return recs[start:start + page_size], total
