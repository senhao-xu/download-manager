# Implement - BT download module

Ordered checklist. Each step is independently testable. Validation commands at the
end. Inline workflow: load context via `trellis-before-dev` before step 1.

## Phase A — Backend engine & job path

- [ ] **A1. Dependency.** Add `libtorrent>=2.0.9` to `backend/requirements.txt`.
      Verify: `pip install -r backend/requirements.txt` succeeds (manylinux wheel,
      no build). Quick smoke: `python -c "import libtorrent as lt; print(lt.__version__)"`.

- [ ] **A2. Config.** In `backend/app/config.py` `Settings`, add:
      `bt_max_concurrent: int = int(os.getenv("BT_MAX_CONCURRENT", "1"))` and
      `bt_listen_port: int = int(os.getenv("BT_LISTEN_PORT", "6881"))`.

- [ ] **A3. Engine module `backend/app/bt_dl.py`.** Implement `download_sync`
      per `design.md` contract. Mirror `http_dl.py` module structure (docstring,
      logger, `_sanitize`/`_unique` helpers reused where naming is needed).
      - Magnet path: `lt.parse_magnet_uri`; `.torrent` path: `lt.torrent_info`.
      - One `lt.session()` per call, `save_path=dest_dir`.
      - Wait metadata loop (magnet) -> download loop emitting hook dict ->
        `is_finished` -> `remove_torrent` (no seeding, keep files) -> hook finished.
      - Return `(name, path, size, mime)`. Single-file: file path; multi-file:
        folder path + caller scans. Determine single vs multi via
        `torrent_info.num_files()` after metadata.
      - Friendly errors: invalid magnet, unreadable torrent, metadata timeout.
      Verify: unit-level - craft a tiny known torrent or use a magnet and watch
      `download_sync` print progress; or at least `import bt_dl` + call with a bad
      magnet to confirm it raises a friendly `RuntimeError`.

- [ ] **A4. `jobs.py` — dedicated executor + `is_running` + `_run_bt`.**
      - Module-level `_bt_executor = ThreadPoolExecutor(max_workers=settings.bt_max_concurrent, thread_name_prefix="bt-worker")` (next to `_executor`, `jobs.py:47`).
      - `start_bt(source) -> Job`: `create_job()` + `_bt_executor.submit(_run_bt, job, source)`.
      - `_run_bt(job, source)`: mirror `_run_http` (`jobs.py:276-323`):
        `_set(running, phase="starting")`, `d = storage.job_dir(job.id)`,
        build `hook(ev)` closure (copy the `_run_http` hook verbatim - it already
        handles the hook dict shape), call `bt_dl.download_sync(source, d, hook)`.
        - Single-file result (determined by `bt_dl` return / file scan): set
          `result_path`, `result_filename`, `files=[(path,name)]`,
          `download_url=/api/files/{job.id}`. Record history `kind="bt"`.
        - Multi-file: scan `dest_dir/<name>/` sorted into `files` list; leave
          `result_path=None`, `download_url=None` (snapshot() builds indexed URLs).
          Record one history entry per file.
      - `is_running(job_id) -> bool`: `with _lock: j=_jobs.get(job_id); return bool(j and j.status=="running")`.

- [ ] **A5. TTL safety — `storage.cleanup_expired` + `main.py`.**
      - `storage.cleanup_expired(is_active=None)`: if `is_active and is_active(d.name)`:
        skip (log debug). Default `is_active=None` preserves current behavior.
      - `main.py` lifespan: pass `is_active=jobs.is_running` to the cleanup thread
        (the thread calls `cleanup_expired` - thread it through, or have the loop
        call `cleanup_expired(jobs.is_running)`). Verify the cleanup thread still
        works for non-running dirs.
      Verify: a running job's dir survives a sweep; a completed old dir is removed.

## Phase B — Backend API

- [ ] **B1. Schemas.** `backend/app/schemas.py`: add `BtMagnetRequest(BaseModel)` with
      `magnet: str`. Import in `routes.py`.

