'use client'

import { createContext, createElement, useContext, useRef, type ReactNode } from 'react'
import { create } from 'zustand'
import type { FileTreeNode } from '@turmind/halo-core'

export type { FileTreeNode }

/** A file's editable content (or preview metadata). One per path —
 *  shared by every pane that shows the same file, so editing in one pane
 *  reflects in the other. */
export interface EditorBuffer {
  path: string
  content: string
  originalContent: string
  language: string
  modified?: boolean
  mtime?: number
  createdAt?: number
  size?: number
  preview?: { downloadUrl: string; viewUrl: string }
}

/** Legacy alias kept for selectors that read `s.tabs`. Same shape as
 *  EditorBuffer; the value comes from the active group's tab list joined
 *  against `buffers`. */
export type EditorTab = EditorBuffer

/** A pane (editor group). Holds the ordered list of tabs (paths) it shows
 *  and which one is currently active in that pane. */
export interface EditorGroup {
  /** Stable identifier — used as React key when rendering panes. */
  id: string
  tabs: string[]
  activeTab: string | null
}

let nextGroupId = 1
function newGroupId(): string { return `g${nextGroupId++}` }

/** Derive the legacy active-pane view (`tabs`, `activeTab`) from buffers +
 *  groups. Called after every mutation so existing selectors keep
 *  reflecting the active pane without a full rewrite at every call site. */
function deriveActiveView(state: { buffers: Record<string, EditorBuffer>; groups: EditorGroup[]; activeGroupIdx: number }): { tabs: EditorTab[]; activeTab: string | null } {
  const grp = state.groups[state.activeGroupIdx]
  if (!grp) return { tabs: [], activeTab: null }
  const tabs: EditorTab[] = []
  for (const path of grp.tabs) {
    const buf = state.buffers[path]
    if (buf) tabs.push(buf)
  }
  return { tabs, activeTab: grp.activeTab }
}

interface EditorStore {
  // ── New pane-aware shape ──────────────────────────────────────────
  buffers: Record<string, EditorBuffer>
  groups: EditorGroup[]                  // length 1 or 2
  activeGroupIdx: number                 // 0 or 1

  // ── Legacy convenience fields (derived from active group) ─────────
  tabs: EditorTab[]
  activeTab: string | null

  fileTree: FileTreeNode | null
  modifiedPaths: Set<string>
  rejectedFile: string | null
  bottomTab: 'chat' | 'terminal'
  pendingTerminalCwd: string | null
  requestTerminalSpawn(cwd: string): void
  consumeTerminalSpawn(): string | null
  maximized: boolean
  toggleMaximized(): void
  setMaximized(value: boolean): void
  bottomFloating: boolean
  bottomMaximized: boolean
  bottomFloatRect: { x: number; y: number; w: number; h: number }
  setBottomFloating(value: boolean): void
  setBottomMaximized(value: boolean): void
  setBottomFloatRect(rect: { x: number; y: number; w: number; h: number }): void
  selectedText: string | null
  selectedRange: { startLine: number; endLine: number } | null
  contextEnabled: boolean
  setSelectedText(text: string | null, range?: { startLine: number; endLine: number } | null): void
  setContextEnabled(enabled: boolean): void

  // ── File ops (default to active group) ────────────────────────────
  openFile(path: string, content: string, language: string, mtime?: number, meta?: { size?: number; createdAt?: number }): void
  openPreview(path: string, downloadUrl: string, viewUrl: string, meta?: { size?: number; mtime?: number; createdAt?: number }): void
  /** Close `path` in every group it appears in, then drop the buffer if no
   *  group still references it. Used by destructive flows (rename, delete)
   *  where the path is gone from disk and shouldn't linger anywhere. */
  closeTab(path: string): void
  /** Close a tab in a specific pane only. The buffer survives if other panes
   *  still show it (so split→close-right doesn't lose your edits in left). */
  closeTabIn(groupIdx: number, path: string): void
  /** Make `path` the active tab. If `groupIdx` is provided it's authoritative;
   *  otherwise we find a group that already has the path and use that, falling
   *  back to the active group. */
  setActiveTab(path: string, groupIdx?: number): void
  updateContent(path: string, content: string): void

