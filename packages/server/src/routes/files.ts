import { Hono } from 'hono'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import path from 'node:path'
import { homedir } from 'node:os'
import { Workspace, GitManager, type FileTreeNode } from '@turmind/halo-core'
import { isInTempDir } from '../channels/shared/media.js'

export function createFileRoutes() {
  const app = new Hono()

  async function resolveProjectPath(projectId: string): Promise<string | null> {
    if (path.isAbsolute(projectId)) {
      try {
        await fs.access(projectId)
        return projectId
      } catch {
        return null
      }
    }
    return null
  }

  // Validate that a resolved path is within the project workspace (prevent traversal).
  // Match on a path-segment boundary, not a raw string prefix — otherwise a sibling
  // dir whose name starts with the project name (e.g. `myapp-secret` vs `myapp`)
  // passes startsWith and escapes the sandbox.
  function validatePath(filePath: string, projectPath: string): boolean {
    const resolved = path.resolve(projectPath, filePath)
    const proj = path.resolve(projectPath)
    return resolved === proj || resolved.startsWith(proj + path.sep)
  }

  function isSkippedName(name: string): boolean {
    // Modern IDE convention (VS Code / Cursor / JetBrains): show every
    // dotfile users actually care about (.gitignore / .env / .vscode/),
    // hide only well-known noise that would dominate the tree.
    if (name === '.git') return true
    if (name === '.DS_Store') return true
    if (name === 'node_modules') return true
    if (name === '__pycache__') return true
    return false
  }

  async function dirHasChildren(dirPath: string): Promise<boolean> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        if (!isSkippedName(entry.name)) return true
      }
      return false
    } catch {
      return false
    }
  }

  async function listDir(dirPath: string, basePath: string): Promise<FileTreeNode[]> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true })
    } catch {
      return []
    }

    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1
      if (!a.isDirectory() && b.isDirectory()) return 1
      return a.name.localeCompare(b.name)
    })

    const nodes: FileTreeNode[] = []
    for (const entry of sorted) {
      if (isSkippedName(entry.name)) continue
      const fullPath = path.join(dirPath, entry.name)
      // Always emit POSIX-style relative paths: the browser-side file tree
      // navigates with `dirPath.split('/')`, so a Windows `\` separator from
      // path.relative() never matches and nested dirs (e.g. .halo/secrets)
      // would re-request forever → CPU spin. Tree paths are a web contract.
      const relativePath = path.relative(basePath, fullPath).split(path.sep).join('/')
      if (entry.isDirectory()) {
        nodes.push({
          name: entry.name,
          path: relativePath,
          type: 'directory',
          hasChildren: await dirHasChildren(fullPath),
        })
      } else if (entry.isFile()) {
        nodes.push({
          name: entry.name,
          path: relativePath,
          type: 'file',
        })
      }
    }
    return nodes
  }

  // GET /files/tree?projectId=xxx[&path=subdir] - List one level of children (lazy)
  app.get('/files/tree', async (c) => {
    try {
      const projectId = c.req.query('projectId')
      const relPath = c.req.query('path') ?? ''

      if (!projectId) {
        return c.json({ error: 'projectId is required' }, 400)
      }

      const projectPath = await resolveProjectPath(projectId)
      if (!projectPath) {
        return c.json({ error: 'Project not found' }, 404)
      }

      if (relPath && !validatePath(relPath, projectPath)) {
        return c.json({ error: 'Path traversal not allowed' }, 403)
      }

      const targetPath = relPath ? path.resolve(projectPath, relPath) : projectPath

      try {
        const stat = await fs.stat(targetPath)
        if (!stat.isDirectory()) {
          return c.json({ error: 'Path is not a directory' }, 400)
        }
      } catch {
        return c.json({ error: 'Directory not found' }, 404)
      }

      const tree = await listDir(targetPath, projectPath)

      return c.json({
        projectId,
        root: path.basename(projectPath),
        path: relPath,
        tree,
      })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Files] Error listing directory: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // GET /files/search?projectId=xxx&q=xxx[&limit=N] - Search files by name (recursive)
  app.get('/files/search', async (c) => {
    try {
      const projectId = c.req.query('projectId')
      const q = (c.req.query('q') ?? '').trim().toLowerCase()
      const limitRaw = parseInt(c.req.query('limit') ?? '200', 10)
      const limit = Math.min(Math.max(isNaN(limitRaw) ? 200 : limitRaw, 1), 1000)
      // dirsOnly powers the chat `@scope <dir>` completion — it targets a
      // directory (whose INSTRUCTIONS.md gets injected), never a file.
      const dirsOnly = c.req.query('dirsOnly') === '1'

      if (!projectId) {
        return c.json({ error: 'projectId is required' }, 400)
      }

      const resolvedProject = await resolveProjectPath(projectId)
      if (!resolvedProject) {
        return c.json({ error: 'Project not found' }, 404)
      }
      const projectRoot: string = resolvedProject

      const matches: Array<{ name: string; path: string }> = []
      let scanned = 0
      const MAX_SCAN = 50000

      async function walk(dirPath: string): Promise<void> {
        if (matches.length >= limit || scanned >= MAX_SCAN) return
        let entries: import('node:fs').Dirent[]
        try {
          entries = await fs.readdir(dirPath, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          if (matches.length >= limit || scanned >= MAX_SCAN) return
          if (isSkippedName(entry.name)) continue
          scanned++
          const fullPath = path.join(dirPath, entry.name)
          if (entry.isDirectory()) {
            if (dirsOnly) {
              const name = entry.name.toLowerCase()
              const rel = path.relative(projectRoot, fullPath)
              if (!q || name.includes(q) || rel.toLowerCase().includes(q)) {
                matches.push({ name: entry.name, path: rel })
              }
            }
            await walk(fullPath)
          } else if (entry.isFile() && !dirsOnly) {
            const name = entry.name.toLowerCase()
            const rel = path.relative(projectRoot, fullPath)
            if (!q || name.includes(q) || rel.toLowerCase().includes(q)) {
              matches.push({ name: entry.name, path: rel })
            }
          }
        }
      }

      await walk(projectRoot)

      if (q) {
        matches.sort((a, b) => {
          const an = a.name.toLowerCase()
          const bn = b.name.toLowerCase()
          const as = an.startsWith(q) ? 0 : 1
          const bs = bn.startsWith(q) ? 0 : 1
          if (as !== bs) return as - bs
          return an.localeCompare(bn)
        })
      }

      return c.json({ matches, truncated: matches.length >= limit || scanned >= MAX_SCAN })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Files] Error searching files: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // GET /files/diff?path=xxx&projectId=xxx - Get file diff from git
  app.get('/files/diff', async (c) => {
    try {
      const filePath = c.req.query('path')
      const projectId = c.req.query('projectId')

      if (!filePath || !projectId) {
        return c.json({ error: 'path and projectId are required' }, 400)
      }

      const projectPath = await resolveProjectPath(projectId)
      if (!projectPath) {
        return c.json({ error: 'Project not found' }, 404)
      }

      if (!validatePath(filePath, projectPath)) {
        return c.json({ error: 'Path traversal not allowed' }, 403)
      }

      try {
        // Create a project-specific GitManager for the diff
        const projectWorkspace = new Workspace(projectPath)
        const projectGit = new GitManager(projectWorkspace)
        const diff = await projectGit.getDiff(filePath)
        return c.json({
          path: filePath,
          diff,
        })
      } catch {
        // If git diff fails (e.g., file not tracked), return empty diff
        return c.json({
          path: filePath,
          diff: '',
          error: 'Could not get diff (file may not be tracked by git)',
        })
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Files] Error getting diff: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // POST /files/upload - Upload file(s) to project workspace
  app.post('/files/upload', async (c) => {
    try {
      const formData = await c.req.formData()
      const projectId = formData.get('projectId') as string
      const targetDir = (formData.get('targetDir') as string) ?? ''

      if (!projectId) {
        return c.json({ error: 'projectId is required' }, 400)
      }

      const projectPath = await resolveProjectPath(projectId)
      if (!projectPath) {
        return c.json({ error: 'Project not found' }, 404)
      }

      const files = formData.getAll('files') as File[]
      if (files.length === 0) {
        return c.json({ error: 'No files provided' }, 400)
      }

      const uploaded: { name: string; path: string; size: number }[] = []

      for (const file of files) {
        const relPath = targetDir ? path.join(targetDir, file.name) : file.name

        if (!validatePath(relPath, projectPath)) {
          continue // skip traversal attempts
        }

        const destPath = path.resolve(projectPath, relPath)
        const destDir = path.dirname(destPath)

        // Ensure directory exists
        await fs.mkdir(destDir, { recursive: true })

        // Write file
        const buffer = Buffer.from(await file.arrayBuffer())
        await fs.writeFile(destPath, buffer)

        uploaded.push({
          name: file.name,
          path: relPath,
          size: buffer.length,
        })
      }

      return c.json({ uploaded, count: uploaded.length })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Files] Error uploading: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // PUT /files - Save file content
  app.put('/files', async (c) => {
    try {
      const body = await c.req.json<{ path: string; content: string; projectId: string }>()
      const { path: filePath, content, projectId } = body

      if (!filePath || content === undefined || !projectId) {
        return c.json({ error: 'path, content, and projectId are required' }, 400)
      }

      const projectPath = await resolveProjectPath(projectId)
      if (!projectPath) {
        return c.json({ error: 'Project not found' }, 404)
      }

      if (!validatePath(filePath, projectPath)) {
        return c.json({ error: 'Path traversal not allowed' }, 403)
      }

      const absolutePath = path.resolve(projectPath, filePath)
      await fs.writeFile(absolutePath, content, 'utf-8')
      const stat = await fs.stat(absolutePath)

      return c.json({ ok: true, path: filePath, modifiedAt: stat.mtimeMs })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Files] Error saving file: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // POST /files/new - Create a new empty file
  app.post('/files/new', async (c) => {
    try {
      const body = await c.req.json<{ path: string; projectId: string }>()
      const { path: filePath, projectId } = body

      if (!filePath || !projectId) {
        return c.json({ error: 'path and projectId are required' }, 400)
      }

      const projectPath = await resolveProjectPath(projectId)
      if (!projectPath) {
        return c.json({ error: 'Project not found' }, 404)
      }

      if (!validatePath(filePath, projectPath)) {
        return c.json({ error: 'Path traversal not allowed' }, 403)
      }

      const absolutePath = path.resolve(projectPath, filePath)

      // Ensure parent directory exists
      await fs.mkdir(path.dirname(absolutePath), { recursive: true })

      // Check if file already exists
      try {
        await fs.access(absolutePath)
        return c.json({ error: 'File already exists' }, 409)
      } catch {
        // File doesn't exist — good
      }

      await fs.writeFile(absolutePath, '', 'utf-8')
      return c.json({ ok: true, path: filePath })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Files] Error creating file: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // POST /files/mkdir - Create a new directory
  app.post('/files/mkdir', async (c) => {
    try {
      const body = await c.req.json<{ path: string; projectId: string }>()
      const { path: dirPath, projectId } = body

      if (!dirPath || !projectId) {
        return c.json({ error: 'path and projectId are required' }, 400)
      }

      const projectPath = await resolveProjectPath(projectId)
      if (!projectPath) {
        return c.json({ error: 'Project not found' }, 404)
      }

      if (!validatePath(dirPath, projectPath)) {
        return c.json({ error: 'Path traversal not allowed' }, 403)
      }

      const absolutePath = path.resolve(projectPath, dirPath)
      await fs.mkdir(absolutePath, { recursive: true })

      return c.json({ ok: true, path: dirPath })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Files] Error creating directory: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // POST /files/rename - Rename / move a file or directory
  app.post('/files/rename', async (c) => {
    try {
      const body = await c.req.json<{ oldPath: string; newPath: string; projectId: string }>()
      const { oldPath, newPath, projectId } = body

      if (!oldPath || !newPath || !projectId) {
        return c.json({ error: 'oldPath, newPath, and projectId are required' }, 400)
      }

      const projectPath = await resolveProjectPath(projectId)
      if (!projectPath) {
        return c.json({ error: 'Project not found' }, 404)
      }

      if (!validatePath(oldPath, projectPath) || !validatePath(newPath, projectPath)) {
        return c.json({ error: 'Path traversal not allowed' }, 403)
      }

      const absOld = path.resolve(projectPath, oldPath)
      const absNew = path.resolve(projectPath, newPath)

      // Ensure parent of target exists
      await fs.mkdir(path.dirname(absNew), { recursive: true })
      await fs.rename(absOld, absNew)

      return c.json({ ok: true, oldPath, newPath })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Files] Error renaming: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // DELETE /files?path=xxx&projectId=xxx - Delete a file or directory
  app.delete('/files', async (c) => {
    try {
      const filePath = c.req.query('path')
      const projectId = c.req.query('projectId')

      if (!filePath || !projectId) {
        return c.json({ error: 'path and projectId are required' }, 400)
      }

      const projectPath = await resolveProjectPath(projectId)
      if (!projectPath) {
        return c.json({ error: 'Project not found' }, 404)
      }

      if (!validatePath(filePath, projectPath)) {
        return c.json({ error: 'Path traversal not allowed' }, 403)
      }

      const absolutePath = path.resolve(projectPath, filePath)
      // Prevent deleting the project root
      if (absolutePath === path.resolve(projectPath)) {
        return c.json({ error: 'Cannot delete project root' }, 403)
      }

      await fs.rm(absolutePath, { recursive: true, force: true })
      return c.json({ ok: true, path: filePath })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Files] Error deleting: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // Extension → MIME type for inline viewing
  const MIME_MAP: Record<string, string> = {
    pdf: 'application/pdf',
    html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
    mp4: 'video/mp4', webm: 'video/webm', ogg: 'video/ogg', mov: 'video/quicktime',
    mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac', m4a: 'audio/mp4',
  }

  // GET /files/download?path=xxx&projectId=xxx&inline=1 - Download or view a file
  app.get('/files/download', async (c) => {
    try {
      const filePath = c.req.query('path')
      const projectId = c.req.query('projectId')
      const inline = c.req.query('inline') === '1'

      if (!filePath || !projectId) {
        return c.json({ error: 'path and projectId are required' }, 400)
      }

      const projectPath = await resolveProjectPath(projectId)
      if (!projectPath) {
        return c.json({ error: 'Project not found' }, 404)
      }

      // Agents sometimes save working files to the OS temp dir (e.g. Playwright
      // screenshots) and reference them via MEDIA:... — allow inline preview of those.
      const isTmp = path.isAbsolute(filePath) && isInTempDir(filePath)
      if (!isTmp && !validatePath(filePath, projectPath)) {
        return c.json({ error: 'Path traversal not allowed' }, 403)
      }

      const absolutePath = isTmp ? path.resolve(filePath) : path.resolve(projectPath, filePath)
      const stat = await fs.stat(absolutePath)
      if (stat.isDirectory()) {
        return c.json({ error: 'Cannot download a directory' }, 400)
      }

      const fileName = path.basename(filePath)
      const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
      const mime = inline ? (MIME_MAP[ext] ?? 'application/octet-stream') : 'application/octet-stream'
      const disposition = inline ? `inline; filename="${encodeURIComponent(fileName)}"` : `attachment; filename="${encodeURIComponent(fileName)}"`
      const fileSize = stat.size

      // Parse Range header for video/audio seeking and partial loads
      const rangeHeader = c.req.header('range')
      let start = 0
      let end = fileSize - 1
      let status: 200 | 206 = 200
      if (rangeHeader) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader)
        if (match) {
          start = parseInt(match[1], 10)
          end = match[2] ? parseInt(match[2], 10) : fileSize - 1
          if (isNaN(start) || isNaN(end) || start > end || end >= fileSize) {
            return new Response(null, {
              status: 416,
              headers: { 'Content-Range': `bytes */${fileSize}` },
            })
          }
          status = 206
        }
      }
      const chunkSize = fileSize === 0 ? 0 : end - start + 1

      // Empty file: createReadStream with { start: 0, end: -1 } throws
      // ERR_OUT_OF_RANGE on Node, so serve an empty body instead.
      const nodeStream = fileSize === 0 ? Readable.from([]) : createReadStream(absolutePath, { start, end })
      // Abort the read when the client disconnects (tab closed, navigation, etc.)
      const req = c.req.raw
      if (req.signal) {
        req.signal.addEventListener('abort', () => {
          nodeStream.destroy()
        }, { once: true })
      }
      const webStream = Readable.toWeb(nodeStream) as ReadableStream

      const headers: Record<string, string> = {
        'Content-Type': mime,
        'Content-Disposition': disposition,
        'Content-Length': String(chunkSize),
        'Accept-Ranges': 'bytes',
      }
      if (status === 206) {
        headers['Content-Range'] = `bytes ${start}-${end}/${fileSize}`
      }

      return new Response(webStream, { status, headers })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Files] Error downloading: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // GET /files/stat?path=xxx&projectId=xxx - Get file mtime only (lightweight)
  app.get('/files/stat', async (c) => {
    try {
      const filePath = c.req.query('path')
      const projectId = c.req.query('projectId')
      if (!filePath || !projectId) return c.json({ error: 'path and projectId are required' }, 400)
      const projectPath = await resolveProjectPath(projectId)
      if (!projectPath) return c.json({ error: 'Project not found' }, 404)
      if (!validatePath(filePath, projectPath)) return c.json({ error: 'Path traversal not allowed' }, 403)
      const absolutePath = path.resolve(projectPath, filePath)
      const stat = await fs.stat(absolutePath)
      return c.json({ path: filePath, modifiedAt: stat.mtimeMs, createdAt: stat.birthtimeMs, size: stat.size })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return c.json({ error: 'File not found' }, 404)
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // GET /files?path=xxx&projectId=xxx - Read file content
  app.get('/files', async (c) => {
    try {
      const filePath = c.req.query('path')
      const projectId = c.req.query('projectId')

      if (!filePath || !projectId) {
        return c.json({ error: 'path and projectId are required' }, 400)
      }

      const projectPath = await resolveProjectPath(projectId)
      if (!projectPath) {
        return c.json({ error: 'Project not found' }, 404)
      }

      if (!validatePath(filePath, projectPath)) {
        return c.json({ error: 'Path traversal not allowed' }, 403)
      }

      const absolutePath = path.resolve(projectPath, filePath)

      try {
        const stat = await fs.stat(absolutePath)
        if (stat.isDirectory()) {
          return c.json({ error: 'Path is a directory, use /files/tree instead' }, 400)
        }

        // Check file size to avoid reading huge files
        const maxSize = 10 * 1024 * 1024 // 10MB
        if (stat.size > maxSize) {
          return c.json({ error: 'File too large (max 10MB)' }, 413)
        }

        const content = await fs.readFile(absolutePath, 'utf-8')
        return c.json({
          path: filePath,
          content,
          size: stat.size,
          modifiedAt: stat.mtimeMs,
          createdAt: stat.birthtimeMs,
        })
      } catch (readErr) {
        if ((readErr as NodeJS.ErrnoException).code === 'ENOENT') {
          return c.json({ error: 'File not found' }, 404)
        }
        throw readErr
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Files] Error reading file: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // ── Filesystem browse (not sandboxed to a project — used by folder picker) ──

  // GET /fs/home — return the user's home directory path, for defaults
  app.get('/fs/home', (c) => {
    return c.json({ home: homedir() })
  })

  app.post('/fs/workspace/resolve', async (c) => {
    const body = await c.req.json<{ path: string }>()
    if (!body.path) return c.json({ error: 'path required' }, 400)
    const resolved = (await import('node:path')).default.resolve(body.path)
    const { existsSync } = await import('node:fs')
    if (!existsSync(resolved)) return c.json({ error: 'path not found' }, 404)
    const { ensureWorkspaceHalo } = await import('../init.js')
    ensureWorkspaceHalo(resolved)
    return c.json({ id: resolved, path: resolved })
  })

  // GET /fs/exists?path=/abs — check if a path exists and is a directory
  app.get('/fs/exists', async (c) => {
    const target = c.req.query('path')
    if (!target || !path.isAbsolute(target)) return c.json({ exists: false, reason: 'absolute path required' })
    try {
      const stat = await fs.stat(target)
      return c.json({ exists: true, isDirectory: stat.isDirectory() })
    } catch {
      return c.json({ exists: false })
    }
  })

  // GET /fs/browse?path=/abs — list immediate directory children for the folder picker
  app.get('/fs/browse', async (c) => {
    const target = c.req.query('path') ?? homedir()
    if (!path.isAbsolute(target)) return c.json({ error: 'absolute path required' }, 400)
    try {
      const resolved = path.resolve(target)
      const entries = await fs.readdir(resolved, { withFileTypes: true })
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, path: path.join(resolved, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name))
      return c.json({ path: resolved, parent: path.dirname(resolved), entries: dirs })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404)
    }
  })

  return app
}
