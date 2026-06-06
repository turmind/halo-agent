# Preview Plugin System

Canvas renders non-text files via a **plugin registry**. Each plugin declares the extensions it handles and a React component. Adding a new file type = write one plugin, register it. No changes to the core framework or Canvas panel.

Location: [`packages/admin/src/features/editor/previews/`](../../../packages/admin/src/features/editor/previews/)

## Layout

```
previews/
├── FilePreview.tsx           Public entry. Looks up plugin by extension,
│                             renders <Suspense><Component/></Suspense>.
├── types.ts                  PreviewPlugin, PreviewProps
├── registry.ts               register() / getPlugin() / registeredExtensions() / isHeavyPreview()
├── ui/
│   ├── preview-shell.tsx     Standard header (filename + Open-as-Text + Download + extraToolbar)
│   ├── use-preview-fetch.ts  Hook: fetch + AbortController + parse, returns {data, error, loading}
│   └── print.ts              Pop-up print helper
├── workers/                  Parse workers (one per heavy format)
│   ├── worker-client.ts      Generic WorkerClient<T> class — id-routed postMessage
│   ├── xlsx.worker.ts
│   └── docx.worker.ts
└── plugins/
    ├── index.ts              Registers all built-in plugins
    ├── pdf.tsx               Metadata (id, extensions, lazy Component)
    ├── pdf-view.tsx          Actual React component
    ├── docx.tsx / docx-view.tsx
    ├── xlsx.tsx / xlsx-view.tsx
    ├── pptx.tsx / pptx-view.tsx
    └── media.tsx / media-view.tsx
```

**Two-file-per-plugin pattern**: `foo.tsx` is tiny metadata (no runtime deps). `foo-view.tsx` holds the component and its heavy dependencies. The metadata file uses `React.lazy()` so the view file (and its deps) only loads when a user actually opens that file type.

## PreviewPlugin interface

```typescript
interface PreviewPlugin {
  id: string                    // stable id, e.g. 'pdf'
  extensions: readonly string[] // lowercase, no dot — e.g. ['xlsx', 'xls', 'csv']
  Component: React.ComponentType<PreviewProps>
  heavy?: boolean               // true = main-thread-heavy; active-only mount, skip MRU cache
}

interface PreviewProps {
  name: string         // full filename including extension
  path: string         // relative workspace path (or absolute for /tmp files)
  viewUrl: string      // for inline viewing, supports HTTP Range
  downloadUrl: string  // for forced download (used by the shell's Download button)
  onOpenAsText?: () => void  // set when the file can also be force-opened as text
}
```

## Adding a new file type

### 1. Create the view component

```tsx
// plugins/foo-view.tsx
'use client'

import type { PreviewProps } from '../types'
import { PreviewShell } from '../ui/preview-shell'
import { usePreviewFetch } from '../ui/use-preview-fetch'

export function FooPreview(props: PreviewProps) {
  const { name, viewUrl, downloadUrl, onOpenAsText } = props
  const { data, error, loading } = usePreviewFetch(viewUrl, async (buf) => {
    // Parse `buf` here. For heavy parsing, call into a Worker (see Workers below).
    return parseFoo(buf)
  })
  return (
    <PreviewShell
      name={name}
      downloadUrl={downloadUrl}
      onOpenAsText={onOpenAsText}
      loading={loading}
      error={error}
    >
      {data && <div className="h-full overflow-auto">{/* render your data */}</div>}
    </PreviewShell>
  )
}
```

### 2. Declare the plugin

```tsx
// plugins/foo.tsx
'use client'

import { lazy } from 'react'
import type { PreviewPlugin } from '../types'

export const fooPlugin: PreviewPlugin = {
  id: 'foo',
  extensions: ['foo', 'foobar'],
  Component: lazy(() => import('./foo-view').then((m) => ({ default: m.FooPreview }))),
}
```

### 3. Register it

```ts
// plugins/index.ts
import { fooPlugin } from './foo'
register(fooPlugin)
```

Done. The Canvas panel will:
- Treat `.foo` / `.foobar` as non-text (routes to preview instead of Monaco)
- Mount `FooPreview` inside an MRU cache (up to 5 concurrent plugins cached)