- [ ] **B2. Routes.** `backend/app/routes.py`:
      - `POST /api/download-bt`: validate magnet starts with `magnet:?` and contains
        `xt=urn:btih:` (else 400). `jobs.start_bt(req.magnet)` -> `JobCreated`.
      - `POST /api/download-bt/file`: `file: UploadFile = File(...)`, read bytes,
        validate `.torrent` extension / non-empty, write to `storage.job_dir(job.id)/"source.torrent"`,
        then `jobs.start_bt(str(that_path))`. Return `JobCreated`.
        (Need `from fastapi import UploadFile, File`.)
      Verify: `curl -X POST /api/download-bt -d '{"magnet":"magnet:?xt=urn:btih:0000"}'`
      returns a job_id; bad magnet returns 400. Upload a real .torrent via curl `-F`.

## Phase C — Frontend

- [ ] **C1. Types & API.** `frontend/src/types.ts`: extend `Tab` to
      `'youtube' | 'http' | 'bt'` (in `i18n.tsx:241`). `frontend/src/api.ts`:
      add `startBtMagnet(magnet: string): Promise<string>` (postJSON
      `/api/download-bt`) and `startBtTorrentFile(file: File): Promise<string>`
      (FormData POST `/api/download-bt/file`).

- [ ] **C2. `BtTab.tsx`.** Copy `HttpTab.tsx` as scaffold. Two inputs: magnet
      textarea + `<input type="file" accept=".torrent">`. Start button submits
      whichever is present (magnet if non-empty, else the file; if both, magnet
      wins; if neither, error). Reuse `useJobSubscription` + `JobView`.

- [ ] **C3. App tab + i18n.** `App.tsx`: add the BT tab button + `tab==='bt'` render
      branch. `i18n.tsx`: add `tabBT: 'BT'`, `btPlaceholder`, `btHint`,
      `downloadBt`, `btFileLabel`, `noBtSource`, `kindBt: 'BT'` for both `en` and
      `zh`. `HistoryPanel.tsx`: map `kind==="bt"` to `t('kindBt')` label (find the
      existing `kind==="http"` mapping and add a sibling).

## Phase D — Build & docs

- [ ] **D1. Docker build.** `docker compose build`. Confirm it succeeds and
      `libtorrent` installed from wheel (no apt). Check image didn't balloon
      (`docker images ytb-dl`).

- [ ] **D2. README.** Add a short "BT download" note: supports magnet + .torrent,
      optional `BT_MAX_CONCURRENT`/`BT_LISTEN_PORT` env, and that publishing port
      6881 (TCP+UDP) in compose improves peer connectivity / DHT. Keep it brief.

## Validation commands (run before declaring done)

```bash
# Backend import + smoke
cd backend && python -c "import libtorrent; from app import bt_dl, jobs, routes; print('imports ok')"

# Lint/types if present (check repo for tooling):
cd /root/ytb-dl/frontend && npx tsc --noEmit   # frontend typecheck
cd /root/ytb-dl/backend && python -m py_compile app/*.py  # syntax check all modules

# Full build
cd /root/ytb-dl && docker compose build
```

## Review gates / rollback points

- After A3: engine works in isolation (revert just `bt_dl.py`).
- After A4+A5: job path + TTL safety; can test end-to-end via curl before any
  frontend. (good milestone to commit)
- After C3: full UI flow.
- Rollback: all additive; `git revert` the commits. No migration.

## Risky files

- `jobs.py` — central orchestrator; the `_run_bt` worker must copy `_run_http`'s
  hook semantics exactly (hook closure, `_set` calls, history recording) or
  progress/SSE breaks. Review against `jobs.py:276-323` line by line.
- `storage.py` `cleanup_expired` — signature change must stay backward-compatible
  (default arg), or the existing sweep breaks.
- libtorrent alert-polling loop — must not busy-spin; use `wait_for_alert(ms)` and
  gate hook emission on real progress to avoid flooding the SSE channel.