  // ── Pane management ───────────────────────────────────────────────
  setActiveGroup(groupIdx: number): void
  /** Open a fresh right pane (groups[1]) with `path`, switching focus to it.
   *  No-op when right pane already exists; when `path` is omitted the active
   *  pane's current tab is duplicated. */
  splitToRight(path?: string): void
  /** Drop a pane and re-flow remaining buffers; called when a user explicitly
   *  closes a pane or when its last tab is closed. */
  closeGroup(groupIdx: number): void
  /** Move a tab from one pane to another (drag-and-drop across panes). */
  moveTabToGroup(srcGroupIdx: number, path: string, dstGroupIdx: number, insertAt?: number): void
  /** Open `path` directly in a specific pane (used for "Open to the Side"
   *  and for spawning the right pane via splitToRight). */
  openFileInGroup(groupIdx: number, path: string, content: string, language: string, mtime?: number, meta?: { size?: number; createdAt?: number }): void

  setFileTree(tree: FileTreeNode): void
  setDirChildren(dirPath: string, children: FileTreeNode[]): void
  markModified(path: string): void
  clearModified(path: string): void
  markSaved(path: string, mtime?: number): void
  setRejectedFile(path: string | null): void
  setBottomTab(tab: 'chat' | 'terminal'): void
  insertFileNode(relativePath: string, nodeType?: 'file' | 'directory'): void
  removeFileNode(relativePath: string): void
  checkAndRefresh(path: string, diskMtime: number, fetchContent: () => Promise<{ content: string; modifiedAt: number }>): Promise<boolean>
}

