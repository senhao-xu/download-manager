# Design - BT download module

## Architecture & boundaries

A fourth download "kind" (`bt`) is added as a parallel engine, mirroring the
`http_dl.py` -> `_run_http` pattern. No changes to the job model, SSE transport,
file-serving routes, or history schema beyond the `kind="bt"` value.

```
magnet / .torrent
        │
   POST /api/download-bt  (JSON)      ──┐
   POST /api/download-bt/file (multipart)┤
                                         ▼
                              routes.py  post_download_bt*
                                         │  creates Job, writes .torrent to job dir
                                         ▼
                              jobs.start_bt(source)  ──submit──►  _bt_executor (DEDICATED pool)
                                                                         │
                                                                         ▼
                              jobs._run_bt(job, source)
                                         │  builds hook(ev) closure (reuse)
                                         ▼
                              bt_dl.download_sync(source, dest_dir, hook)
                                         │  libtorrent session, add_torrent,
                                         │  poll alerts -> hook dict, wait is_finished
                                         │  remove_torrent (no seeding)
                                         ▼
                              files on disk in job dir
                                         │
                          snapshot() ──► /api/files/{job_id}[/{i}]  (existing routes)
                                         │
                              history.append(kind="bt", …)
```

Boundaries:
- `bt_dl.py` knows ONLY about libtorrent + the hook contract + dest_dir. No job
  model, no FastAPI. Pure synchronous function. (matches `http_dl.py` boundary)
- `jobs.py` owns the Job lifecycle + the dedicated executor + the `_run_bt`
  worker. It does not import libtorrent.
- `routes.py` owns HTTP parsing (JSON magnet + multipart .torrent) and delegates
  to `jobs.start_bt`.

## Contracts

### bt_dl.download_sync

```python
def download_sync(source: str, dest_dir: Path, progress_hook) -> tuple[str, Path, int, str]:
    """Download one torrent (magnet or .torrent file path) into dest_dir.

    source: "magnet:?xt=urn:btih:…" OR a path to a .torrent file.
    Returns (name, path, size, mime):
      - single-file torrent: name = file's name, path = dest_dir/<name>
      - multi-file torrent: name = torrent's name (folder created under dest_dir),
        path = dest_dir/<name> (the folder); the caller scans files via index.
    Emits progress_hook({"status":"downloading","downloaded_bytes":N,"total_bytes":S})
    and progress_hook({"status":"finished"}).
    Raises RuntimeError on invalid magnet / unreadable torrent / no metadata.
    """
```

The `(name, path, size, mime)` return shape matches `http_dl.download_sync`
(`http_dl.py:112`) so `_run_bt` mirrors `_run_http`'s file-recording logic.

For **multi-file torrents**: libtorrent creates `dest_dir/<torrent_name>/` with
files inside. `_run_bt` scans that folder (sorted) into the `files` list, each
served via indexed `/api/files/{job_id}/{i}`. `result_path`/`download_url` stay
`None` for multi-file (same as `_run_http` batch path, `jobs.py:307-318`).

### API

```
POST /api/download-bt            Body: {"magnet": "magnet:?xt=urn:btih:…"}  -> {"job_id"}
POST /api/download-bt/file       multipart/form-data, field "file"=<.torrent> -> {"job_id"}
```

Magnet validation: must start with `magnet:?` and contain `xt=urn:btih:`
(mirrors the `http://`/`https://` check in `post_download_http`, `routes.py:69-74`).

### Schemas (`schemas.py`)

```python
class BtMagnetRequest(BaseModel):
    magnet: str
```
(`BtDownloadRequest` name avoided to avoid clashing with the multipart route; the
multipart route reads `UploadFile` directly, no schema model needed - same as how
`put_cookies` reads raw body, `routes.py:170`.)

### History `kind`

New value `"bt"`. `history.jsonl` records one entry per completed file for
multi-file torrents (mirrors `_run_http` per-URL recording, `jobs.py:303-305`),
or one entry for single-file.

## Dedicated BT executor

```python
_bt_executor = ThreadPoolExecutor(
    max_workers=int(os.getenv("BT_MAX_CONCURRENT", "1")),
    thread_name_prefix="bt-worker",
)
```

Separate from `_executor` (`jobs.py:47`). `start_bt` submits to `_bt_executor`.
Default 1 BT slot - torrents are I/O- and bandwidth-bound, and the server is
self-hosted; 1 avoids swamping the user's connection. Env-overridable.

## TTL / lifecycle safety (R6)

