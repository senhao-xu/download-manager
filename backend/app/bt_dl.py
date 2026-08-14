"""BitTorrent downloader (magnet links + .torrent files).

Synchronous download of one torrent using ``libtorrent``. Mirrors the
``http_dl.download_sync`` contract: it is blocking, runs in the BT worker
ThreadPoolExecutor (never on the event loop), and reports byte progress through
the same yt-dlp-shaped progress-hook dict so ``jobs.py`` translates it to
``job.progress`` unchanged.

Seeding policy: the torrent is stopped (``session.remove_torrent``) the instant it
reaches 100%. No seeding, no long-running "seeding" phase - the worker releases
its slot as soon as the files are on disk. Downloaded files are kept (the
``session.delete_files`` flag is NOT set) so they can be served.

One ``lt.session()`` is created per call for isolation. Acceptable because the BT
executor defaults to a single worker; if raised, a shared module-level session
would be worth revisiting.
"""
import logging
import time
from pathlib import Path

import libtorrent as lt

from .config import settings as cfg
from .errors import JobCancelled

logger = logging.getLogger("bt_dl")

# Poll interval for both the metadata wait and the download loop. Keeps the
# worker responsive to cancellation without busy-spinning.
_POLL_MS = 500


def _is_magnet(source: str) -> bool:
    s = source.strip().lower()
    return s.startswith("magnet:?") and "xt=urn:btih:" in s


def _listen_interfaces() -> str:
    """libtorrent listen string for the configured port (IPv4 + IPv6)."""
    port = cfg.bt_listen_port
    return f"0.0.0.0:{port},[::]:{port}"


def _add_torrent(ses: lt.session, source: str, dest_dir: Path) -> lt.torrent_handle:
    """Add a magnet link or .torrent file to the session, return its handle.

    Raises ``RuntimeError`` with a friendly message on invalid input.
    """
    if _is_magnet(source):
        params = lt.parse_magnet_uri(source)
        params.save_path = str(dest_dir)
        return ses.add_torrent(params)
    # Treat as a .torrent file path.
    p = Path(source)
    if not p.is_file():
        raise RuntimeError("That .torrent file could not be read (not found).")
    try:
        info = lt.torrent_info(str(p))
    except Exception as e:  # libtorrent raises various RuntimeError/ValueError
        raise RuntimeError(f"That .torrent file is invalid or corrupt: {e}") from e
    params = lt.add_torrent_params()
    params.ti = info
    params.save_path = str(dest_dir)
    return ses.add_torrent(params)


def _wait_for_metadata(ses: lt.session, handle: lt.torrent_handle, cancel_event=None) -> None:
    """Block until the torrent's metadata is available (magnet links only).

    Raises ``JobCancelled`` if ``cancel_event`` is set, or ``RuntimeError`` if
    metadata does not arrive within ``bt_no_data_timeout`` (a dead swarm never
    delivers the .torrent metadata). Pause is intentionally NOT honored here - the
    torrent has not started downloading yet.
    """
    deadline = time.monotonic() + cfg.bt_no_data_timeout
    while not handle.status().has_metadata:
        if cancel_event is not None and cancel_event.is_set():
            raise JobCancelled()
        if time.monotonic() > deadline:
            raise RuntimeError(
                "Timed out fetching torrent metadata. The magnet link may be "
                "dead (no peers) or the swarm is unreachable."
            )
        ses.wait_for_alert(_POLL_MS)


def _file_list(handle: lt.torrent_handle, dest_dir: Path) -> list[Path]:
    """Absolute paths of the torrent's files, sorted by name.

    Single-file torrents write directly into ``dest_dir``; multi-file torrents
    create ``dest_dir/<torrent_name>/``. This returns the real on-disk files.
    """
    ts = handle.status()
    info = ts.torrent_file if hasattr(ts, "torrent_file") else handle.get_torrent_info()
    if info is None:
        # No metadata - should not happen here (we waited for it), but be safe.
        return [p for p in dest_dir.iterdir() if p.is_file()]
    files = info.files()
    out = []
    for i in range(files.num_files()):
        rel = files.file_path(i)
        fp = dest_dir / rel
        if fp.exists():
            out.append(fp)
    # Fallback: if libtorrent's file list is empty for some reason, scan the dir.
    if not out:
        out = _scan_media(dest_dir)
    out.sort(key=lambda p: p.name)
    return out


def _scan_media(root: Path) -> list[Path]:
    """Recursively list regular files under ``root`` (fallback for _file_list)."""
    if not root.exists():
        return []
    return [p for p in root.rglob("*") if p.is_file()]