## PreviewShell — the standard header

Every plugin should wrap its content in `<PreviewShell>` for consistency. The shell gives you:
- Filename on the left
- Your plugin-specific buttons via `extraToolbar` (right-aligned, before the standard buttons)
- Standard Open-as-Text + Download buttons
- Loading overlay (pass `loading={true}`)
- Error state (pass `error={'…'}` — the children are hidden)

```tsx
<PreviewShell
  name={name}
  downloadUrl={downloadUrl}
  onOpenAsText={onOpenAsText}
  extraToolbar={myButtons}     // optional
  loading={loading}
  error={error}
>
  {content}
</PreviewShell>
```

Plugin-specific buttons use the shared `<ToolbarButton>`:

```tsx
<ToolbarButton onClick={...} title="Print">
  <Printer className="h-3 w-3" />
  <span>Print</span>
</ToolbarButton>
```

## Workers — parsing off the main thread

If your format needs CPU-heavy parsing (non-trivial ArrayBuffer → structured data), run it in a Web Worker so the UI stays responsive even with several tabs parsing concurrently.

### 1. Write the worker

```ts
// workers/foo.worker.ts
/// <reference lib="webworker" />

type Req = { id: number; buf: ArrayBuffer; meta?: unknown }
type Res = { id: number; ok: true; data: FooResult } | { id: number; ok: false; error: string }

self.addEventListener('message', (e: MessageEvent<Req>) => {
  const { id, buf } = e.data
  try {
    const data = parseFoo(buf)
    ;(self as any).postMessage({ id, ok: true, data } satisfies Res)
  } catch (err) {
    ;(self as any).postMessage({ id, ok: false, error: String(err) } satisfies Res)
  }
})
```

### 2. Wire it in the view

```tsx
import { WorkerClient } from '../workers/worker-client'

let client: WorkerClient | null = null
function getClient() {
  if (!client) {
    client = new WorkerClient(
      () => new Worker(new URL('../workers/foo.worker.ts', import.meta.url), { type: 'module' }),
    )
  }
  return client
}

// Inside your component:
const { data } = usePreviewFetch(viewUrl, (buf, signal) =>
  getClient().call<FooResult>(signal, buf),
)
```

`WorkerClient.call(signal, buf, meta?)` handles id routing, transfer of the ArrayBuffer, and abort (when the caller's signal fires, the reply is dropped).

## `heavy: true` — when to use it

Set `heavy: true` when the preview:
- Needs DOM access (can't run in a Worker — e.g. `pptx-preview` draws to canvas)
- Is the dominant memory cost of the page (large canvas, many cached elements)

Effect: the MRU cache skips this plugin. Only the **active** instance mounts; switching away unmounts the component (releases memory and stops any in-flight work). Switching back re-fetches/re-renders.

Only pptx currently uses this. Don't set it by default — the MRU cache gives much faster switches.

## `onOpenAsText`

When the user right-clicks a previewable file in Explorer and picks "Open as Text", Canvas closes the preview tab and opens the raw file in Monaco. The preview plugin receives this as `props.onOpenAsText` — pass it straight through to `PreviewShell` and the button appears automatically.

## Server side

All previews fetch via `GET /api/files/download?inline=1` which:
- Streams the file (doesn't read entire buffer into memory)
- Supports HTTP `Range` (206 Partial Content) for video/audio seek + progressive load
- Aborts the read when the client disconnects (tab closed / URL changed)

See [`dev/api.md`](api.md) for the route details.

## Testing a new plugin

1. Drop a test file into your workspace
2. Click it in the Explorer — Canvas should open it in preview mode automatically
3. Verify:
   - Loading overlay appears briefly
   - Download button works (forces attachment download)
   - Open-as-Text button works (closes preview, opens in Monaco)
   - Closing the preview tab cleanly aborts any in-flight fetch/parse
   - Opening a second file of the same type reuses the worker (no second worker instance — check DevTools → Application → Service Workers / the process graph)
   - Switching between up to 5 preview tabs is instant (MRU cache); the 6th oldest unmounts
