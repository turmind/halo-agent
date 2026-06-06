const API_BASE = '/api'

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`API error ${res.status}: ${body || res.statusText}`)
  }
  return res.json()
}

export const api = {
  health: () => fetch(`${API_BASE}/health`).then((r) => r.json()),

  chat: {
    send(sessionId: string, projectId: string, message: string): Promise<Response> {
      return fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, projectId, message }),
      })
    },

    getHistory(sessionId: string) {
      return request<{ messages: Array<{ role: string; content: string; timestamp: number }> }>(
        `/chat/${sessionId}/history`,
      )
    },
  },

  tasks: {
    get(planId: string) {
      return request<{ plan: Record<string, unknown> }>(`/tasks/${planId}`)
    },

    approve(planId: string) {
      return request<{ ok: boolean }>(`/tasks/${planId}/approve`, {
        method: 'POST',
      })
    },

    reject(planId: string, feedback: string) {
      return request<{ ok: boolean }>(`/tasks/${planId}/reject`, {
        method: 'POST',
        body: JSON.stringify({ feedback }),
      })
    },
  },

  agents: {
    list() {
      return request<{ agents: Array<Record<string, unknown>> }>('/agents')
    },

    get(id: string) {
      return request<{ agent: Record<string, unknown> }>(`/agents/${id}`)
    },

    create(data: Record<string, unknown>) {
      return request<{ agent: Record<string, unknown> }>('/agents', {
        method: 'POST',
        body: JSON.stringify(data),
      })
    },

    update(id: string, data: Record<string, unknown>) {
      return request<{ agent: Record<string, unknown> }>(`/agents/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      })
    },

    remove(id: string) {
      return request<{ ok: boolean }>(`/agents/${id}`, {
        method: 'DELETE',
      })
    },
  },

  fs: {
    home() {
      return request<{ home: string }>('/fs/home')
    },
    exists(path: string) {
      return request<{ exists: boolean; isDirectory?: boolean; reason?: string }>(
        `/fs/exists?path=${encodeURIComponent(path)}`,
      )
    },
    browse(path: string) {
      return request<{ path: string; parent: string; entries: Array<{ name: string; path: string }> }>(
        `/fs/browse?path=${encodeURIComponent(path)}`,
      )
    },
    resolveWorkspace(path: string) {
      return request<{ id: string; path: string }>('/fs/workspace/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      })
    },
  },

  files: {
    read(path: string, projectId: string) {
      return request<{ content: string; path: string; size: number; modifiedAt: number; createdAt: number }>(
        `/files?path=${encodeURIComponent(path)}&projectId=${encodeURIComponent(projectId)}`,
      )
    },

    /** Lightweight stat — only returns mtime, no content */
    stat(path: string, projectId: string) {
      return request<{ path: string; modifiedAt: number; createdAt: number; size: number }>(
        `/files/stat?path=${encodeURIComponent(path)}&projectId=${encodeURIComponent(projectId)}`,
      )
    },

    tree(projectId: string, dirPath?: string) {
      const params = new URLSearchParams()
      params.set('projectId', projectId)
      if (dirPath) params.set('path', dirPath)
      return request<{
        projectId: string
        root: string
        path: string
        tree: Array<{
          name: string
          path: string
          type: 'file' | 'directory'
          hasChildren?: boolean
        }>
      }>(`/files/tree?${params.toString()}`)
    },

    search(projectId: string, query: string, limit?: number, dirsOnly?: boolean) {
      const params = new URLSearchParams()
      params.set('projectId', projectId)
      params.set('q', query)
      if (limit) params.set('limit', String(limit))
      if (dirsOnly) params.set('dirsOnly', '1')
      return request<{
        matches: Array<{ name: string; path: string }>
        truncated: boolean
      }>(`/files/search?${params.toString()}`)
    },

    /**
     * Upload one or more files to the workspace's `.halo/uploads/`.
     *
     * Uses XMLHttpRequest rather than `fetch` because the fetch spec still
     * provides no way to observe request body upload progress (whatwg/fetch
     * #607). XHR's `upload.onprogress` fires with real loaded/total byte
     * counts as the browser ships the multipart body to the server, so the
     * caller can drive an accurate progress bar without faking it.
     *
     * `onProgress` is called with values in [0..1]. Total may be 0 in rare
     * cases (`event.lengthComputable === false`); callers should treat that
     * as "indeterminate" and render a spinner instead of a bar.
     */
    upload(
      files: File[],
      projectId: string,
      targetDir?: string,
      onProgress?: (loaded: number, total: number) => void,
    ): Promise<{ uploaded: { name: string; path: string; size: number }[]; count: number }> {
      const formData = new FormData()
      formData.append('projectId', projectId)
      if (targetDir) formData.append('targetDir', targetDir)
      for (const file of files) {
        formData.append('files', file)
      }
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', `${API_BASE}/files/upload`)
        xhr.withCredentials = true
        // `upload.onprogress` is the browser → server byte counter. Note
        // that *download* progress (`xhr.onprogress`) covers the response
        // body and is small for our use (just the JSON ack), so we ignore
        // it. After 100% upload there's a brief pause while the server
        // validates and writes to disk; the UI typically shows "Saving…"
        // during that gap if the caller wants.
        xhr.upload.onprogress = (event) => {
          if (!onProgress) return
          if (event.lengthComputable) onProgress(event.loaded, event.total)
          else onProgress(event.loaded, 0)
        }
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve(JSON.parse(xhr.responseText)) } catch (err) { reject(err) }
          } else {
            reject(new Error(`Upload failed: ${xhr.status} ${xhr.statusText}`))
          }
        }
        xhr.onerror = () => reject(new Error('Upload failed: network error'))
        xhr.onabort = () => reject(new Error('Upload aborted'))
        xhr.send(formData)
      })
    },

    save(path: string, content: string, projectId: string) {
      return request<{ ok: boolean; path: string; modifiedAt: number }>('/files', {
        method: 'PUT',
        body: JSON.stringify({ path, content, projectId }),
      })
    },

    create(path: string, projectId: string) {
      return request<{ ok: boolean; path: string }>('/files/new', {
        method: 'POST',
        body: JSON.stringify({ path, projectId }),
      })
    },

    mkdir(path: string, projectId: string) {
      return request<{ ok: boolean; path: string }>('/files/mkdir', {
        method: 'POST',
        body: JSON.stringify({ path, projectId }),
      })
    },

    rename(oldPath: string, newPath: string, projectId: string) {
      return request<{ ok: boolean }>('/files/rename', {
        method: 'POST',
        body: JSON.stringify({ oldPath, newPath, projectId }),
      })
    },

    remove(path: string, projectId: string) {
      return request<{ ok: boolean }>(
        `/files?path=${encodeURIComponent(path)}&projectId=${encodeURIComponent(projectId)}`,
        { method: 'DELETE' },
      )
    },

    downloadUrl(path: string, projectId: string) {
      return `/api/files/download?path=${encodeURIComponent(path)}&projectId=${encodeURIComponent(projectId)}`
    },

    viewUrl(path: string, projectId: string) {
      return `/api/files/download?path=${encodeURIComponent(path)}&projectId=${encodeURIComponent(projectId)}&inline=1`
    },

    diff(path: string, projectId: string) {
      return request<{ diff: string; original: string; modified: string }>(
        `/files/diff?path=${encodeURIComponent(path)}&projectId=${encodeURIComponent(projectId)}`,
      )
    },
  },

  agentConfigs: {
    list(projectId?: string) {
      const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
      return request<{ agents: Array<{ id: string; name: string; description: string; model: string; path: string; scope: 'global' | 'workspace'; priority: number; overridden?: boolean }> }>(`/agent-configs${qs}`)
    },
    create(data: { name: string; description?: string; scope?: 'global' | 'workspace'; projectId?: string }) {
      return request<{ agent: { id: string; name: string; description: string; model: string; path: string; scope: 'global' | 'workspace' } }>('/agent-configs', { method: 'POST', body: JSON.stringify(data) })
    },
    getYaml(id: string, opts?: { scope?: string; projectId?: string }) {
      const params = new URLSearchParams()
      if (opts?.scope) params.set('scope', opts.scope)
      if (opts?.projectId) params.set('projectId', opts.projectId)
      const qs = params.toString() ? `?${params}` : ''
      return request<{ yaml: string }>(`/agent-configs/${id}/yaml${qs}`)
    },
    saveYaml(id: string, yaml: string, opts?: { scope?: string; projectId?: string }) {
      return request<{ agent: Record<string, unknown> }>(`/agent-configs/${id}/yaml`, {
        method: 'PUT',
        body: JSON.stringify({ yaml, scope: opts?.scope, projectId: opts?.projectId }),
      })
    },
    remove(id: string, opts?: { scope?: string; projectId?: string }) {
      const params = new URLSearchParams()
      if (opts?.scope) params.set('scope', opts.scope)
      if (opts?.projectId) params.set('projectId', opts.projectId)
      const qs = params.toString() ? `?${params}` : ''
      return request<{ ok: boolean }>(`/agent-configs/${id}${qs}`, { method: 'DELETE' })
    },
    toggle(id: string, opts?: { scope?: string; projectId?: string }) {
      const params = new URLSearchParams()
      if (opts?.scope) params.set('scope', opts.scope)
      if (opts?.projectId) params.set('projectId', opts.projectId)
      const qs = params.toString() ? `?${params}` : ''
      return request<{ ok: boolean; disabled: boolean }>(`/agent-configs/${id}/toggle${qs}`, { method: 'PATCH' })
    },
    tools() {
      return request<{ tools: Array<{ name: string; description: string }> }>('/agent-configs/tools')
    },
    models() {
      return request<{
        providers: Array<{
          id: string
          displayName?: string
          description?: string
          defaultEndpoint?: string
          endpointPresets?: string[]
          models: Array<{
            id: string
            displayName?: string
            maxOutputTokens?: number
            capabilities?: {
              image?: boolean
              video?: boolean
              audio?: boolean
              promptCaching?: { ttlPresets?: Array<{ value: string; label: string }> }
              thinking?: { effortPresets?: Array<{ value: string; label: string }> }
              verbosity?: { default?: string; presets?: Array<{ value: string; label: string }> }
            }
          }>
        }>
      }>('/agent-configs/models')
    },
    /** Get a single MD file (AGENT.md, MEMORY.md, INSTRUCTIONS.md, RULES.md) */
    getMdFile(id: string, fileType: string, opts?: { scope?: string; projectId?: string }) {
      const params = new URLSearchParams()
      if (opts?.scope) params.set('scope', opts.scope)
      if (opts?.projectId) params.set('projectId', opts.projectId)
      const qs = params.toString() ? `?${params}` : ''
      return request<{ content: string; exists: boolean; path: string | null }>(`/agent-configs/${id}/md/${fileType}${qs}`)
    },
    /** Save a single MD file */
    saveMdFile(id: string, fileType: string, content: string, opts?: { scope?: string; projectId?: string }) {
      return request<{ ok: boolean; path: string }>(`/agent-configs/${id}/md/${fileType}`, {
        method: 'PUT',
        body: JSON.stringify({ content, scope: opts?.scope, projectId: opts?.projectId }),
      })
    },
    /** Get all MD files at once */
    getMdAll(id: string, opts?: { scope?: string; projectId?: string }) {
      const params = new URLSearchParams()
      if (opts?.scope) params.set('scope', opts.scope)
      if (opts?.projectId) params.set('projectId', opts.projectId)
      const qs = params.toString() ? `?${params}` : ''
      return request<{ files: Record<string, { content: string; exists: boolean; path: string | null; readOnly?: boolean }> }>(`/agent-configs/${id}/md-all${qs}`)
    },
    /** List sessions for an agent (metadata only, time desc) */
    listSessions(agentId: string, opts?: { projectId?: string; source?: string }) {
      const params = new URLSearchParams()
      if (opts?.projectId) params.set('projectId', opts.projectId)
      if (opts?.source) params.set('source', opts.source)
      const qs = params.toString() ? `?${params}` : ''
      return request<{ sessions: Array<{ id: string; agentId: string; agentName: string; title: string; source: string; createdAt: string; updatedAt: string; messageCount: number; agentSnapshot: Record<string, unknown> }> }>(`/agent-configs/${agentId}/sessions${qs}`)
    },
    /** Get full session with messages */
    getSession(agentId: string, sessionId: string, opts?: { projectId?: string; source?: string }) {
      const params = new URLSearchParams()
      if (opts?.projectId) params.set('projectId', opts.projectId)
      if (opts?.source) params.set('source', opts.source)
      const qs = params.toString() ? `?${params}` : ''
      return request<{ session: Record<string, unknown> }>(`/agent-configs/${agentId}/sessions/${sessionId}${qs}`)
    },
    /** Save/update a session */
    saveSession(agentId: string, data: Record<string, unknown>) {
      return request<{ id: string; session: Record<string, unknown> }>(`/agent-configs/${agentId}/sessions`, {
        method: 'POST',
        body: JSON.stringify(data),
      })
    },
    /** Delete a session */
    deleteSession(agentId: string, sessionId: string, opts?: { projectId?: string; source?: string }) {
      const params = new URLSearchParams()
      if (opts?.projectId) params.set('projectId', opts.projectId)
      if (opts?.source) params.set('source', opts.source)
      const qs = params.toString() ? `?${params}` : ''
      return request<{ ok: boolean }>(`/agent-configs/${agentId}/sessions/${sessionId}${qs}`, { method: 'DELETE' })
    },
    /** Delete all sessions for an agent+source */
    deleteAllSessions(agentId: string, opts?: { projectId?: string; source?: string }) {
      const params = new URLSearchParams()
      if (opts?.projectId) params.set('projectId', opts.projectId)
      if (opts?.source) params.set('source', opts.source)
      params.set('all', '1')
      const qs = `?${params}`
      return request<{ ok: boolean; deleted: number }>(`/agent-configs/${agentId}/sessions${qs}`, { method: 'DELETE' })
    },
  },

  /** Unified session logs — paginated, db-backed */
  sessionLogs: {
    /**
     * List session log entries with cursor pagination.
     *
     * Default: top-level only (parent_id IS NULL). Pass `parentId` to fetch
     * direct children of a session (used by sidebar lazy-expand). Pass
     * `parentId: '*'` to ignore the parent filter (rare; admin tools).
     *
     * `cursor` is the previous page's `nextCursor` (epoch ms of the last
     * row's updatedAt). Omit for the first page.
     */
    list(projectId?: string, opts?: { includeArchived?: boolean; parentId?: string | '*'; rootOnly?: boolean; cursor?: number; limit?: number }) {
      const params = new URLSearchParams()
      if (projectId) params.set('projectId', projectId)
      if (opts?.includeArchived) params.set('includeArchived', '1')
      if (opts?.parentId !== undefined) params.set('parentId', opts.parentId)
      if (opts?.rootOnly) params.set('rootOnly', '1')
      if (opts?.cursor !== undefined) params.set('cursor', String(opts.cursor))
      if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
      const qs = params.toString() ? `?${params}` : ''
      return request<{
        sessions: Array<{ id: string; agentId: string; agentName: string; title: string; createdAt: number; updatedAt: number; messageCount: number; parentSessionId?: string; stoppedAt?: number | null; archivedAt?: number | null; contextTokens?: number; totalOutputTokens?: number }>
        nextCursor: number | null
      }>(`/sessions/logs${qs}`)
    },
    /** Get full session log by ID */
    get(sessionId: string, projectId?: string) {
      const params = new URLSearchParams()
      if (projectId) params.set('projectId', projectId)
      const qs = params.toString() ? `?${params}` : ''
      return request<Record<string, unknown>>(`/sessions/logs/${sessionId}${qs}`)
    },
    /** Delete a session log file */
    delete(sessionId: string, projectId?: string) {
      const params = new URLSearchParams()
      if (projectId) params.set('projectId', projectId)
      const qs = params.toString() ? `?${params}` : ''
      return request<{ ok: boolean }>(`/sessions/logs/${sessionId}${qs}`, { method: 'DELETE' })
    },
  },

  commands: {
    list(projectId?: string, sessionId?: string, agentId?: string) {
      const params = new URLSearchParams()
      if (projectId) params.set('projectId', projectId)
      if (sessionId) params.set('sessionId', sessionId)
      if (agentId) params.set('agentId', agentId)
      const qs = params.toString() ? `?${params.toString()}` : ''
      return request<{ commands: Array<{ name: string; slashName: string; description: string; type: 'server' | 'client'; argHint?: string; source: 'builtin' | 'skill'; skillId?: string }> }>(`/commands${qs}`)
    },
  },

  skills: {
    list(projectId?: string) {
      const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
      return request<{ skills: Array<{ id: string; name: string; description: string; path: string; scope: 'global' | 'workspace' }> }>(`/skills${qs}`)
    },
    create(data: { name: string; description?: string; scope?: 'global' | 'workspace'; projectId?: string }) {
      return request<{ skill: { id: string; name: string; description: string; path: string; scope: 'global' | 'workspace' } }>('/skills', { method: 'POST', body: JSON.stringify(data) })
    },
    remove(id: string, opts?: { scope?: 'workspace'; projectId?: string }) {
      const params = new URLSearchParams()
      if (opts?.scope) params.set('scope', opts.scope)
      if (opts?.projectId) params.set('projectId', opts.projectId)
      const qs = params.toString() ? `?${params}` : ''
      return request<{ ok: boolean }>(`/skills/${id}${qs}`, { method: 'DELETE' })
    },
    toggle(id: string, opts?: { scope?: string; projectId?: string }) {
      const params = new URLSearchParams()
      if (opts?.scope) params.set('scope', opts.scope)
      if (opts?.projectId) params.set('projectId', opts.projectId)
      const qs = params.toString() ? `?${params}` : ''
      return request<{ ok: boolean; disabled: boolean }>(`/skills/${id}/toggle${qs}`, { method: 'PATCH' })
    },
  },

  projects: {
    list() {
      return request<{ projects: Array<{ id: string; name: string; path: string; createdAt: number }> }>(
        '/projects',
      )
    },

    create(name: string) {
      return request<{ project: { id: string; name: string; path: string; createdAt: number } }>(
        '/projects',
        {
          method: 'POST',
          body: JSON.stringify({ name }),
        },
      )
    },

    get(id: string) {
      return request<{ project: { id: string; name: string; path: string; createdAt: number } }>(
        `/projects/${id}`,
      )
    },
  },

  weixin: {
    listAccounts() {
      return request<{ accounts: Array<{
        accountId: string
        baseUrl: string
        userId: string
        workspacePath: string
        label: string
        enabled: boolean
        accessLevel: 'full' | 'workspace' | 'readonly'
        language: 'en' | 'zh'
        createdAt: number
        updatedAt: number
      }> }>('/weixin/accounts')
    },
    startLogin(sessionKey?: string) {
      return request<{ qrcodeUrl?: string; message: string; sessionKey: string }>(
        '/weixin/login/start',
        { method: 'POST', body: JSON.stringify({ sessionKey }) },
      )
    },
    waitLogin(params: { sessionKey: string; workspacePath: string; label?: string; accessLevel?: 'full' | 'workspace' | 'readonly'; language?: string; timeoutMs?: number }) {
      return request<{ connected: boolean; accountId?: string; message: string }>(
        '/weixin/login/wait',
        { method: 'POST', body: JSON.stringify(params) },
      )
    },
    updateAccount(accountId: string, patch: { label?: string; workspacePath?: string; enabled?: boolean; accessLevel?: 'full' | 'workspace' | 'readonly'; language?: string }) {
      return request<{ ok: boolean }>(`/weixin/accounts/${encodeURIComponent(accountId)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
    },
    deleteAccount(accountId: string) {
      return request<{ ok: boolean }>(`/weixin/accounts/${encodeURIComponent(accountId)}`, {
        method: 'DELETE',
      })
    },
  },

  telegram: {
    listAccounts() {
      return request<{ accounts: Array<{
        accountId: string
        botUsername: string
        workspacePath: string
        workspaceMissing: boolean
        label: string
        enabled: number
        accessLevel: 'full' | 'workspace' | 'readonly'
        allowedUsers: string
        language: string
        createdAt: number
        updatedAt: number
      }> }>('/telegram/accounts')
    },
    createAccount(params: { botToken: string; workspacePath: string; label?: string; accessLevel?: 'full' | 'workspace' | 'readonly'; allowedUsers?: string; language?: string }) {
      return request<{ accountId: string; botUsername: string; workspacePath: string }>(
        '/telegram/accounts',
        { method: 'POST', body: JSON.stringify(params) },
      )
    },
    updateAccount(accountId: string, patch: { label?: string; workspacePath?: string; enabled?: boolean; accessLevel?: 'full' | 'workspace' | 'readonly'; allowedUsers?: string; language?: string }) {
      return request<{ ok: boolean }>(`/telegram/accounts/${encodeURIComponent(accountId)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
    },
    deleteAccount(accountId: string) {
      return request<{ ok: boolean }>(`/telegram/accounts/${encodeURIComponent(accountId)}`, {
        method: 'DELETE',
      })
    },
  },

  web: {
    listAccounts() {
      return request<{ accounts: Array<{
        accountId: string
        token: string
        workspacePath: string
        workspaceMissing: boolean
        label: string
        enabled: number
        accessLevel: 'full' | 'workspace' | 'readonly'
        language?: 'en' | 'zh'
        createdAt: number
        updatedAt: number
      }> }>('/web/accounts')
    },
    createAccount(params: { workspacePath: string; label?: string; accessLevel?: 'full' | 'workspace' | 'readonly'; language?: 'en' | 'zh' }) {
      return request<{ accountId: string; token: string; workspacePath: string }>(
        '/web/accounts',
        { method: 'POST', body: JSON.stringify(params) },
      )
    },
    updateAccount(accountId: string, patch: { label?: string; workspacePath?: string; enabled?: boolean; accessLevel?: 'full' | 'workspace' | 'readonly'; language?: 'en' | 'zh' }) {
      return request<{ ok: boolean }>(`/web/accounts/${encodeURIComponent(accountId)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
    },
    deleteAccount(accountId: string) {
      return request<{ ok: boolean }>(`/web/accounts/${encodeURIComponent(accountId)}`, {
        method: 'DELETE',
      })
    },
  },

  slack: {
    listAccounts() {
      return request<{ accounts: Array<{
        accountId: string
        botUserId: string
        teamId: string
        workspacePath: string
        workspaceMissing: boolean
        label: string
        enabled: number
        accessLevel: 'full' | 'workspace' | 'readonly'
        language: string
        createdAt: number
        updatedAt: number
      }> }>('/slack/accounts')
    },
    createAccount(params: { botToken: string; appToken: string; workspacePath: string; label?: string; accessLevel?: 'full' | 'workspace' | 'readonly'; language?: string }) {
      return request<{ accountId: string; botUserId: string; teamId: string }>(
        '/slack/accounts',
        { method: 'POST', body: JSON.stringify(params) },
      )
    },
    updateAccount(accountId: string, patch: { label?: string; workspacePath?: string; enabled?: boolean; accessLevel?: 'full' | 'workspace' | 'readonly'; language?: string; appToken?: string }) {
      return request<{ ok: boolean }>(`/slack/accounts/${encodeURIComponent(accountId)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
    },
    deleteAccount(accountId: string) {
      return request<{ ok: boolean }>(`/slack/accounts/${encodeURIComponent(accountId)}`, {
        method: 'DELETE',
      })
    },
    searchTargets(accountId: string, q: string) {
      return request<{
        hits: Array<{
          kind: 'user' | 'channel' | 'group' | 'mpim' | 'im'
          id: string
          name: string
          realName?: string
          email?: string
          chatId: string
        }>
      }>(`/slack/accounts/${encodeURIComponent(accountId)}/search?q=${encodeURIComponent(q)}`)
    },
  },

  feishu: {
    listAccounts() {
      return request<{ accounts: Array<{
        accountId: string
        appId: string
        botOpenId: string
        hasEncryptKey: boolean
        workspacePath: string
        workspaceMissing: boolean
        label: string
        enabled: number
        accessLevel: 'full' | 'workspace' | 'readonly'
        language: string
        createdAt: number
        updatedAt: number
      }> }>('/feishu/accounts')
    },
    createAccount(params: {
      appId: string; appSecret: string;
      verificationToken?: string; encryptKey?: string;
      workspacePath: string; label?: string;
      accessLevel?: 'full' | 'workspace' | 'readonly'; language?: string
    }) {
      return request<{ accountId: string; appId: string; botOpenId: string }>(
        '/feishu/accounts',
        { method: 'POST', body: JSON.stringify(params) },
      )
    },
    updateAccount(accountId: string, patch: {
      label?: string; workspacePath?: string; enabled?: boolean;
      accessLevel?: 'full' | 'workspace' | 'readonly'; language?: string;
      verificationToken?: string; encryptKey?: string
    }) {
      return request<{ ok: boolean }>(`/feishu/accounts/${encodeURIComponent(accountId)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
    },
    deleteAccount(accountId: string) {
      return request<{ ok: boolean }>(`/feishu/accounts/${encodeURIComponent(accountId)}`, {
        method: 'DELETE',
      })
    },
    searchTargets(accountId: string, q: string) {
      return request<{
        hits: Array<{
          kind: 'chat' | 'p2p'
          id: string
          name: string
          chatId: string
        }>
      }>(`/feishu/accounts/${encodeURIComponent(accountId)}/search?q=${encodeURIComponent(q)}`)
    },
  },

  settings: {
    get(projectId?: string) {
      const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
      return request<{
        settings: Record<string, unknown>
        layers: { defaults: Record<string, unknown>; global: Record<string, unknown>; workspace: Record<string, unknown> }
      }>(`/settings${qs}`)
    },
    /**
     * Resolved schema for the new settings page — declared sections from
     * provider/skill yaml + current values + source (workspace/global/unset)
     * + orphan keys.
     */
    getSchema(projectId?: string) {
      const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
      return request<{
        scope: 'global' | 'workspace'
        sections: Array<{
          namespaceId: string
          source: 'general' | 'provider' | 'skill' | 'agent'
          displayName: string
          displayName_zh?: string
          description?: string
          description_zh?: string
          fields: Array<{
            key: string
            kind: 'param' | 'secret'
            type?: 'string' | 'int' | 'float' | 'boolean' | 'enum'
            options?: string[]
            optionLabels?: string[]
            description?: string
            description_zh?: string
            default?: string
            secret?: boolean
            globalOnly?: boolean
            value: string | null
            hasValue: boolean
            source: 'workspace' | 'global' | 'unset'
            inheritedFromGlobal: boolean
          }>
        }>
        orphans: Array<{ namespaceId: string; kind: 'param' | 'secret'; key: string }>
      }>(`/settings/schema${qs}`)
    },
    save(scope: 'global' | 'workspace', settings: Record<string, unknown>, projectId?: string) {
      return request<{ ok: boolean }>('/settings', {
        method: 'PUT',
        body: JSON.stringify({ scope, projectId, settings }),
      })
    },
    patch(scope: 'global' | 'workspace', key: string, value: unknown, projectId?: string) {
      return request<{ ok: boolean }>('/settings', {
        method: 'PATCH',
        body: JSON.stringify({ scope, projectId, key, value }),
      })
    },
    remove(scope: 'global' | 'workspace', key: string, projectId?: string) {
      return request<{ ok: boolean }>('/settings', {
        method: 'DELETE',
        body: JSON.stringify({ scope, projectId, key }),
      })
    },
  },

  evolution: {
    listRuns(opts?: { archived?: boolean; limit?: number; before?: number }) {
      const params = new URLSearchParams()
      if (opts?.archived) params.set('archived', '1')
      if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
      if (opts?.before !== undefined) params.set('before', String(opts.before))
      const qs = params.toString() ? `?${params}` : ''
      return request<{
        runs: Array<{
          id: string
          workspacePath: string
          status: string
          triggerKind: string
          sourceSession: string
          userHint: string | null
          createdAt: number
          startedAt: number | null
          completedAt: number | null
          appliedAt: number | null
          failureReason: string | null
          attempts: number
          archivedAt: number | null
          applyId?: string
          applyStatus?: string
        }>
        hasMore: boolean
        nextCursor: number | null
      }>(`/evolution/runs${qs}`)
    },

    getRun(id: string) {
      return request<{
        run: {
          id: string
          workspacePath: string
          status: string
          triggerKind: string
          sourceSession: string
          userHint: string | null
          createdAt: number
          startedAt: number | null
          completedAt: number | null
          appliedAt: number | null
          failureReason: string | null
          attempts: number
          applyId?: string
          applyStatus?: string
          applyFailureReason?: string | null
        }
        patchMd: string | null
        scoreJson: Record<string, unknown> | null
        skipReasonMd: string | null
        snapshotSummary: { firstUser?: string; firstAssistant?: string; messageCount?: number } | null
        wrapperLog: string | null
        subCliLog: string | null
      }>(`/evolution/runs/${encodeURIComponent(id)}`)
    },

    approve(id: string, reviewerHint?: string) {
      return request<{ ok: boolean; applyId: string }>(`/evolution/runs/${encodeURIComponent(id)}/approve`, {
        method: 'POST',
        body: JSON.stringify({ reviewerHint }),
      })
    },

    reject(id: string) {
      return request<{ ok: boolean }>(`/evolution/runs/${encodeURIComponent(id)}/reject`, {
        method: 'POST',
        body: '{}',
      })
    },

    addHint(id: string, hint: string) {
      return request<{ ok: boolean; userHint: string }>(`/evolution/runs/${encodeURIComponent(id)}/hint`, {
        method: 'POST',
        body: JSON.stringify({ hint }),
      })
    },

    retry(id: string, hint: string) {
      return request<{ ok: boolean }>(`/evolution/runs/${encodeURIComponent(id)}/retry`, {
        method: 'POST',
        body: JSON.stringify({ hint }),
      })
    },

    delete(id: string) {
      return request<{ ok: boolean }>(`/evolution/runs/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
    },
  },

  cron: {
    listJobs(opts?: { limit?: number; before?: number }) {
      const params = new URLSearchParams()
      if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
      if (opts?.before !== undefined) params.set('before', String(opts.before))
      const qs = params.toString() ? `?${params}` : ''
      return request<{
        jobs: Array<{
          id: string
          label: string | null
          workspacePath: string
          agentId: string
          userPrompt: string
          schedule: string
          runAt: number | null
          timezone: string | null
          targets: Array<{ channelType: string; accountId: string; chatId?: string }>
          enabled: number
          lastRunStatus: string | null
          lastRunAt: number | null
          lastRunId: string | null
          createdAt: number
          updatedAt: number
          nextRunAt: number | null
        }>
        hasMore: boolean
        nextCursor: number | null
      }>(`/cron/jobs${qs}`)
    },

    createJob(body: {
      label?: string
      workspacePath: string
      agentId: string
      userPrompt: string
      schedule: string
      runAt?: number
      timezone?: string
      targets?: Array<{ channelType: string; accountId: string; chatId?: string }>
      enabled?: boolean
    }) {
      return request<{ ok: boolean; id: string }>('/cron/jobs', {
        method: 'POST',
        body: JSON.stringify(body),
      })
    },

    updateJob(id: string, body: Partial<{
      label: string
      workspacePath: string
      agentId: string
      userPrompt: string
      schedule: string
      runAt: number | null
      timezone: string
      targets: Array<{ channelType: string; accountId: string; chatId?: string }>
      enabled: boolean
    }>) {
      return request<{ ok: boolean }>(`/cron/jobs/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      })
    },

    deleteJob(id: string) {
      return request<{ ok: boolean }>(`/cron/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },

    runNow(id: string) {
      return request<{ ok: boolean }>(`/cron/jobs/${encodeURIComponent(id)}/run-now`, {
        method: 'POST',
        body: '{}',
      })
    },

    listRuns(jobId: string, opts?: { limit?: number; before?: string }) {
      const qs = new URLSearchParams()
      if (opts?.limit) qs.set('limit', String(opts.limit))
      if (opts?.before) qs.set('before', opts.before)
      const qsStr = qs.toString() ? `?${qs}` : ''
      return request<{
        runs: Array<{
          id: string
          jobId: string
          triggerKind: string
          status: string
          startedAt: number
          completedAt: number | null
          output: string | null
          exitCode: number | null
          failureReason: string | null
          logPath: string | null
          dispatchResults: Array<{ channelType: string; accountId: string; chatId?: string; ok: boolean; error?: string }> | null
        }>
        hasMore: boolean
        nextCursor: string | null
      }>(`/cron/jobs/${encodeURIComponent(jobId)}/runs${qsStr}`)
    },

    getRunLog(runId: string) {
      return request<{ log: string | null }>(`/cron/runs/${encodeURIComponent(runId)}/log`)
    },

    listChannelTargets() {
      return request<{
        targets: Array<{
          channelType: string
          accountId: string
          label: string
          workspacePath: string
          enabled: boolean
          hasActiveChat: boolean
        }>
      }>('/cron/channel-targets')
    },

    /** Server-side metadata for the cron form. `hostTimezone` is the
     *  tz the server resolves an unset `cron_jobs.timezone` to — used
     *  by the form to label the "Default" option correctly. */
    meta() {
      return request<{ hostTimezone: string }>('/cron/meta')
    },
  },
}
