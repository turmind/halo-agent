# Preview Plugin System

Canvas renders non-text files via a **plugin registry**. Each plugin declares the extensions it handles and a React component. Adding a new file type = write one plugin, register it. No changes to the core framework or Canvas panel.

Location: [`packages/admin/src/features/editor/previews/`](../../../packages/admin/src/features/editor/previews/)

## Layout

```
previews/
├── FilePreview.tsx           Public entry. Asks the registry for the candidates for the
│                             extension, renders the chosen one (<Suspense><Component/></Suspense>
│                             for a built-in, the iframe host for an extension); too-large and
│                             no-viewer placeholders.
├── types.ts                  PreviewPlugin, PreviewProps, Resolved
├── registry.ts               register() / setExtensions() / loadExtensions() / resolve() / canPreview() / isHeavyPreview()
│                             + subscribe() / useRegistryVersion() so open tabs re-resolve on change
├── extension-host.tsx        Iframe host for installed preview extensions (+ extension-host-logic.ts,
│                             extension-token.ts) — see design/canvas-extensions.md
├── ui/
│   ├── preview-shell.tsx     Standard header (filename + extraToolbar + Open with + Open-as-Text + Download)
│   ├── open-with-menu.tsx    "Open with" picker, shown only when a file has more than one viewer
│   ├── use-preview-fetch.ts  Hook: fetch + AbortController + parse, returns {data, error, loading}
│   ├── use-data-fetch.ts     JSON-endpoint sibling: abortable fetcher → {data, error, loading},
│   │                         for previews that parse server-side instead of raw bytes
│   ├── data-table.tsx        Shared table renderer (headers + rows + prev/next pager) for
│   │                         server-parsed previews (parquet / sqlite / csv)
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
    ├── pptx-notes.ts         pptx zip helpers: speaker-notes extraction (jszip +
    │                         DOMParser, play order via sldIdLst) + Content_Types
    │                         repair for decks with dangling Override parts
    ├── media.tsx / media-view.tsx
    ├── parquet.tsx / parquet-view.tsx   Server-parsed: GET /api/data-preview/parquet
    ├── sqlite.tsx / sqlite-view.tsx     Server-parsed: GET /api/data-preview/sqlite/*
    └── csv.tsx / csv-view.tsx           Server-parsed: GET /api/data-preview/csv (csv + tsv)
```

**Two-file-per-plugin pattern**: `foo.tsx` is tiny metadata (no runtime deps). `foo-view.tsx` holds the component and its heavy dependencies. The metadata file uses `React.lazy()` so the view file (and its deps) only loads when a user actually opens that file type.

## PreviewPlugin interface

