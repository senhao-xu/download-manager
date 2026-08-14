# Frontend State Management

> How state is managed in this project.

## Overview

No state library (no Redux/Zustand). `useState` + `useRef` for local component
state; React Context (`LangProvider`) for the two genuinely global concerns:
language and theme. Server state is fetched on demand and held in component
state - no cache, no query library.

## State Categories

| Kind | Where | Example |
|---|---|---|
| Local UI state | `useState` in the component | `url`, `quality`, `zip`, `showSettings` |
| Global UI state | React Context (`i18n.tsx`) | `lang`, `theme` |
| Server state | fetched into `useState` on action | `info`, `job`, `settings` |
| Mutable ref | `useRef` | `esRef` (EventSource), `triggeredRef` (download dedupe) |

## When to Use Global State

Only when **many unrelated components** need the value AND it changes
infrequently. So far that's only `lang` and `theme`. Everything else stays local
even if it means prop-drilling one level - the app is one page, so the tree is
shallow.

## Server State

- Fetched on a user action (form submit / button click), not on mount (except
  `SettingsModal` which loads on open).
- No cache: re-fetching is cheap and avoids stale-data bugs.
- Live updates (download progress) come from an `EventSource` (SSE) stored in a
  `useRef`; each message calls `setJob(...)`. The EventSource is closed on
  terminal status.

### The active download job is lifted to App level (`useActiveJob`)

The download job + its SSE `EventSource` are owned by a single `useActiveJob()`
hook instantiated **once in `App`**, NOT by each tab. This is deliberate: tabs
are conditionally rendered (`App.tsx`), so switching tabs unmounts the tab
component. State/refs owned by the tab are destroyed on unmount - if the job
lived in the tab, switching away would drop the in-flight download from the UI
and close its SSE stream (the backend keeps running it).

`useActiveJob` owns `job` (`useState`), `ownerTab` (which tab started it), and
the `EventSource` (`useRef`). It exposes:

- `jobFor(tab)` - the job only if this tab started it (so a YouTube job doesn't
  render on the BT tab).
- `start(owner, starter, initial)` - closes any prior stream, sets the queued
  job, runs `starter` (the API call), patches the real `job_id`, subscribes.
- `reset()` - clear + close.

`App` passes `{ active: jobFor(tab), startJob: (s,i) => start(tab,s,i), reset }`
to the rendered tab. Tabs accept `ActiveJobProps` and call `startJob`, never
owning `job` themselves. One active job at a time.

Auto-download (single-file done -> browser download) is guarded by an
`autoTriggeredRef` keyed by `job_id`: it fires once on the original Start, and
**never** on a restored `done` job (the stream was already closed, so no second
`onmessage`). Do not re-open the stream on tab restore - the persisted `job`
snapshot already reflects the latest status.

## Derived State

Compute inline during render; don't mirror into state:

```ts
const urls = job.download_urls?.length ? job.download_urls : (job.download_url ? [job.download_url] : [])
const isBatch = job.total != null && job.total > 1
```

## Common Mistakes

- **Owning the download `job` in a tab component.** Tabs unmount on switch; the
  job and its SSE stream would be destroyed. The active job MUST live in
  `useActiveJob` at App level. Only tab-local form state (`url`, `info`,
  `quality`, …) may stay in the tab.
- Putting `download_url`/`download_urls` in state separately - derive from the
  single `job` object.
- Forgetting to close the `EventSource` on terminal status (leaks). The App-level
  unmount cleanup is a backstop; the real closure is on `done`/`error`.
- Auto-triggering multiple downloads - browsers block it; use a "Download all"
  button (user gesture) with staggered `setTimeout` instead. Single-file
  auto-download fires at most once per job (`autoTriggeredRef`).