/** Reorder helper for tab drag (within a single pane). */
function spliceMove<T>(arr: T[], from: number, to: number): T[] {
  const next = [...arr]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

export function createEditorStore() {
  return create<EditorStore>((set, get) => {
    const initialGroup: EditorGroup = { id: newGroupId(), tabs: [], activeTab: null }
    return {
      buffers: {},
      groups: [initialGroup],
      activeGroupIdx: 0,
      tabs: [],
      activeTab: null,

      fileTree: null,
      modifiedPaths: new Set(),
      rejectedFile: null,
      bottomTab: 'chat',
      maximized: typeof window !== 'undefined' && localStorage.getItem('halo_editor_maximized') === 'true',
      bottomFloating: typeof window !== 'undefined' && sessionStorage.getItem('halo_bottom_floating') === 'true',
      bottomMaximized: false,
      bottomFloatRect: (() => {
        if (typeof window === 'undefined') return { x: 0, y: 0, w: 480, h: 640 }
        const raw = sessionStorage.getItem('halo_bottom_float_rect')
        if (raw) {
          try { return JSON.parse(raw) } catch {}
        }
        const w = 480
        const h = 640
        const x = Math.max(0, window.innerWidth - w - 24)
        const y = Math.max(0, window.innerHeight - h - 24)
        return { x, y, w, h }
      })(),
      selectedText: null,
      selectedRange: null,
      contextEnabled: typeof window !== 'undefined'
        ? localStorage.getItem('halo_context_enabled') !== 'false'
        : true,

      setSelectedText(text, range) {
        set({ selectedText: text || null, selectedRange: range ?? null })
      },

      setContextEnabled(enabled) {
        set({ contextEnabled: enabled })
        if (typeof window !== 'undefined') {
          localStorage.setItem('halo_context_enabled', String(enabled))
        }
      },

      openFile(path, content, language, mtime, meta) {
        set((state) => {
          const buffers = state.buffers[path]
            ? state.buffers
            : { ...state.buffers, [path]: { path, content, originalContent: content, language, mtime, size: meta?.size, createdAt: meta?.createdAt } }
          const idx = state.activeGroupIdx
          const cur = state.groups[idx]
          const tabs = cur.tabs.includes(path) ? cur.tabs : [...cur.tabs, path]
          const groups = state.groups.map((g, i) => i === idx ? { ...g, tabs, activeTab: path } : g)
          const next = { ...state, buffers, groups }
          return { buffers, groups, ...deriveActiveView(next) }
        })
      },

      openPreview(path, downloadUrl, viewUrl, meta) {
        set((state) => {
          const buffers = state.buffers[path]
            ? state.buffers
            : { ...state.buffers, [path]: { path, content: '', originalContent: '', language: '', preview: { downloadUrl, viewUrl }, size: meta?.size, mtime: meta?.mtime, createdAt: meta?.createdAt } }
          const idx = state.activeGroupIdx
          const cur = state.groups[idx]
          const tabs = cur.tabs.includes(path) ? cur.tabs : [...cur.tabs, path]
          const groups = state.groups.map((g, i) => i === idx ? { ...g, tabs, activeTab: path } : g)
          const next = { ...state, buffers, groups }
          return { buffers, groups, ...deriveActiveView(next) }
        })
      },

      openFileInGroup(groupIdx, path, content, language, mtime, meta) {
        set((state) => {
          if (groupIdx < 0 || groupIdx >= state.groups.length) return state
          const buffers = state.buffers[path]
            ? state.buffers
            : { ...state.buffers, [path]: { path, content, originalContent: content, language, mtime, size: meta?.size, createdAt: meta?.createdAt } }
          const cur = state.groups[groupIdx]
          const tabs = cur.tabs.includes(path) ? cur.tabs : [...cur.tabs, path]
          const groups = state.groups.map((g, i) => i === groupIdx ? { ...g, tabs, activeTab: path } : g)
          const activeGroupIdx = groupIdx
          const next = { ...state, buffers, groups, activeGroupIdx }
          return { buffers, groups, activeGroupIdx, ...deriveActiveView(next) }
        })
      },

      closeTab(path) {
        set((state) => {
          const groups = state.groups
            .map((g) => {
              if (!g.tabs.includes(path)) return g
              const tabs = g.tabs.filter((p) => p !== path)
              let activeTab = g.activeTab
              if (activeTab === path) {
                const oldIdx = g.tabs.indexOf(path)
                activeTab = tabs[Math.min(oldIdx, tabs.length - 1)] ?? null
              }
              return { ...g, tabs, activeTab }
            })
          const stillReferenced = groups.some((g) => g.tabs.includes(path))
          const buffers = stillReferenced ? state.buffers : (() => { const { [path]: _drop, ...rest } = state.buffers; return rest })()
          const modifiedPaths = stillReferenced ? state.modifiedPaths : (() => {
            if (!state.modifiedPaths.has(path)) return state.modifiedPaths
            const next = new Set(state.modifiedPaths); next.delete(path); return next
          })()
          // Collapse an empty right pane back into single-pane mode.
          const collapsed = groups.length > 1 && groups[1].tabs.length === 0
            ? { groups: [groups[0]], activeGroupIdx: 0 }
            : { groups, activeGroupIdx: Math.min(state.activeGroupIdx, groups.length - 1) }
          const next = { ...state, buffers, modifiedPaths, ...collapsed }
          return { buffers, modifiedPaths, ...collapsed, ...deriveActiveView(next) }
        })
      },

      closeTabIn(groupIdx, path) {
        set((state) => {
          if (groupIdx < 0 || groupIdx >= state.groups.length) return state
          const tgt = state.groups[groupIdx]
          if (!tgt.tabs.includes(path)) return state
          const tabs = tgt.tabs.filter((p) => p !== path)
          let activeTab = tgt.activeTab
          if (activeTab === path) {
            const oldIdx = tgt.tabs.indexOf(path)
            activeTab = tabs[Math.min(oldIdx, tabs.length - 1)] ?? null
          }
          let groups = state.groups.map((g, i) => i === groupIdx ? { ...g, tabs, activeTab } : g)
          let activeGroupIdx = state.activeGroupIdx
          // Empty right pane → collapse.
          if (groups.length > 1 && groups[1].tabs.length === 0) {
            groups = [groups[0]]
            activeGroupIdx = 0
          }
          const stillReferenced = groups.some((g) => g.tabs.includes(path))
          const buffers = stillReferenced ? state.buffers : (() => { const { [path]: _drop, ...rest } = state.buffers; return rest })()
          const modifiedPaths = stillReferenced ? state.modifiedPaths : (() => {
            if (!state.modifiedPaths.has(path)) return state.modifiedPaths
            const next = new Set(state.modifiedPaths); next.delete(path); return next
          })()
          const next = { ...state, groups, activeGroupIdx, buffers, modifiedPaths }
          return { groups, activeGroupIdx, buffers, modifiedPaths, ...deriveActiveView(next) }
        })
      },

      setActiveTab(path, groupIdx) {
        set((state) => {
          let targetIdx = groupIdx ?? -1
          if (targetIdx < 0) {
            // Prefer active group if it has the path; else the first group that does.
            const cur = state.groups[state.activeGroupIdx]
            if (cur?.tabs.includes(path)) targetIdx = state.activeGroupIdx
            else targetIdx = state.groups.findIndex((g) => g.tabs.includes(path))
          }
          if (targetIdx < 0) return state
          if (!state.groups[targetIdx].tabs.includes(path)) return state
          const groups = state.groups.map((g, i) => i === targetIdx ? { ...g, activeTab: path } : g)
          const activeGroupIdx = targetIdx
          const next = { ...state, groups, activeGroupIdx }
          return { groups, activeGroupIdx, ...deriveActiveView(next) }
        })
      },

      updateContent(path, content) {
        set((state) => {
          const buf = state.buffers[path]
          if (!buf) return state
          const modified = content !== buf.originalContent
          const buffers = { ...state.buffers, [path]: { ...buf, content, modified } }
          const modifiedPaths = new Set(state.modifiedPaths)
          if (modified) modifiedPaths.add(path)
          else modifiedPaths.delete(path)
          const next = { ...state, buffers, modifiedPaths }
          return { buffers, modifiedPaths, ...deriveActiveView(next) }
        })
      },

      setActiveGroup(groupIdx) {
        set((state) => {
          if (groupIdx < 0 || groupIdx >= state.groups.length) return state
          if (groupIdx === state.activeGroupIdx) return state
          const next = { ...state, activeGroupIdx: groupIdx }
          return { activeGroupIdx: groupIdx, ...deriveActiveView(next) }
        })
      },

      splitToRight(path) {
        set((state) => {
          if (state.groups.length >= 2) return state
          const sourcePath = path ?? state.groups[state.activeGroupIdx]?.activeTab ?? null
          if (!sourcePath) return state
          if (!state.buffers[sourcePath]) return state
          const right: EditorGroup = { id: newGroupId(), tabs: [sourcePath], activeTab: sourcePath }
          const groups = [state.groups[0], right]
          const activeGroupIdx = 1
          const next = { ...state, groups, activeGroupIdx }
          return { groups, activeGroupIdx, ...deriveActiveView(next) }
        })
      },

      closeGroup(groupIdx) {
        set((state) => {
          if (state.groups.length <= 1) return state
          if (groupIdx < 0 || groupIdx >= state.groups.length) return state
          const removed = state.groups[groupIdx]
          const groups = state.groups.filter((_, i) => i !== groupIdx)
          // Drop buffers that were only kept alive by the removed pane.
          const remainingPaths = new Set<string>()
          for (const g of groups) for (const p of g.tabs) remainingPaths.add(p)
          const buffers: Record<string, EditorBuffer> = {}
          for (const [p, b] of Object.entries(state.buffers)) {
            if (remainingPaths.has(p)) buffers[p] = b
          }
          const modifiedPaths = new Set<string>()
          for (const p of state.modifiedPaths) if (remainingPaths.has(p)) modifiedPaths.add(p)
          const activeGroupIdx = Math.max(0, Math.min(state.activeGroupIdx, groups.length - 1))
          const next = { ...state, groups, activeGroupIdx, buffers, modifiedPaths }
          // Reference `removed` so an inadvertent unused-var lint stays happy
          // (the destructuring above carries the intent — this is a no-op.)
          void removed
          return { groups, activeGroupIdx, buffers, modifiedPaths, ...deriveActiveView(next) }
        })
      },

      moveTabToGroup(srcGroupIdx, path, dstGroupIdx, insertAt) {
        set((state) => {
          if (srcGroupIdx === dstGroupIdx) {
            // Same-pane reorder.
            if (srcGroupIdx < 0 || srcGroupIdx >= state.groups.length) return state
            const cur = state.groups[srcGroupIdx]
            const fromIdx = cur.tabs.indexOf(path)
            if (fromIdx < 0) return state
            const toIdx = insertAt == null
              ? cur.tabs.length - 1
              : Math.max(0, Math.min(insertAt, cur.tabs.length - 1))
            if (fromIdx === toIdx) return state
            const tabs = spliceMove(cur.tabs, fromIdx, toIdx)
            const groups = state.groups.map((g, i) => i === srcGroupIdx ? { ...g, tabs, activeTab: path } : g)
            const next = { ...state, groups }
            return { groups, ...deriveActiveView(next) }
          }
          if (srcGroupIdx < 0 || srcGroupIdx >= state.groups.length) return state
          if (dstGroupIdx < 0 || dstGroupIdx > state.groups.length) return state
          const src = state.groups[srcGroupIdx]
          if (!src.tabs.includes(path)) return state
          // Build src after removing path.
          const srcTabs = src.tabs.filter((p) => p !== path)
          let srcActive = src.activeTab
          if (srcActive === path) {
            const oldIdx = src.tabs.indexOf(path)
            srcActive = srcTabs[Math.min(oldIdx, srcTabs.length - 1)] ?? null
          }
          // Build/extend dst.
          let groups = state.groups.slice()
          if (dstGroupIdx === state.groups.length) {
            // Drop into a new pane (only allowed when current count is 1).
            if (state.groups.length >= 2) return state
            groups[srcGroupIdx] = { ...src, tabs: srcTabs, activeTab: srcActive }
            groups.push({ id: newGroupId(), tabs: [path], activeTab: path })
          } else {
            const dst = groups[dstGroupIdx]
            const dstTabs = dst.tabs.includes(path)
              ? dst.tabs   // path already there — just activate.
              : (() => {
                  const arr = [...dst.tabs]
                  if (insertAt == null || insertAt >= arr.length) arr.push(path)
                  else arr.splice(Math.max(0, insertAt), 0, path)
                  return arr
                })()
            groups[srcGroupIdx] = { ...src, tabs: srcTabs, activeTab: srcActive }
            groups[dstGroupIdx] = { ...dst, tabs: dstTabs, activeTab: path }
          }
          let activeGroupIdx = dstGroupIdx
          // Collapse if src ended up empty.
          if (groups[srcGroupIdx].tabs.length === 0 && groups.length > 1) {
            // Drop the src pane.
            const newDst = dstGroupIdx > srcGroupIdx ? dstGroupIdx - 1 : dstGroupIdx
            groups = groups.filter((_, i) => i !== srcGroupIdx)
            activeGroupIdx = Math.max(0, Math.min(newDst, groups.length - 1))
          }
          const next = { ...state, groups, activeGroupIdx }
          return { groups, activeGroupIdx, ...deriveActiveView(next) }
        })
      },

      setFileTree(tree) {
        set({ fileTree: tree })
      },

      setDirChildren(dirPath, children) {
        set((state) => {
          if (!state.fileTree) return state
          const sorted = [...children].sort((a, b) => {
            if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
            return a.name.localeCompare(b.name)
          })
          const newTree = JSON.parse(JSON.stringify(state.fileTree)) as FileTreeNode
          if (!dirPath) {
            newTree.children = sorted
            newTree.hasChildren = sorted.length > 0
            return { fileTree: newTree }
          }
          const parts = dirPath.split('/').filter(Boolean)
          let current: FileTreeNode | undefined = newTree
          for (const part of parts) {
            if (!current?.children) return state
            current = current.children.find((c) => c.name === part && c.type === 'directory')
            if (!current) return state
          }
          current.children = sorted
          current.hasChildren = sorted.length > 0
          return { fileTree: newTree }
        })
      },

      markModified(path) {
        set((state) => {
          const buf = state.buffers[path]
          if (!buf) return state
          const modifiedPaths = new Set(state.modifiedPaths)
          modifiedPaths.add(path)
          const buffers = { ...state.buffers, [path]: { ...buf, modified: true } }
          const next = { ...state, buffers, modifiedPaths }
          return { buffers, modifiedPaths, ...deriveActiveView(next) }
        })
      },

      clearModified(path) {
        set((state) => {
          const buf = state.buffers[path]
          if (!buf) return state
          const modifiedPaths = new Set(state.modifiedPaths)
          modifiedPaths.delete(path)
          const buffers = { ...state.buffers, [path]: { ...buf, modified: false } }
          const next = { ...state, buffers, modifiedPaths }
          return { buffers, modifiedPaths, ...deriveActiveView(next) }
        })
      },

      markSaved(path, mtime) {
        set((state) => {
          const buf = state.buffers[path]
          if (!buf) return state
          const modifiedPaths = new Set(state.modifiedPaths)
          modifiedPaths.delete(path)
          const buffers = { ...state.buffers, [path]: { ...buf, originalContent: buf.content, modified: false, mtime: mtime ?? buf.mtime } }
          const next = { ...state, buffers, modifiedPaths }
          return { buffers, modifiedPaths, ...deriveActiveView(next) }
        })
      },

      setRejectedFile(path) {
        set({ rejectedFile: path })
      },

      setBottomTab(tab) {
        set({ bottomTab: tab })
      },

      pendingTerminalCwd: null,
      requestTerminalSpawn(cwd) {
        set({ pendingTerminalCwd: cwd })
      },
      consumeTerminalSpawn() {
        const cur = get().pendingTerminalCwd
        if (cur != null) set({ pendingTerminalCwd: null })
        return cur
      },

      toggleMaximized() {
        set((state) => {
          const next = !state.maximized
          if (typeof window !== 'undefined') {
            localStorage.setItem('halo_editor_maximized', String(next))
          }
          return { maximized: next }
        })
      },

      setMaximized(value) {
        if (typeof window !== 'undefined') {
          localStorage.setItem('halo_editor_maximized', String(value))
        }
        set({ maximized: value })
      },

      setBottomFloating(value) {
        if (typeof window !== 'undefined') {
          sessionStorage.setItem('halo_bottom_floating', String(value))
        }
        set({ bottomFloating: value })
      },

      setBottomMaximized(value) {
        set({ bottomMaximized: value })
      },

      setBottomFloatRect(rect) {
        if (typeof window !== 'undefined') {
          sessionStorage.setItem('halo_bottom_float_rect', JSON.stringify(rect))
        }
        set({ bottomFloatRect: rect })
      },

      insertFileNode(relativePath, nodeType = 'file') {
        set((state) => {
          if (!state.fileTree) return state
          const parts = relativePath.split('/').filter(Boolean)
          if (parts.length === 0) return state
          const newTree = JSON.parse(JSON.stringify(state.fileTree)) as FileTreeNode
          let current: FileTreeNode = newTree
          for (let i = 0; i < parts.length - 1; i++) {
            const child = current.children?.find((c) => c.name === parts[i] && c.type === 'directory')
            if (!child) {
              if (current.children === undefined) current.hasChildren = true
              return { fileTree: newTree }
            }
            current = child
          }
          if (current.children === undefined) {
            current.hasChildren = true
            return { fileTree: newTree }
          }
          const name = parts[parts.length - 1]
          if (current.children.some((c) => c.name === name)) return { fileTree: newTree }
          const newNode: FileTreeNode = nodeType === 'directory'
            ? { name, path: relativePath, type: 'directory', hasChildren: false, children: [] }
            : { name, path: relativePath, type: 'file' }
          current.children.push(newNode)
          current.children.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
            return a.name.localeCompare(b.name)
          })
          return { fileTree: newTree }
        })
      },

      removeFileNode(relativePath) {
        set((state) => {
          if (!state.fileTree) return state
          const parts = relativePath.split('/').filter(Boolean)
          if (parts.length === 0) return state
          const newTree = JSON.parse(JSON.stringify(state.fileTree)) as FileTreeNode
          let current = newTree
          for (let i = 0; i < parts.length - 1; i++) {
            const child = current.children?.find((c) => c.name === parts[i] && c.type === 'directory')
            if (!child) return state
            current = child
          }
          const targetName = parts[parts.length - 1]
          if (!current.children) return state
          const idx = current.children.findIndex((c) => c.name === targetName)
          if (idx === -1) return state
          current.children.splice(idx, 1)
          return { fileTree: newTree }
        })
      },

      async checkAndRefresh(path, diskMtime, fetchContent) {
        const buf = get().buffers[path]
        if (!buf || buf.preview) return false
        if (buf.mtime && diskMtime <= buf.mtime) return false
        if (buf.modified) return false
        const data = (await fetchContent()) as { content: string; modifiedAt: number; size?: number; createdAt?: number }
        set((state) => {
          const cur = state.buffers[path]
          if (!cur) return state
          const buffers = { ...state.buffers, [path]: { ...cur, content: data.content, originalContent: data.content, mtime: data.modifiedAt, size: data.size ?? cur.size, createdAt: data.createdAt ?? cur.createdAt } }
          const next = { ...state, buffers }
          return { buffers, ...deriveActiveView(next) }
        })
        return true
      },
    }
  })
}

export type EditorStoreApi = ReturnType<typeof createEditorStore>

/** Default singleton — backs the main Explorer workspace. */
export const useEditorStore: EditorStoreApi = createEditorStore()

const EditorStoreContext = createContext<EditorStoreApi | null>(null)

export function EditorStoreProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<EditorStoreApi | null>(null)
  if (!storeRef.current) storeRef.current = createEditorStore()
  return createElement(EditorStoreContext.Provider, { value: storeRef.current }, children)
}

export function useScopedEditorStore(): EditorStoreApi {
  const ctx = useContext(EditorStoreContext)
  return ctx ?? useEditorStore
}
