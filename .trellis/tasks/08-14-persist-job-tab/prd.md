# Persist active job across tab switches

## Goal

When a download is in progress on any tab (YouTube / HTTP / BT), switching to
another tab and back must still show the live job (progress, phase, and the
download buttons once done). Today switching tabs unmounts the tab component,
destroying its `job` state and closing the SSE `EventSource` - the running job
vanishes from the UI (though the backend keeps running it). The job must survive
tab switches for the duration it is active.

## Background (evidence)

- `App.tsx:64-65` renders the active tab via a conditional ternary:
  `{tab === 'youtube' ? <YouTubeTab/> : tab === 'http' ? <HttpTab/> : <BtTab/>}`.
  Switching tabs unmounts the current tab component.
- Each tab owns its own `const [job, setJob] = useState<JobStatus|null>(null)`
  (`YouTubeTab.tsx:26`, `HttpTab.tsx:11`, `BtTab.tsx:16`). Component-local state
  is discarded on unmount.
- `useJobSubscription.ts` holds the `EventSource` in a `useRef` and closes it in
  an unmount cleanup (`useEffect(() => () => esRef.current?.close(), [])`,
  `useJobSubscription.ts:26`). So unmount also kills the SSE stream.
- All three tabs share the identical pattern: on Start they `setJob({…queued})`
  then `subscribe(jobId)`. The only differences are the start API and the initial
  `total`/`title`. (`YouTubeTab.tsx:60-61,81-82`, `HttpTab.tsx:26-38`,
  `BtTab.tsx:37-56`).
- `YouTubeTab` additionally holds input state (`url`, `info`, `quality`,
  `selected`, `zip`) that is legitimately tab-local - those do NOT need to
  survive a tab switch (re-entering the form fresh is fine). Only the **active
  job** needs to persist.
- The hook's `autoDownload` (single-file done -> browser download) relies on the
  Start click being a user gesture (`useJobSubscription.ts:35-40`). After a
  tab-switch-restore, the job may already be `done` with no fresh gesture; that
  auto-trigger must NOT fire on restore (it would be a non-gesture download and
  is wrong for a restored job).
- Backend is unaffected: `_jobs` dict + worker threads persist regardless of
  frontend state. This is a frontend-only fix.

## Requirements

### R1 - Shared active-job store
- A single source of truth for the active job (id + latest `JobStatus` snapshot)
  that lives at the App level, surviving tab component mount/unmount.

### R2 - SSE subscription survives tab switches
- The `EventSource` is owned by the shared store (App level), not by each tab.
- Switching tabs must NOT close an in-flight subscription. The stream closes only
  on terminal status (`done`/`error`) or when a new job is started.

### R3 - Each tab reads/displays the shared job
- A tab renders the active job via `JobView` iff the active job was started from
  that tab (a YouTube job shouldn't render on the BT tab). Track which tab owns
  the active job.
- Starting a new job from any tab replaces the shared active job (there is only
  one active job at a time - matches current per-tab behavior where each tab
  tracks one job).

### R4 - No spurious auto-download on restore
- When a job is restored into view (tab switch back to the owning tab) and it is
  already `done`, do NOT auto-trigger the browser download. Auto-download only
  happens on the original Start gesture, as today.

### R5 - Tab-local input state unchanged
- `YouTubeTab` form state (`url`, `info`, `quality`, `selected`, `zip`) stays
  component-local. Only `job` is lifted.

## Out of scope

- Multiple concurrent active jobs (one at a time, as today).
- Persisting active job across a full page reload / browser restart (backend
  `_jobs` is in-memory and has no list endpoint; restoring would need a new
  API - separate task).
- Persisting tab-local form state across switches.

## Acceptance criteria

- [ ] Start a download on the YouTube tab, switch to HTTP, switch back: the job
      is still visible with live progress updating.
- [ ] Same for HTTP and BT tabs (verified for all three).
- [ ] Switching away from the owning tab and back while the job is already
      `done` shows the completed job with its Download button - and does NOT
      auto-trigger a browser download.
- [ ] Starting a new job on tab B while tab A's job is still running replaces
      the displayed active job (B's job shows; A no longer shows a stale job on
      return - it shows nothing or the new job only if owned by A).
- [ ] The SSE stream for an active job stays open across tab switches (no
      reconnect storm, no duplicate streams).
- [ ] `YouTubeTab` form state is NOT expected to survive a switch (out of scope)
      - only the job does.
- [ ] `tsc --noEmit` and `npm run build` pass.
