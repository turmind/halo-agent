'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * Combobox: trigger shows the selected value; clicking opens a dropdown
 * containing its own search input + scrollable preset list. Filtering is
 * driven by the dropdown's search input — the trigger always shows the
 * committed value.
 *
 * Editing the trigger directly is also supported (free-text combobox), and
 * any custom value (matching no preset) is committed verbatim on Enter or
 * blur. Presets are an aid, not a constraint.
 */
export function Combobox({
  value, disabled, presets, placeholder, onCommit, minWidth = 240, className,
}: {
  value: string
  disabled?: boolean
  presets: Array<{ id: string; label: string }>
  placeholder?: string
  onCommit: (next: string) => void
  minWidth?: number
  className?: string
}) {
  const [triggerValue, setTriggerValue] = useState(value)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [highlight, setHighlight] = useState(0)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => { setTriggerValue(value) }, [value])

  useEffect(() => {
    if (open) {
      setSearch('')
      setHighlight(0)
      setTimeout(() => searchRef.current?.focus(), 0)
    }
  }, [open])

  const filtered = useMemo(() => {
    if (!search) return presets
    const q = search.toLowerCase()
    return presets.filter((p) =>
      p.id.toLowerCase().includes(q) || p.label.toLowerCase().includes(q)
    )
  }, [search, presets])

  useEffect(() => {
    if (highlight >= filtered.length) setHighlight(0)
  }, [filtered.length, highlight])

  useEffect(() => {
    if (!open) return
    function onDocDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
  }, [open])

  function pick(id: string) {
    setTriggerValue(id)
    setOpen(false)
    if (id !== value) onCommit(id)
  }

  function commitTrigger() {
    if (triggerValue !== value) onCommit(triggerValue)
  }

  return (
    <div ref={wrapRef} className={`relative ${className ?? ''}`} style={{ minWidth }}>
      <input
        value={triggerValue}
        disabled={disabled}
        onFocus={() => setOpen(true)}
        onChange={(e) => setTriggerValue(e.target.value)}
        onBlur={() => {
          setTimeout(() => {
            if (!open) commitTrigger()
          }, 120)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true) }
          else if (e.key === 'Enter') { e.preventDefault(); commitTrigger() }
          else if (e.key === 'Escape') { setOpen(false) }
        }}
        placeholder={placeholder}
        className="h-7 w-full rounded border border-[var(--border)] bg-[var(--card)] px-2 pr-6 text-xs text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
      />
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] opacity-50">▾</span>

      {open && (
        <div className="absolute left-0 right-0 top-[calc(100%+2px)] z-20 max-h-72 overflow-hidden rounded border border-[var(--border)] bg-[var(--card)] shadow-lg">
          <div className="border-b border-[var(--border)] p-1">
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => { setSearch(e.target.value); setHighlight(0) }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((i) => Math.min(filtered.length - 1, i + 1)) }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((i) => Math.max(0, i - 1)) }
                else if (e.key === 'Enter') {
                  e.preventDefault()
                  const sel = filtered[highlight]
                  if (sel) pick(sel.id)
                }
                else if (e.key === 'Escape') { setOpen(false) }
              }}
              placeholder="Filter…"
              className="h-6 w-full rounded border border-[var(--border)] bg-[var(--background)] px-2 text-xs text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
            />
          </div>
          <div className="max-h-56 overflow-auto">
            {filtered.length === 0 ? (
              <div className="px-2 py-2 text-xs text-[var(--muted-foreground)]">No matches</div>
            ) : filtered.map((p, i) => (
              <div
                key={p.id}
                onMouseDown={(e) => { e.preventDefault(); pick(p.id) }}
                onMouseEnter={() => setHighlight(i)}
                className={`cursor-pointer px-2 py-1 text-xs ${
                  i === highlight
                    ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                    : 'text-[var(--foreground)] hover:bg-[var(--secondary)]'
                }`}
              >
                <div className="font-medium">{p.label}</div>
                {p.label !== p.id && (
                  <div className={`text-[10px] ${i === highlight ? 'opacity-80' : 'opacity-60'}`}>{p.id}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
