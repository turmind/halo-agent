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
  'cmd.interrupt': { zh: '打断当前任务（排队消息会在下一轮处理）', en: 'Interrupt the running task (queued messages run next)' },
  'cmd.compact': { zh: '压缩上下文', en: 'Compress conversation context' },
  'cmd.context': { zh: '查看上下文窗口与 agent 信息', en: 'Show context window + agent info' },
  'cmd.ws':      { zh: '查看或切换 workspace', en: 'Show or switch workspace' },
  'cmd.ws.readonly': { zh: '查看当前 workspace', en: 'Show current workspace' },
  'cmd.evo':     { zh: '触发自我进化:分析当前会话、起草改进建议', en: 'Trigger self-evolution: analyze current session and draft improvement suggestions' },
  'cmd.agent':   { zh: '管理 agent（list/switch/desc/delete；create/update 走 skill）', en: 'Manage agents (list/switch/desc/delete; create/update via skill)' },

  // ── /agent builtin verb descriptions (shown in `/agent help`) ──
  'verb.agent.list':   { zh: '列出可用的 agent', en: 'List usable agents' },
  'verb.agent.switch': { zh: '用指定 agent 开始一个会话', en: 'Start a session with an agent' },
  'verb.agent.desc':   { zh: '查看某个 agent 的模型 / 工具 / 技能', en: "Show an agent's model / tools / skills" },
  'verb.agent.delete': { zh: '删除一个 agent（workspace 或全局）', en: 'Delete an agent (workspace or global)' },
  'verb.none':   { zh: '{cmd} 没有你可用的操作', en: 'No actions available to you for {cmd}' },

  // Channel-specific (currently WeChat-only)
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

  // ── /evo (self-evolution) ──
  'evo.readonly': { zh: 'Readonly 用户不能触发 /evo。', en: 'Readonly users cannot trigger /evo.' },
  'evo.no_session': { zh: '当前没有可分析的 root 会话。', en: 'No active root session to analyze.' },
  'evo.queued': { zh: '📝 已加入评估队列。完成后可在 admin 的 Evolution 页查看。', en: '📝 Queued for evaluation. Results will appear under the admin Evolution tab.' },
  'evo.snapshot_failed': { zh: '快照失败,请查 server 日志。', en: 'Snapshot failed — check server logs.' },
  'evo.queue_failed': { zh: '入队失败,请查 server 日志。', en: 'Failed to enqueue — check server logs.' },

  // ── /agent verbs (list / switch / desc / delete) ──
  'agents.empty': { zh: '没有可用的 agent', en: 'No agents available' },
  'agents.title': { zh: '可用 Agent：', en: 'Available agents:' },
  'agent.usage': { zh: '用法：/agent switch <名称或编号>', en: 'Usage: /agent switch <name or number>' },
  'agent.not_found': { zh: '找不到 agent: {name}', en: 'Agent not found: {name}' },
  'agent.done': { zh: '✅ 已用 agent "{name}" 开始新会话', en: '✅ Started new session with agent "{name}"' },
  'agent.failed': { zh: '操作失败: {error}', en: 'Operation failed: {error}' },
  'agent.delete_usage': { zh: '用法：/agent delete <名称或编号>', en: 'Usage: /agent delete <name or number>' },
  'agent.delete_done': { zh: '🗑 已删除 agent "{name}"（{scope}）', en: '🗑 Deleted agent "{name}" ({scope})' },

  // ── Skill activation ──
  'skill.activated': { zh: '已激活 Skill {cmd}', en: 'Skill {cmd} activated' },
  'skill.no_session': { zh: '无法解析会话 {session} 以做权限检查。', en: 'Cannot resolve session {session} for permission check.' },
  'skill.not_allowed': { zh: 'Skill {cmd} 对 agent「{agent}」不可用。把「{id}」加入该 agent 的 skills 列表即可启用。', en: 'Skill {cmd} is not available to agent "{agent}". Add "{id}" to the agent\'s skills list to enable.' },
  'skill.disabled': { zh: 'Skill {cmd} 在此 workspace 已被禁用。', en: 'Skill {cmd} is disabled for this workspace.' },
  'skill.load_failed': { zh: '加载 skill 失败：{error}', en: 'Failed to load skill: {error}' },
  'skill.access_required': { zh: 'Skill {cmd} 需要 {required} 访问权限；当前会话为 {current}。', en: 'Skill {cmd} requires {required} access; this session has {current}.' },

  // ── WeChat-specific ──
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
