# Frontend Type Safety

> Type safety patterns in this project.

## Overview

TypeScript in strict mode (`tsconfig.json`: `strict: true`,
`noUnusedLocals`, `noUnusedParameters`). `tsc -b` runs before `vite build`, so
the build fails on type errors. The backend has no runtime type check beyond
Pydantic; the frontend types are the contract on the wire.

## Type Organization

- **All cross-boundary types in `types.ts`.** They mirror
  `backend/app/schemas.py` 1:1 (`InfoResponse`, `JobStatus`, `SettingsState`,
  `CookieCheckResult`, ...). When a backend model changes, update `types.ts`.
- **Component-internal types stay inline** (props destructured with an inline
  type; `{ job }: { job: JobStatus }`).
- **No `types/` folder, no barrel `index.ts`** - one flat `types.ts`.

## Validation

No runtime validation library (no Zod). The backend's Pydantic `response_model=`
is the source of truth; the frontend trusts the shapes in `types.ts`. This is
acceptable because both sides are in the same repo and change together.

## Common Patterns

- Nullable fields use `T | null` (e.g. `title: string | null`).
- Lists default via `Field(default_factory=[])` on the backend; on the frontend
  read with `?.` + fallback: `job.download_urls?.length ? ... : [...]`.
- Discriminated unions for status strings are not used (kept as `string`); the
  few status literals (`'done'`, `'error'`) are compared directly.

## Forbidden Patterns

- **`any`.** Use `unknown` + a narrowing check, or add the real type.
- **`as` assertions** to silence the compiler - fix the type instead. (The one
  exception is `document.getElementById('root')!` at the render root.)
- **Leaving a new `JobStatus` field unset** when constructing one locally
  (`download_urls` was missed once - TS now catches it because the type is
  required).
