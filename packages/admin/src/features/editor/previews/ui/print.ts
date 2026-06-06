/**
 * Shared print helper — opens a pop-up window with HTML content and triggers print.
 */
export function printHtml(title: string, bodyHtml: string, bodyStyle = 'font-family:sans-serif;padding:40px;max-width:800px;margin:0 auto') {
  const win = window.open('', '_blank')
  if (!win) return
  win.document.write(
    `<!DOCTYPE html><html><head><title>${escapeHtml(title)}</title><style>body{${bodyStyle}}img{max-width:100%}</style></head><body>${bodyHtml}</body></html>`,
  )
  win.document.close()
  win.onload = () => { win.print() }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}
