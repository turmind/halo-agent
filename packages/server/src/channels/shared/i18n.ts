export type Lang = 'en' | 'zh'

const messages: Record<string, Record<Lang, string>> = {
  // ── /help ──
  'help.title': { zh: '可用命令：', en: 'Available commands:' },

  // Builtin command descriptions (keyed by descriptor.name; skills fall back
  // to their SKILL.md description). execHelp looks these up by `cmd.<name>`.
  'cmd.help':    { zh: '显示此帮助', en: 'Show available commands' },
  'cmd.new':     { zh: '开始新会话', en: 'Start a new session' },
  'cmd.clear':   { zh: '清空聊天（/new 的别名）', en: 'Clear chat (alias for /new)' },
  'cmd.list':    { zh: '列出最近会话', en: 'List recent sessions' },
  'cmd.switch':  { zh: '按编号切换会话', en: 'Switch to a session by index' },
  'cmd.stop':    { zh: '中断当前任务', en: 'Stop the running agent task' },
  'cmd.compact': { zh: '压缩上下文', en: 'Compress conversation context' },
  'cmd.context': { zh: '查看上下文窗口与 agent 信息', en: 'Show context window + agent info' },
  'cmd.agents':  { zh: '列出可用 agent', en: 'List available agents' },
  'cmd.agent':   { zh: '用指定 agent 开始新会话', en: 'Start a session with a specific agent' },
  'cmd.ws':      { zh: '查看或切换 workspace', en: 'Show or switch workspace' },
  'cmd.ws.readonly': { zh: '查看当前 workspace', en: 'Show current workspace' },
  'cmd.note':    { zh: '触发自我进化:分析当前会话、起草改进建议', en: 'Trigger self-evolution: analyze current session and draft improvement suggestions' },

  // Channel-specific (currently WeChat-only)
  'cmd.send':    { zh: '发送 workspace 下的文件', en: 'Send file from workspace' },
  'cmd.qr':      { zh: '生成邀请二维码（仅管理员）', en: 'Generate invite QR (admin only)' },
  'cmd.model':   { zh: '切换当前会话的模型（仅 WS）', en: 'Switch model for this session (WS only)' },
  'cmd.retry':   { zh: '重新发送上一条消息', en: 'Resend the last user message' },

  // ── /stop ──
  'stop.no_session': { zh: '没有活跃会话', en: 'No active session' },
  'stop.already_idle': { zh: '会话已经空闲', en: 'Session is already idle' },
  'stop.done': { zh: '✅ 已中断当前任务', en: '✅ Task stopped' },

  // ── /interrupt ──
  'interrupt.no_session': { zh: '没有活跃会话', en: 'No active session' },
  'interrupt.already_idle': { zh: '会话已经空闲', en: 'Session is already idle' },
  'interrupt.done': { zh: '⏸ 已打断，将处理排队的消息', en: '⏸ Interrupted; processing any queued messages' },

  // ── /compact ──
  'compact.no_session': { zh: '没有活跃会话可压缩', en: 'No active session to compact' },
  'compact.running': { zh: '当前任务还在跑，等它结束再 /compact', en: 'Task is still running, wait for it to finish before /compact' },
  'compact.already': { zh: '已经在压缩中', en: 'Already compacting' },
  'compact.started': { zh: '⏳ 开始压缩上下文…', en: '⏳ Compacting context…' },

  // ── /new ──
  'new.done': { zh: '✅ 已开始新会话。/list 查看历史，/switch <编号> 切回', en: '✅ New session started. /list to see history, /switch <number> to go back' },
  'new.failed': { zh: '创建失败: {error}', en: 'Failed to create: {error}' },

  // ── /list ──
  'list.empty': { zh: '没有会话。发任何消息即可开始新会话', en: 'No sessions. Send any message to start one' },
  'list.title': { zh: '会话列表（最新在前）：', en: 'Sessions (newest first):' },
  'list.switch_full': { zh: '/switch <编号> 切换（可切到任何会话）', en: '/switch <number> to switch (can switch to any session)' },
  'list.switch_readonly': { zh: '/switch <编号> 切换（readonly 仅能切到自己的 [我] 会话）', en: '/switch <number> to switch (readonly: own sessions only)' },

  // ── /switch ──
  'switch.empty': { zh: '没有会话可切换', en: 'No sessions to switch to' },
  'switch.usage': { zh: '用法：/switch <编号>  （1-{max}）', en: 'Usage: /switch <number>  (1-{max})' },
  'switch.readonly': { zh: '⚠️ readonly 模式不允许切换到别人的会话', en: "⚠️ Readonly mode can't switch to others' sessions" },
  'switch.done': { zh: '✅ 已切换到会话 {idx}（{time}）\n{desc}', en: '✅ Switched to session {idx} ({time})\n{desc}' },

  // ── /agents ──
  'agents.empty': { zh: '没有可用的 agent', en: 'No agents available' },
  'agents.title': { zh: '可用 Agent 列表：', en: 'Available agents:' },
  'agents.hint': { zh: '用 /agent <名称或编号> 开始一个使用该 agent 的新会话', en: 'Use /agent <name or number> to start a session with that agent' },

  // ── /agent ──
  'agent.usage': { zh: '用法：/agent <名称或编号>\n先用 /agents 查看可用列表', en: 'Usage: /agent <name or number>\nUse /agents to see available list' },
  'agent.not_found': { zh: '找不到 agent: {name}\n用 /agents 查看可用列表', en: 'Agent not found: {name}\nUse /agents to see available list' },
  'agent.done': { zh: '✅ 已用 agent "{name}" 开始新会话', en: '✅ Started new session with agent "{name}"' },
  'agent.failed': { zh: '创建失败: {error}', en: 'Failed to create: {error}' },

  // ── /ws ──
  'ws.current': { zh: '当前 workspace:\n{path}', en: 'Current workspace:\n{path}' },
  'ws.readonly': { zh: '⚠️ readonly 模式不允许切换 workspace', en: '⚠️ Readonly mode cannot switch workspace' },
  'ws.must_abs': { zh: 'workspace 必须是绝对路径', en: 'Workspace must be an absolute path' },
  'ws.not_found': { zh: '路径不存在：{path}', en: 'Path does not exist: {path}' },
  'ws.same': { zh: '已经在这个 workspace 了', en: 'Already in this workspace' },
  'ws.done': { zh: '✅ 已切换到：\n{path}', en: '✅ Switched to:\n{path}' },
  'ws.failed': { zh: '切换失败：{error}', en: 'Failed to switch: {error}' },

  // ── Unknown command ──
  'cmd.unknown': { zh: '未知命令: {cmd}\n发 /help 查看可用命令', en: 'Unknown command: {cmd}\nSend /help to see available commands' },

  // ── Channel handler messages ──
  'handler.workspace_missing': { zh: '⚠️ 这个 bot 绑定的 workspace 已不存在：\n{path}\n\n请到 web 端的 Channels 设置里更新绑定目录。', en: '⚠️ The workspace bound to this bot no longer exists:\n{path}\n\nPlease update the binding in web Channels settings.' },
  'handler.compacting': { zh: '⏳ 正在整理上下文，请稍后再发消息（通常 30 秒内完成）', en: '⏳ Compacting context, please wait (usually under 30s)' },
  'handler.queued': { zh: '🔄 刚才那条还在处理中，消息已排队，请稍候', en: '🔄 Previous message still processing, queued' },
  'handler.workspace_gone': { zh: '⚠️ workspace 不存在，请到 web 端更新绑定', en: '⚠️ Workspace does not exist, please update binding in web' },
  'handler.not_allowed': { zh: '⚠️ 你不在这个 bot 的允许列表中', en: '⚠️ You are not in this bot\'s allowed list' },
  'handler.start_greeting': { zh: '👋 Halo bot 已就绪。直接发消息开始对话。发 /help 查看可用命令。', en: '👋 Halo bot ready. Send a message to start. /help for commands.' },

  // ── /context ──
  'context.no_session': { zh: '没有活跃会话', en: 'No active session' },
  'context.not_loaded': { zh: '会话未加载', en: 'Session not loaded' },

  // ── /note (self-evolution) ──
  'note.disabled': { zh: '自我进化未启用。在 Settings 里把 general.evolution.level 改为 L1。', en: 'Self-evolution is off. Set general.evolution.level to L1 in Settings to enable.' },
  'note.readonly': { zh: 'Readonly 用户不能触发 /note。', en: 'Readonly users cannot trigger /note.' },
  'note.no_session': { zh: '当前没有可分析的 root 会话。', en: 'No active root session to analyze.' },
  'note.queued': { zh: '📝 已加入评估队列。完成后可在 admin 的 Evolution 页查看。', en: '📝 Queued for evaluation. Results will appear under the admin Evolution tab.' },
  'note.snapshot_failed': { zh: '快照失败,请查 server 日志。', en: 'Snapshot failed — check server logs.' },
  'note.queue_failed': { zh: '入队失败,请查 server 日志。', en: 'Failed to enqueue — check server logs.' },

  // ── Skill activation ──
  'skill.activated': { zh: '已激活 Skill {cmd}', en: 'Skill {cmd} activated' },

  // ── /send (channel-shared, currently used by WeChat) ──
  'send.path_not_allowed': { zh: '路径不允许：必须在 workspace 内', en: 'Path not allowed: must be under workspace' },

  // ── WeChat-specific ──
  'wechat.send_usage': { zh: '用法：/send <文件路径>（相对 workspace 或绝对路径）', en: 'Usage: /send <file path> (relative to workspace or absolute)' },
  'wechat.send_not_found': { zh: '文件不存在：{path}', en: 'File not found: {path}' },
  'wechat.send_failed': { zh: '发送失败: {error}', en: 'Send failed: {error}' },
  'wechat.ws_suffix': { zh: '\n（接下来的消息会进入这个 workspace 的会话）', en: '\n(Future messages will go to this workspace)' },
  'wechat.qr_admin_only': { zh: '仅管理员可生成邀请二维码', en: 'Only full-access users can generate invite QR' },
  'wechat.qr_usage': { zh: '用法: /qr [readonly|workspace|full]', en: 'Usage: /qr [readonly|workspace|full]' },
  'wechat.qr_sent': { zh: '二维码已发送，对方扫码后将获得 {level} 权限，工作区: {path}', en: 'QR sent. The new user will get {level} access to workspace: {path}' },
  'wechat.qr_login_failed': { zh: '扫码未完成: {message}', en: 'QR login failed: {message}' },
  'wechat.qr_account_connected': { zh: '新账号已连接: {accountId}', en: 'New account connected: {accountId}' },
  'wechat.qr_failed': { zh: '扫码失败: {error}', en: 'QR failed: {error}' },
}

export function getLang(account: { language?: string | null }): Lang {
  const v = account.language
  return (v === 'en' || v === 'zh') ? v : 'en'
}

export function t(key: string, lang: Lang, params?: Record<string, string | number>): string {
  const entry = messages[key]
  if (!entry) return key
  let text = entry[lang] ?? entry.en
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v))
    }
  }
  return text
}
