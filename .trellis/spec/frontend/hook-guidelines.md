# Frontend Hook Guidelines

> How hooks are used in this project.

## Overview

React's built-in hooks (`useState`, `useEffect`, `useRef`, `useContext`) plus
two custom hooks in `i18n.tsx`: `useLang()` and `useTheme()`. No data-fetching
library (no React Query/SWR).

## Custom Hook Patterns

- **`useLang()`** - reads the `LangContext` (lang, setLang, `t`). Call in any
  component that renders translated text.
- **`useTheme()`** - returns `{ theme, toggle }`; sets `data-theme` on
  `<html>` via `useEffect` and persists to `localStorage`.

A new custom hook lives in `i18n.tsx` (if it's a global concern) or inline in
its component (if it's local). Don't create a `hooks/` folder for one-off hooks.

## Data Fetching

Plain `fetch` wrapped in `api.ts` functions:

```ts
export async function fetchInfo(url: string): Promise<InfoResponse> {
  const r = await postJSON('/api/info', { url })
  if (!r.ok) throw new Error(await readError(r))
  return r.json()
}
```

Components call these in async handlers (`onGetInfo`, `runTest`, ...) and catch
errors into local state. No `useEffect`-on-mount fetching except
`SettingsModal` (loads settings when opened).

## Naming Conventions

- `useThing` - returns an object of values/actions: `useLang()` ->
  `{ lang, setLang, t }`.
- Event handlers: `onVerb` (`onGetInfo`, `onDownloadBatch`, `runTest`).
- Refs: `thingRef` (`esRef`, `triggeredRef`).

## Common Mistakes

- Fetching in `useEffect` on mount when it should be on a user action (causes
  redundant calls / race with the URL input).
- Not closing an `EventSource` in the `useEffect` cleanup (or in `resetJob`) -
  stale streams keep updating a replaced job.
- Re-deriving `download_urls` from `download_url` in state instead of inline at
  render time.
