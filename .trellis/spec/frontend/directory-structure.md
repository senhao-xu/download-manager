# Frontend Directory Structure

> How frontend code is organized in this project.

## Overview

A Vite + React + TypeScript SPA, served by the FastAPI backend (built into
`frontend/dist/`). One flat `src/` directory - no `components/`, `pages/`, or
`hooks/` subfolders. The app is small enough that a flat layout is clearer than
a deep one.

## Directory Layout

```
frontend/
├── index.html            # root HTML + inline theme script (no FOUC)
├── package.json
├── vite.config.ts         # plugin + /api proxy in dev
├── tsconfig.json
└── src/
    ├── main.tsx           # entry; wraps App in LangProvider
    ├── App.tsx            # main page + JobView + header toggles
    ├── SettingsModal.tsx  # settings modal (cookies/proxy/test/check)
    ├── i18n.tsx           # LangProvider + useLang + useTheme + zh/en table
    ├── api.ts             # fetch wrappers for /api/*
    ├── types.ts           # TS interfaces mirroring backend schemas
    └── styles.css         # single stylesheet, CSS variables for theming
```

## Module Organization

- **One component per file** for non-trivial components (`App.tsx`,
  `SettingsModal.tsx`). Small helpers (`JobView`) may live in `App.tsx`.
- **`api.ts` is the only place that calls `fetch`.** Components import typed
  functions from it; they never construct URLs or read `detail` themselves.
- **`types.ts` mirrors `backend/app/schemas.py`.** When a backend model changes,
  update both sides.
- **`i18n.tsx` owns all user-facing strings.** No hardcoded English/Chinese in
  components; use `t('key')`.

## Naming Conventions

- Files: `PascalCase.tsx` for components (`SettingsModal.tsx`),
  `lowercase.ts` for modules (`api.ts`, `types.ts`, `i18n.tsx`).
- Components: `PascalCase` (`SettingsModal`, `JobView`).
- Hooks: `useThing` (`useLang`, `useTheme`).
- CSS classes: `kebab-case` (`.url-form`, `.modal-overlay`, `.test-result`).

## Examples

- A new top-level view: add `Foo.tsx`, render it from `App.tsx`.
- A new API call: add to `api.ts` + the type to `types.ts`; call from a
  component via `await fetchFoo(...)`.