def download_sync(source: str, dest_dir: Path, progress_hook, cancel_event=None, pause_event=None) -> tuple[str, Path, int, str]:
    """Download one torrent (magnet link or .torrent file path) into ``dest_dir``.

    Returns ``(name, path, size, mime)``:
      - single-file torrent: ``name`` is the file's name, ``path`` is the file.
      - multi-file torrent: ``name`` is the torrent's name, ``path`` is the
        folder created under ``dest_dir``; the caller scans the folder for the
        indexed file list.

    ``progress_hook`` receives yt-dlp-shaped dicts
    (``{"status", "downloaded_bytes", "total_bytes"}``) so the existing
    ``jobs.py`` hook logic works unchanged. Raises ``JobCancelled`` if
    ``cancel_event`` is set, or ``RuntimeError`` (mapped to a friendly message by
    the caller via ``_friendly_error``) on invalid magnet / unreadable torrent /
    metadata timeout.

    ``pause_event`` (BT only) pauses the torrent: the loop calls ``handle.pause()``
    and blocks until cleared, then ``handle.resume()`` and resets the stall timer.
    All libtorrent calls stay on this worker thread (the loop owns the session).
    """
    ses = lt.session({"listen_interfaces": _listen_interfaces()})
    try:
        handle = _add_torrent(ses, source, dest_dir)
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError(f"Could not start the torrent: {e}") from e

    try:
        if _is_magnet(source):
            _wait_for_metadata(ses, handle, cancel_event=cancel_event)

        status = handle.status()
        info = status.torrent_file if hasattr(status, "torrent_file") else handle.get_torrent_info()
        torrent_name = info.name() if info is not None else dest_dir.name
        total = int(status.total_wanted) if status.total_wanted else 0

        # Download loop: emit progress on real byte movement only (avoid flooding
        # the SSE channel while stalled waiting for peers).
        #
        # Two deadlines guard against a torrent that never makes progress, so a
        # dead swarm can't occupy the (single) BT worker forever:
        #   - first_data_deadline: no bytes at all within bt_no_data_timeout
        #     after metadata resolves (peers never connected / never sent).
        #   - stall deadline: reset whenever new bytes arrive; if no movement
        #     for bt_stall_timeout the swarm has gone quiet mid-download.
        prev_done = -1
        first_data_deadline = time.monotonic() + cfg.bt_no_data_timeout
        stall_deadline = first_data_deadline
        saw_data = False
        # Whether the torrent is currently paused (BT-only pause/resume). The
        # first iteration after pause_event is set calls handle.pause() and emits
        # "paused"; the first iteration after it clears calls handle.resume() and
        # emits "resumed", resetting the stall timers so the pause is never
        # mistaken for a dead swarm.
        did_pause = False
        while not handle.status().is_finished:
            # Honor pause (BT only): pause the torrent, block until cleared or
            # cancelled, then resume. While paused this `continue`s before the
            # deadline checks below, so the stall/first-data timers never fire.
            if pause_event is not None and pause_event.is_set():
                if not did_pause:
                    handle.pause()
                    progress_hook({"status": "paused"})
                    did_pause = True
                if cancel_event is not None and cancel_event.is_set():
                    raise JobCancelled()
                ses.wait_for_alert(_POLL_MS)  # 500ms sleep, no busy-spin
                continue
            if did_pause:
                handle.resume()
                progress_hook({"status": "resumed"})
                did_pause = False
                # A long pause must not be mistaken for a stall / no-first-data.
                stall_deadline = time.monotonic() + cfg.bt_stall_timeout
                if not saw_data:
                    first_data_deadline = stall_deadline

            s = handle.status()
            done = int(s.total_wanted_done)
            if done != prev_done:
                if done > 0:
                    # Any new bytes: this is the first-data check satisfied and
                    # the stall timer refreshed.
                    saw_data = True
                    stall_deadline = time.monotonic() + cfg.bt_stall_timeout
                progress_hook({
                    "status": "downloading",
                    "downloaded_bytes": done,
                    "total_bytes": int(s.total_wanted) or total,
                    "filename": torrent_name,
                })
                prev_done = done
            now = time.monotonic()
            if not saw_data and now > first_data_deadline:
                raise RuntimeError(
                    "Timed out waiting for the torrent to start downloading. "
                    "No peers sent data - the swarm may be dead or unreachable."
                )
            if saw_data and now > stall_deadline:
                raise RuntimeError(
                    "The download stalled (no progress for "
                    f"{cfg.bt_stall_timeout}s). The swarm went quiet; it may "
                    "resume later, but it can't block the downloader."
                )
            ses.wait_for_alert(_POLL_MS)

        progress_hook({"status": "finished"})

        files = _file_list(handle, dest_dir)
        if not files:
            raise RuntimeError("Download finished but no output file was produced.")

        # Determine single vs multi-file. libtorrent writes single-file torrents
        # directly into save_path; multi-file into save_path/<name>/.
        is_single = len(files) == 1 and files[0].parent.resolve() == dest_dir.resolve()
        if is_single:
            f = files[0]
            try:
                size = f.stat().st_size
            except OSError:
                size = 0
            logger.info("bt download ok: %s -> %s (%d bytes)", source, f, size)
            return f.name, f, size, "application/octet-stream"
        # Multi-file: return the folder path; caller scans it for the indexed list.
        folder = dest_dir / torrent_name
        if not folder.is_dir():
            # libtorrent may have placed files differently; use the common parent.
            folder = files[0].parent
        total_size = 0
        for fp in files:
            try:
                total_size += fp.stat().st_size
            except OSError:
                pass
        logger.info("bt download ok (multi): %s -> %s (%d files, %d bytes)",
                    source, folder, len(files), total_size)
        return torrent_name, folder, total_size, "application/octet-stream"
    finally:
        # Stop the torrent without deleting files. No seeding. ``remove_torrent``
        # default flags keep the downloaded data on disk.
        try:
            ses.remove_torrent(handle)
        except Exception:  # pragma: no cover - defensive: already removed/errored
            pass
