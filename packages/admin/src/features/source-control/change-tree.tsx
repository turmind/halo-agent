'use client'

import { useState } from 'react'
import type { GitFileStatus } from './types'
import { statusMeta } from './status-meta'
import { cn } from '@/shared/utils'
import { getFileIcon } from '@/shared/file-icons'
import { ChevronRight, ChevronDown, Plus, Minus } from 'lucide-react'

type TreeNode = TreeDir | TreeLeaf
interface TreeDir {
  type: 'dir'
  name: string
  path: string
  children: TreeNode[]
}
interface TreeLeaf {
  type: 'file'
  name: string
  file: GitFileStatus
  /** The status char relevant to this group (index for staged, workingDir for changes). */
  char: string
}

/** Build a nested tree from flat changed paths, then compact single-child
 *  directory chains (VSCode's "a/b/c" folder collapsing). */
function buildTree(files: GitFileStatus[], charOf: (f: GitFileStatus) => string): TreeNode[] {
  const root: TreeDir = { type: 'dir', name: '', path: '', children: [] }
  for (const file of files) {
    const segments = file.path.split('/')
    let cur = root
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]
      const dirPath = cur.path ? `${cur.path}/${seg}` : seg
      let next = cur.children.find((c): c is TreeDir => c.type === 'dir' && c.name === seg)
      if (!next) {
        next = { type: 'dir', name: seg, path: dirPath, children: [] }
        cur.children.push(next)
      }
      cur = next
    }
    cur.children.push({ type: 'file', name: segments[segments.length - 1], file, char: charOf(file) })
  }
  compact(root)
  sortTree(root)
  return root.children
}

/** Merge a dir that has exactly one child dir into a single "parent/child" row. */
function compact(dir: TreeDir): void {
  for (const child of dir.children) {
    if (child.type === 'dir') compact(child)
  }
  // Re-compact this dir while it collapses into its single sub-dir.
  while (dir.children.length === 1 && dir.children[0].type === 'dir' && dir.name !== '') {
    const only = dir.children[0]
    dir.name = `${dir.name}/${only.name}`
    dir.path = only.path
    dir.children = only.children
  }
}

function sortTree(dir: TreeDir): void {
  dir.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  for (const child of dir.children) {
    if (child.type === 'dir') sortTree(child)
  }
}

interface ChangeTreeProps {
  files: GitFileStatus[]
  group: 'staged' | 'changes'
  selectedPath: string | null
  onSelect: (file: GitFileStatus) => void
  onAction: (paths: string[]) => void
}

export function ChangeTree({ files, group, selectedPath, onSelect, onAction }: ChangeTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const charOf = (f: GitFileStatus) => (group === 'staged' ? f.index : f.workingDir)
  const nodes = buildTree(files, charOf)

  function toggle(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function renderNode(node: TreeNode, depth: number): React.ReactNode {
    const pad = depth * 12 + 8
    if (node.type === 'dir') {
      const isCollapsed = collapsed.has(node.path)
      return (
        <div key={`d:${node.path}`}>
          <button
            onClick={() => toggle(node.path)}
            className="flex w-full items-center gap-1 py-0.5 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            style={{ paddingLeft: `${pad}px` }}
          >
            {isCollapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
            <span className="truncate">{node.name}</span>
          </button>
          {!isCollapsed && node.children.map((c) => renderNode(c, depth + 1))}
        </div>
      )
    }

    const meta = statusMeta(node.char)
    const isActive = selectedPath === node.file.path
    const ActionIcon = group === 'staged' ? Minus : Plus
    const { Icon, color } = getFileIcon(node.file.path)
    return (
      <div
        key={`f:${node.file.path}`}
        onClick={() => onSelect(node.file)}
        className={cn(
          'group flex w-full cursor-pointer items-center gap-1.5 py-0.5 pr-2 text-xs',
          isActive ? 'bg-[var(--accent)]' : 'hover:bg-[var(--accent)]',
        )}
        style={{ paddingLeft: `${pad + 16}px` }}
      >
        <Icon className={cn('h-3.5 w-3.5 shrink-0', color)} />
        <span className="truncate text-[var(--foreground)]" style={{ color: meta.color }}>
          {node.name}
        </span>
        <div className="flex-1" />
        <button
          onClick={(e) => {
            e.stopPropagation()
            onAction([node.file.path])
          }}
          title={group === 'staged' ? 'Unstage' : 'Stage'}
          className="hidden shrink-0 rounded p-0.5 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] group-hover:block"
        >
          <ActionIcon className="h-3.5 w-3.5" />
        </button>
        <span
          className="w-4 shrink-0 text-center font-mono text-[11px] font-semibold"
          style={{ color: meta.color }}
          title={meta.label}
        >
          {meta.letter}
        </span>
      </div>
    )
  }

  return <div>{nodes.map((n) => renderNode(n, 0))}</div>
}