```typescript
interface PreviewPlugin {
  id: string                    // stable id, e.g. 'pdf'
  extensions: readonly string[] // lowercase, no dot — e.g. ['xlsx', 'xls'] (csv/tsv is a separate plugin)
  Component: React.ComponentType<PreviewProps>
  heavy?: boolean               // true = main-thread-heavy; active-only mount, skip MRU cache
}

interface PreviewProps {
  name: string         // full filename including extension
  path: string         // relative workspace path (or absolute for /tmp files)
  projectId?: string   // workspace absolute path — needed by server-parsed plugins
                        // (parquet/sqlite/csv) to call /api/data-preview/*
  viewUrl: string      // for inline viewing, supports HTTP Range
  downloadUrl: string  // for forced download (used by the shell's Download button)
  onOpenAsText?: () => void  // set when the file can also be force-opened as text
  tooLarge?: boolean   // file over the editor's 10MB read cap; FilePreview shows a placeholder instead of the plugin
  size?: number        // on-disk size in bytes, shown by that placeholder
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
- Mount `FooPreview` inside an MRU cache (up to 5 concurrent previews cached)

### Routing API: `canPreview()` vs `loadExtensions()`

`canPreview(ext)` is a live read of the registry (built-ins + installed extensions), so it is only as good as the extension list loaded so far. `loadExtensions()` (re-exported from `FilePreview.tsx`) is the page's single shared initial `GET /extensions` — `workspace-layout.tsx` starts it in parallel with the workspace resolve.

- **One-shot routing decisions** (`isBinaryExtension` in `editor-panel.tsx`: click-open, tab restore after reload, open-to-side) must `await loadExtensions()` before concluding "text", because an extension may claim an extension-only type (`.glb`) or a text suffix (`.json`). A preview verdict needs no wait — extensions only add viewers ahead of text, and `FilePreview` re-picks the viewer on a registry version bump.
- The wait is capped at `INITIAL_LOAD_WAIT_MS` (3 s, `registry.ts`), counted from the first call; on timeout callers proceed as if nothing were installed. The request isn't cancelled — a late result still lands via `setExtensions`.
- Candidates come from `resolve(ext)`, best first: `default` extensions → the built-in plugin → `option` extensions → Open as Text (always last). More than one candidate puts an **Open with** menu in the header.
- It never rejects and is never re-issued: a failed fetch leaves the extension layer empty without delaying later opens. The WS-reconnect re-fetch and `extension:changed` frames fill it in.

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

Set `heavy: true` on a built-in when the preview:
- Needs DOM access (can't run in a Worker — e.g. `pptx-preview` draws to canvas)
- Is the dominant memory cost of the page (large canvas, many cached elements)

Effect: the MRU cache skips this plugin. Only the **active** instance mounts; switching away unmounts the component (releases memory and stops any in-flight work). Switching back re-fetches/re-renders.

Only pptx currently uses this among built-ins (read-only preview extensions are also treated as heavy, judged by `isHeavyPreview()`). Don't set it by default — the MRU cache gives much faster switches.

## `onOpenAsText`

The editor panel passes `props.onOpenAsText` to every preview tab. Calling it closes the preview tab and opens the raw file in Monaco. Pass it straight through to `PreviewShell` and the button appears automatically (the **Open with** menu also lists Open as text).

## Two plugin patterns: raw-bytes vs. server-parsed

Most built-in plugins (pdf, docx, xlsx, pptx, media) are **raw-bytes**: they load the file from `viewUrl` (`GET /api/files/download?inline=1`). docx and xlsx use `usePreviewFetch` to download it as an ArrayBuffer and parse client-side in a Worker; pptx fetches it itself and renders on the main thread; pdf and media just hand `viewUrl` to the browser (`<iframe>` / `<img>` / `<video>` / `<audio>`). This is the pattern documented above.

Parquet, SQLite and CSV/TSV are **server-parsed** instead: the server does the parsing and hands back one page of JSON rows at a time via `GET /api/data-preview/*` (route details in [`dev/api.md`](api.md#data-preview)), so a multi-GB file never has to reach the browser.

```tsx
// plugins/foo-view.tsx (server-parsed)
import { useState } from 'react'
import type { PreviewProps } from '../types'
import { PreviewShell } from '../ui/preview-shell'
import { useDataFetch } from '../ui/use-data-fetch'
import { DataTable } from '../ui/data-table'
import { api } from '@/shared/api-client'

const PAGE_SIZE = 100

export function FooPreview({ name, path, projectId, downloadUrl, onOpenAsText }: PreviewProps) {
  const [offset, setOffset] = useState(0)
  const { data, error, loading } = useDataFetch(
    projectId ? (signal) => api.dataPreview.foo(path, projectId, offset, PAGE_SIZE, signal) : null,
    [path, projectId, offset],
  )
  return (
    <PreviewShell name={name} downloadUrl={downloadUrl} onOpenAsText={onOpenAsText} loading={loading} error={error}>
      {data && (
        <DataTable
          columns={data.columns}
          rows={data.rows}
          offset={data.offset}
          limit={data.limit}
          totalRows={data.totalRows}
          onPage={setOffset}
        />
      )}
    </PreviewShell>
  )
}
```

Server-parsed plugins need `PreviewProps.projectId` (the workspace absolute path, threaded from editor-panel's two `FilePreview` call sites) to build the `/api/data-preview/*` query.

**Which pattern to pick for a new format**: if the format can be read incrementally on disk (row groups, pages, or lines — like parquet/sqlite/csv), add a route in `data-preview.ts` and go server-parsed — it scales to large files and keeps the browser light. If the format can only be parsed after reading the whole file (zip-based containers like xlsx/docx/pptx), stay raw-bytes; page the fully-parsed result client-side (see xlsx's `DataTable` usage) instead of a hard row cutoff.

## Server side

Raw-bytes previews fetch via `GET /api/files/download?inline=1` which:
- Streams the file (doesn't read entire buffer into memory)
- Supports HTTP `Range` (206 Partial Content) for video/audio seek + progressive load
- Aborts the read when the client disconnects (tab closed / URL changed)

Server-parsed previews fetch via `GET /api/data-preview/*` (schema + one page of rows, `projectId`-scoped like `/api/files/*`).

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
   - Switching between up to 5 preview tabs is instant (MRU cache); the 6th oldest unmounts (a dirty extension tab is never evicted)
