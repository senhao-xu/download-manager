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
  unmount (`useEffect` cleanup) and on terminal status.

## Derived State

Compute inline during render; don't mirror into state:

```ts
const urls = job.download_urls?.length ? job.download_urls : (job.download_url ? [job.download_url] : [])
const isBatch = job.total != null && job.total > 1
```

## Common Mistakes

- Putting `download_url`/`download_urls` in state separately - derive from the
  single `job` object.
- Forgetting to close the `EventSource` on unmount (leaks across navigations).
- Auto-triggering multiple downloads - browsers block it; use a "Download all"
  button (user gesture) with staggered `setTimeout` instead.
