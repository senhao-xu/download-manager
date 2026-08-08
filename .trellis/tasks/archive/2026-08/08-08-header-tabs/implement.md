# Implement - Header tabs + YouTube component refactor

## Execution checklist

### 1. i18n keys
- [ ] Add `tabYouTube`, `tabHTTP`, `httpComingSoon` to BOTH `en` and `zh` maps in
      `frontend/src/i18n.tsx`.
- [ ] Add `Tab` type (`'youtube' | 'http'`) and `useTab()` hook (localStorage
      key `tab`, default `youtube`) in `frontend/src/i18n.tsx` next to `useTheme`.

### 2. Extract JobView (shared)
- [ ] Create `frontend/src/JobView.tsx`:
  - Move `JobView` component from `App.tsx`.
  - Move `triggerDownload` + `downloadAll` helpers as named exports.
- [ ] Remove the originals from `App.tsx`.

### 3. Extract YouTubeTab
- [ ] Create `frontend/src/YouTubeTab.tsx`:
  - Move the entire current `App` body (state, handlers, JSX) verbatim.
  - Move `fmtDuration` and the inline `QualityPicker` here.
  - Import `JobView` from `./JobView`, `triggerDownload` as needed.
  - Keep the `useEffect` EventSource cleanup.
- [ ] `YouTubeTab` takes no props.

### 4. Placeholder HttpTab
- [ ] Create `frontend/src/HttpTab.tsx` (heading + `t('httpComingSoon')`).

### 5. Rewrite App.tsx as shell
- [ ] `App.tsx`: `useLang`, `useTheme`, `useTab`, `showSettings`.
- [ ] Render header (unchanged), `<nav className="tabs">` (two buttons, active
      class on `tab`), `<main>` with the active tab component.
- [ ] Mount `<SettingsModal>` at shell level.
- [ ] Remove all YouTube-specific code now that it lives in `YouTubeTab.tsx`.

### 6. Styles
- [ ] Add `.tabs` / `.tabs button` / `.tabs button.active` to `styles.css`.

### 7. Validate
- [ ] `cd frontend && npm run build` - must pass tsc + vite, no errors.
- [ ] Manual: tabs switch; reload keeps selection; YouTube flow intact; HTTP tab
      shows placeholder; settings modal opens from both tabs.

## Validation commands

```bash
cd frontend && npm run build
```

## Review gates

- After step 5: confirm `App.tsx` has no leftover YouTube state/handlers (grep
  for `onGetInfo`, `subscribe`, `esRef` - should only be in `YouTubeTab.tsx`).
- After step 7: build green; no regression in YouTube single/playlist/zip/SSE.

## Rollback

Pure frontend, single commit scope. `git checkout -- frontend/src` reverts
everything. No backend/migration changes to undo.
