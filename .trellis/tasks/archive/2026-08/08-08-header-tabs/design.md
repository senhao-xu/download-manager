# Design - Header tabs + YouTube component refactor

## Approach

Pure frontend change; no backend touch. Restructure `App.tsx` from "the whole
page" into "the shell", and extract the YouTube body into `YouTubeTab.tsx`.

## File changes

### `frontend/src/App.tsx` (rewrite as shell)
Keeps only:
- `useLang` / `useTheme` hooks.
- `showSettings` state + `<SettingsModal>` mount.
- New `tab` state with localStorage persistence (`useTab` hook inline or in i18n).
- Renders: `<header>` (title + toolbar), `<nav className="tabs">`, `<main>` with
  `{tab === 'youtube' ? <YouTubeTab/> : <HttpTab/>}`.

All YouTube-specific state (`url`, `info`, `job`, `selected`, `zip`, `quality`,
`esRef`, `triggeredRef`) and handlers (`onGetInfo`, `subscribe`,
`onDownloadSingle`, `onDownloadBatch`, `toggleEntry`, `toggleAll`) move to
`YouTubeTab.tsx`. So do `JobView` and the `QualityPicker`/`fmtDuration` helpers
unless they are shared - see "shared helpers" below.

### `frontend/src/YouTubeTab.tsx` (new)
The moved body. Props: none (self-contained). Imports `useLang`, `api.ts`,
`types.ts`. Owns its own SSE subscription and job state. This is a near-verbatim
move of the current `App` body + `JobView`.

### `frontend/src/HttpTab.tsx` (new, placeholder)
```tsx
export function HttpTab() {
  const { t } = useLang()
  return (
    <div className="card">
      <h2>{t('tabHTTP')}</h2>
      <p className="hint">{t('httpComingSoon')}</p>
    </div>
  )
}
```

### `frontend/src/i18n.tsx`
Add to both `en` and `zh` maps:
- `tabYouTube`: "YouTube" / "YouTube"
- `tabHTTP`: "HTTP" / "HTTP"
- `httpComingSoon`: "HTTP download is coming soon." / "HTTP 下载功能即将上线。"

### `frontend/src/styles.css`
Add `.tabs` styles:
```css
.tabs { display: flex; gap: 4px; margin-bottom: 20px; border-bottom: 1px solid var(--border); }
.tabs button { background: none; border: none; border-bottom: 2px solid transparent; border-radius: 0; padding: 10px 16px; color: var(--muted); font-weight: 600; }
.tabs button.active { color: var(--text); border-bottom-color: var(--accent); }
```

## Shared helpers

`fmtDuration` and `triggerDownload`/`downloadAll` are used by the YouTube flow
today. `JobView` is also YouTube-only today but will be reused by the HTTP tab.
Decision:
- Move `JobView` into its own file `frontend/src/JobView.tsx` (shared by YouTube
  + HTTP tabs later). `JobView` already only depends on `JobStatus` + `useLang`.
- Move `triggerDownload` / `downloadAll` into `JobView.tsx` as named exports
  (they are download-trigger helpers used by `JobView` itself).
- `fmtDuration` stays as a local helper in `YouTubeTab.tsx` (YouTube-specific for
  now); if HTTP needs it later, extract then. Avoid premature extraction.

## Tab persistence

Mirror the existing `useTheme` pattern. A small `useTab` hook:
```tsx
export function useTab() {
  const [tab, setTabState] = useState<Tab>(() => {
    const stored = localStorage.getItem('tab')
    return stored === 'http' ? 'http' : 'youtube'
  })
  const setTab = (t: Tab) => { localStorage.setItem('tab', t); setTabState(t) }
  return { tab, setTab }
}
```
Put `useTab` + the `Tab` type in `i18n.tsx` next to `useTheme` (it's a
localStorage-backed UI pref, same category) OR in a new `frontend/src/tabs.ts`.
Decision: keep in `i18n.tsx` to avoid a one-export file (frontend spec prefers
flat, minimal files). Reconsider if it grows.

## Risk / compatibility

- Moving SSE/EventSource logic into `YouTubeTab` must preserve the cleanup
  (`useEffect(() => () => esRef.current?.close(), [])`) so switching tabs doesn't
  leak an EventSource.
- `QualityPicker` is defined inline inside `App` today; move it into
  `YouTubeTab.tsx` verbatim.
- No backend contract change; `api.ts` / `types.ts` untouched.
