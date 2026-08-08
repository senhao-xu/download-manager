# Frontend Component Guidelines

> How components are built in this project.

## Overview

Function components + hooks (React 18). No class components, no component
libraries (no MUI/Antd) - plain HTML elements + a hand-written CSS stylesheet.
All text goes through `t()` (i18n).

## Component Structure

```tsx
import { useState } from 'react'
import { useLang } from './i18n'

export function Thing({ url, onClose }: { url: string; onClose: () => void }) {
  const { t } = useLang()
  const [x, setX] = useState(false)
  return <div className="thing">{t('thingLabel')}</div>
}
```

- Hooks first, then handlers, then JSX.
- Destructure props in the parameter list with an inline type.

## Props Conventions

- Inline typed destructuring (no separate `interface Props` unless reused).
- Callbacks named `onClose`, `onSave`, `onClick` - verb + past/imperative.
- Booleans for flags (`disabled`, `open`); never string `"true"`.

## Styling Patterns

- **One global stylesheet** (`styles.css`) using CSS custom properties
  (`--bg`, `--panel`, `--accent`, ...) defined on `:root` (dark) and
  `:root[data-theme="light"]` (light).
- **`className` with `kebab-case`.** State variants via extra class:
  `<div className={\`card job ${job.status}\`}>`.
- **No inline `style=`** except dynamic values (progress bar `width`).
- Theme toggle sets `data-theme` on `<html>` (via `useTheme`); CSS does the rest.

## Accessibility

- Every interactive element is a real `<button>` / `<a>` / `<input>` (not a
  clickable `<div>`).
- Icon-only buttons get a `title=` (e.g. the ⚙/☀/中 buttons).
- `<label>` wraps its `<input>` (checkboxes/selects).

## Common Mistakes

- Hardcoding a string instead of `t('key')` + an entry in `i18n.tsx` (both
  `zh` and `en`).
- Forgetting `download_urls: []` when constructing a `JobStatus` locally (TS
  will flag it - keep the type in sync).
- Using `:has-text("☀")` selectors in tests - emoji matching is flaky; select
  by position (`.toolbar .icon-btn`).nth(1) instead.