`storage.cleanup_expired()` (`storage.py:46-58`) sweeps ALL job dirs older than
TTL. A slow torrent can exceed 60min and would be `rmtree`'d mid-download.

Fix: `cleanup_expired` skips a job dir if its job is still `running`. Concretely:
- `storage.cleanup_expired()` takes an optional `is_active: Callable[[str], bool]`
  (default: always-False, preserving current behavior for any non-job caller).
- `main.py` lifespan wires it to `jobs.is_running(job_id)`.
- Add `jobs.is_running(job_id) -> bool` (checks `_jobs[job_id].status == "running"`).

This also protects any future long-running YouTube/HTTP job - a general fix, not
BT-specific. Single small change, no behavior change for completed jobs.

## libtorrent usage sketch (the only non-trivial new code)

```python
import libtorrent as lt

ses = lt.session({"listen_interfaces": "0.0.0.0:6881,[::]:6881"})
# DHT on by default in 2.x; adequate for magnet resolution.
if source.startswith("magnet:"):
    params = lt.parse_magnet_uri(source)
    params.save_path = str(dest_dir)
else:  # .torrent file path
    info = lt.torrent_info(source)
    params = lt.add_torrent_params()
    params.ti = info
    params.save_path = str(dest_dir)
h = ses.add_torrent(params)

# Wait for metadata (magnet links resolve async):
while not h.status().has_metadata:
    ses.wait_for_alert(1000);  # 1s
# Now h.status().total_wanted is known.
prev = -1
while not h.status().is_finished:
    s = h.status()
    if s.download_payload_rate > 0 or s.progress != prev:
        progress_hook({"status": "downloading",
                       "downloaded_bytes": s.total_wanted_done,
                       "total_bytes": s.total_wanted})
        prev = s.progress
    ses.wait_for_alert(500)
progress_hook({"status": "finished"})
ses.remove_torrent(h)   # NO seeding - stop immediately
```

Notes:
- `download_payload_rate` gate avoids spamming the hook when stalled (peers not
  yet connected); progress still advances on real bytes.
- `total_wanted` (not `total`) - respects file priorities / partial torrents.
- `remove_torrent(h)` with default flags does NOT delete downloaded files (the
  `session.delete_files` flag is NOT set) - files stay for serving.
- One `lt.session()` per download (created and torn down inside
  `download_sync`): simplest isolation, no cross-job state. Acceptable since the
  BT pool defaults to 1 worker.

## Config additions (`config.py`)

```python
bt_max_concurrent: int = int(os.getenv("BT_MAX_CONCURRENT", "1"))
bt_listen_port: int = int(os.getenv("BT_LISTEN_PORT", "6881"))
```

No `settings.json`/UI exposure for MVP (env-only, like `MAX_CONCURRENT`).

## Dockerfile

- Add `libtorrent` to `backend/requirements.txt`. It installs as a manylinux
  wheel - NO `apt-get` change, NO new system package. Image size delta: ~few MB.
- BT listens on TCP+UDP 6881 inside the container. For DHT/peers to reach it,
  the user may need to publish the port in `docker-compose.yml`. This is a
  runtime/networking note (documented in README), not a build change. **Decision:
  do NOT add the port to `docker-compose.yml` by default** - keep the compose file
  minimal; document it as optional. BT can still download via trackers/peers that
  reach the container's published port through NAT in many cases, and DHT-only
  magnets may be slower without it. Surfacing this honestly in the README.

## Compatibility & migration

- Pure addition: no existing endpoint, schema field, or frontend tab changes
  behavior. `kind` gains a new string value `"bt"` - the frontend `HistoryEntry`
  `kind: string` is already open-ended (`types.ts:66`).
- `storage.cleanup_expired` signature change is backward-compatible (optional
  callback arg).

## Trade-offs

- **One `lt.session` per download vs. shared session**: chose per-download for
  isolation and simplicity. Cost: no peer/announcement reuse across concurrent
  torrents, DHT bootstrap per download. Acceptable at `BT_MAX_CONCURRENT=1`.
  If raised later, revisit toward a shared module-level session.
- **`.torrent` upload via separate multipart route vs. base64 in JSON**: chose
  multipart (standard for file upload, no size bloat, FastAPI `UploadFile`).
  Cost: a second route. Cleaner than base64-in-JSON.
- **No resume on restart**: same as all current job types. Out of scope v2.

## Rollback

All changes are additive. Rollback = revert the commits; no data migration, no
schema change. `history.jsonl` entries with `kind="bt"` remain inert if the code
is reverted (frontend shows them as unknown kind, harmless).
