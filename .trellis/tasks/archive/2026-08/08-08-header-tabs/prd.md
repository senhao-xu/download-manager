# Header tabs + YouTube component refactor

Parent: `08-08-tabs-preview-http` (R1).

## Goal

Introduce a tab bar under the header that switches between a **YouTube** view and
an **HTTP** view. Refactor the existing YouTube page body out of `App.tsx` into a
dedicated `YouTubeTab.tsx` component, leaving `App.tsx` as the shell (header +
tabs + active-tab routing). The HTTP tab's content is provided by child task
`08-08-http-download`; here it only needs a placeholder slot.

## Requirements

- A `.tabs` bar renders two tab buttons: **YouTube** and **HTTP**.
- Active tab is held in React state and persisted to `localStorage` key `tab`
  (mirrors the existing `lang` / `theme` persistence). On load, a stored value of
  `http` or `youtube` is honored; otherwise default `youtube`.
- `App.tsx` becomes the shell: header (title + toolbar: lang/theme/settings), the
  tabs bar, and `<main>` rendering the active tab component.
- The entire current YouTube flow (url-form, single card, playlist card, JobView,
  subscribe/SSE logic) moves into `YouTubeTab.tsx` unchanged in behavior.
- The HTTP tab renders a minimal placeholder (`HttpTab.tsx`) for now - a heading
  and a "coming soon" note - so the tab is switchable. Real content lands in
  `08-08-http-download`.
- New i18n keys (both `zh` + `en`): `tabYouTube`, `tabHTTP`, `httpComingSoon`.
- All text via `t()`; no hardcoded strings (per frontend spec).
- `SettingsModal` stays mounted at the `App` shell level (shared by both tabs),
  opened by the existing ⚙ button.

## Acceptance Criteria

- [ ] Header unchanged; a tab bar appears directly beneath it with YouTube/HTTP.
- [ ] Clicking a tab swaps only the body; header/toolbar/settings unaffected.
- [ ] Selected tab persists across a full page reload.
- [ ] All existing YouTube behavior works identically post-refactor: URL info,
      single download, playlist select/zip/batch, SSE progress, auto-download.
- [ ] `npm run build` (tsc + vite) succeeds with no type errors.
- [ ] No new hardcoded strings; every visible label is in `i18n.tsx` (zh + en).
- [ ] `HttpTab.tsx` placeholder renders when the HTTP tab is active.

## Out of scope

- HTTP tab real functionality (child `08-08-http-download`).
- Preview / history UI (child `08-08-preview-history`), though the refactor here
  must not block adding a history panel later.

## Notes

- This child unblocks the other two: their UI mounts into the tab shell it
  creates. Start this one first.
