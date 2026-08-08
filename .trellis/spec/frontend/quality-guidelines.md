# Frontend Quality Guidelines

> Code quality standards for frontend development.

## Overview

React 18 + TypeScript (strict) + Vite. No ESLint config is wired in, but
`tsc -b` runs on every build and fails on unused locals/params and type errors.
Keep the code clean enough that `tsc` is the only gate needed.

## Forbidden Patterns

- **Hardcoded user-facing strings.** All text via `t('key')` with both `zh` and
  `en` entries in `i18n.tsx`.
- **`fetch` outside `api.ts`.** Components use the typed wrappers; URLs and
  error-reading live in one place.
- **`any` / `as` to silence the compiler.** Fix the type.
- **Inline `style=` for static values.** Use a className + CSS. (Dynamic values
  like progress `width` are fine.)
- **Committing `node_modules/` or `dist/`.** Both are in `.gitignore`.
- **Committing ad-hoc Playwright smoke scripts.** They're verification tools,
  not deliverables - remove after use.

## Required Patterns

- **Strict types.** `tsconfig.json` `strict: true`, `noUnusedLocals`,
  `noUnusedParameters`.
- **`types.ts` mirrors the backend schemas.** Add the field on both sides.
- **Theme via CSS variables.** New colors go in `:root` (dark) and
  `:root[data-theme="light"]`; use `var(--name)` in rules.
- **Accessibility**: real `<button>`/`<a>`/`<input>`; icon buttons get `title=`;
  `<label>` wraps inputs.

## Testing Requirements

No unit tests. Verification via ad-hoc Playwright smoke scripts run locally
against the dev server (`node foo-smoke.mjs`), then deleted. Each smoke script
asserts observable outcomes (text appears, attribute changed, status done) and
checks for console errors.

## Code Review Checklist

- [ ] No hardcoded strings - all via `t()` with zh+en?
- [ ] `types.ts` updated if a backend model changed?
- [ ] New color added to BOTH dark and light theme blocks?
- [ ] `tsc -b && vite build` passes?
- [ ] No `node_modules`/`dist`/smoke scripts committed?
- [ ] Icon-only buttons have `title=`?
