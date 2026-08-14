# Implement - Persist active job across tab switches

Ordered checklist. Frontend-only. Inline workflow: `trellis-before-dev` before step 1.

## Phase A - The shared hook

- [ ] **A1. `frontend/src/useActiveJob.ts` (new).** Implement `useActiveJob()`
      per `design.md`: owns `job`/`ownerTab` state, `esRef`/`autoTriggeredRef`,
      App-lifetime unmount cleanup, `start(owner, starter, initial)`,
      `subscribe(jobId)`, `reset()`, `jobFor(tab)`, `isRunning`. Import
      `triggerDownload` from `JobView` (as `useJobSubscription` did). Type
      `OwnerTab` (reuse `Tab` from `i18n.tsx` or define locally).
      Verify: `tsc --noEmit` (after A2 wires it in; A1 alone has no consumer yet).

## Phase B - App wiring

- [ ] **B1. `App.tsx`.** Instantiate `const active = useActiveJob()` once.
      Pass to the rendered tab: e.g.
      `<YouTubeTab active={active.jobFor('youtube')} startJob={...} reset={active.reset} />`
      and the analogous for HTTP/BT. Keep the conditional render (only the active
      tab is mounted) - that's fine now because the job lives in App, not the tab.

## Phase C - Refactor each tab

- [ ] **C1. `YouTubeTab.tsx`.** Drop `useState<JobStatus>` + `useJobSubscription`.
      Accept `{ active: JobStatus|null; startJob: (starter, initial) => Promise<void>; reset }`.
      `onDownloadSingle`/`onDownloadBatch` call `startJob(async () => startDownload(...), {...queued})`.
      `resetJob()` calls the passed `reset`. Replace `job` references with
      `active`; render `<JobView job={active} />` when `active` is truthy. Disable
      Start buttons on `active?.status === 'running'` (owning-tab gating, R3).
      Keep all form state local (`url`,`info`,`quality`,`selected`,`zip`).

- [ ] **C2. `HttpTab.tsx`.** Same refactor. `startJob` wraps `startHttpDownload`.
      Initial job: `{ id:'', status:'queued', progress:0, current:0, total:urls.length, ... }`
      (id patched by `start`). Note: `start` sets initial then awaits the API -
      pass `initial` with a placeholder id; `start` patches the real id.

- [ ] **C3. `BtTab.tsx`.** Same refactor. `startJob` wraps `startBtMagnet` /
      `startBtTorrentFile` (two branches in the existing `onStart`).

## Phase D - Cleanup & verify

- [ ] **D1. Delete `useJobSubscription.ts`.** Confirm no remaining import
      (`grep -r useJobSubscription frontend/src/`). The hook is fully replaced.

- [ ] **D2. `tsc --noEmit` + `npm run build`.** Fix any type errors (the
      `initial` JobStatus shape must match `JobStatus`; the `id:''` placeholder
      is fine since `start` patches it, but ensure no code reads `active.id`
      before subscribe - the placeholder is acceptable).

## Validation (manual, all three tabs)

```bash
cd frontend && npx tsc --noEmit && npm run build   # type + build
# Then run the app (docker compose up or dev) and:
# 1. Start a YouTube download -> switch to HTTP -> back -> job + progress still there.
# 2. Start an HTTP download -> switch to BT -> back -> still there.
# 3. Start a BT download -> switch to YouTube -> back -> still there.
# 4. Let a job finish while on another tab -> return -> shows Done + Download button, NO auto-download fires.
# 5. Start a job on tab A, then start another on tab B while A runs -> B's job shows; returning to A shows nothing stale.
```

## Review gates / rollback points

- After A1+B1: hook exists and App owns it (can typecheck even before tab refactor
  if tabs temporarily keep their own state - but simplest is A->C contiguous).
- After C3: all tabs on the shared hook; full manual test.
- Rollback: revert commits. `useJobSubscription.ts` is recoverable from git.

## Risky files

- `useActiveJob.ts` - the `start` flow (set initial -> await API -> patch id ->
  subscribe) must not race: if the user clicks Start twice fast, the second
  `start` closes the first stream before subscribing. The `esRef.current?.close()`
  at the top of `start`/`subscribe` handles this. Verify no double-subscribe.
- `YouTubeTab.tsx` - has the most state; ensure only `job` is lifted, form state
  stays local, and the `resetJob()` calls on Get-Info / new-download use the
  passed `reset`.
- Auto-download guard (`autoTriggeredRef` keyed by jobId) - confirm a restored
  `done` job does NOT trigger a second download (R4).
