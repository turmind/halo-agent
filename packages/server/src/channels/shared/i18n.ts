export type Lang = 'en' | 'zh'

const messages: Record<string, Record<Lang, string>> = {
  // ── /help ──
  'help.title': { zh: '可用命令：', en: 'Available commands:' },

  // Builtin command descriptions (keyed by descriptor.name; skills fall back
  // to their SKILL.md description). execHelp looks these up by `cmd.<name>`.
  'cmd.help':    { zh: '显示此帮助', en: 'Show available commands' },
  'cmd.clear':   { zh: '清空聊天（/session new 的别名）', en: 'Clear chat (alias for /session new)' },
  'cmd.session': { zh: '管理会话', en: 'Manage sessions' },
  'cmd.workspace':      { zh: '管理 workspace', en: 'Manage the workspace' },

  // ── /workspace builtin verbs ──
  'verb.workspace.info':   { zh: '显示当前 workspace', en: 'Show the current workspace' },
  'verb.workspace.switch': { zh: '切换 workspace（绝对路径 / $HOME 下的名字 / ~/）', en: 'Switch workspace (absolute path / a name under $HOME / ~/)' },
  'verb.workspace.setup':  { zh: '初始化 .halo 知识库（workspace skill）', en: 'Set up the .halo knowledge files (workspace skill)' },
  'verb.workspace.tidy':   { zh: '整理/清理 .halo 知识库（workspace skill）', en: 'Tidy/prune the .halo knowledge files (workspace skill)' },
  'verb.workspace.share':  { zh: '打包 workspace 配置为可分享 zip（share-workspace skill）', en: 'Package the workspace config as a shareable zip (share-workspace skill)' },
  'workspace.switch_usage': { zh: '用法：/workspace switch <路径>（绝对路径，或相对 $HOME 的名字 / ~/）', en: 'Usage: /workspace switch <path> (absolute, or a name / ~/ relative to $HOME)' },
  'cmd.evo':     { zh: '触发自我进化:分析当前会话、起草改进建议', en: 'Trigger self-evolution: analyze current session and draft improvement suggestions' },
  'cmd.agent':   { zh: '管理 agent', en: 'Manage agents' },
  'cmd.skill':   { zh: '管理 skill', en: 'Manage skills' },

  // ── /session builtin verbs ──
  'verb.session.new':       { zh: '开始新会话', en: 'Start a new session' },
  'verb.session.list':      { zh: '列出最近会话', en: 'List recent sessions' },
  'verb.session.switch':    { zh: '按编号切换会话', en: 'Switch to a session by index' },
  'verb.session.stop':      { zh: '中断当前任务', en: 'Stop the running agent task' },
  'verb.session.interrupt': { zh: '打断当前任务（排队消息会在下一轮处理）', en: 'Interrupt the running task (queued messages run next)' },
  'verb.session.compact':   { zh: '压缩上下文', en: 'Compress conversation context' },
  'verb.session.context':   { zh: '查看上下文窗口与 agent 信息', en: 'Show context window + agent info' },
  'verb.session.info':      { zh: '查看完整会话树（root + 所有子 agent）', en: 'Show the full session tree (root + all sub-agents)' },

  // ── /agent builtin verb descriptions (shown in `/agent help`) ──
  'verb.agent.list':   { zh: '列出可用的 agent', en: 'List usable agents' },
  'verb.agent.switch': { zh: '用指定 agent 开始一个会话', en: 'Start a session with an agent' },
  'verb.agent.desc':   { zh: '查看某个 agent 的模型 / 工具 / 技能', en: "Show an agent's model / tools / skills" },
  'verb.agent.delete': { zh: '删除一个 agent（workspace 或全局）', en: 'Delete an agent (workspace or global)' },
  'verb.none':   { zh: '{cmd} 没有你可用的操作', en: 'No actions available to you for {cmd}' },

  // ── /skill builtin verbs ──
  'verb.skill.list':    { zh: '列出全部 skill（含禁用/覆盖状态）', en: 'List all skills (with disabled/overridden flags)' },
  'verb.skill.desc':    { zh: '查看某个 skill 的描述与状态', en: "Show a skill's description and status" },
  'verb.skill.disable': { zh: '禁用某个 skill（本 workspace）', en: 'Disable a skill (this workspace)' },
  'verb.skill.enable':  { zh: '启用某个 skill（本 workspace）', en: 'Enable a skill (this workspace)' },
  'verb.skill.delete':  { zh: '删除一个 skill（workspace 或全局）', en: 'Delete a skill (workspace or global)' },
  'skills.empty': { zh: '没有任何 skill', en: 'No skills found' },
  'skills.title': { zh: '可用 Skill：', en: 'Skills:' },
  'skill.usage_desc': { zh: '用法：/skill desc <名称或编号>', en: 'Usage: /skill desc <name or number>' },
  'skill.usage_disable': { zh: '用法：/skill disable <名称或编号>', en: 'Usage: /skill disable <name or number>' },
  'skill.usage_enable': { zh: '用法：/skill enable <名称或编号>', en: 'Usage: /skill enable <name or number>' },
  'skill.already_disabled': { zh: 'skill "{name}" 已经是禁用状态', en: 'Skill "{name}" is already disabled' },
  'skill.already_enabled': { zh: 'skill "{name}" 已经是启用状态', en: 'Skill "{name}" is already enabled' },
  'skill.usage_delete': { zh: '用法：/skill delete <名称或编号>', en: 'Usage: /skill delete <name or number>' },
  'skill.not_found': { zh: '找不到 skill: {name}', en: 'Skill not found: {name}' },
  'skill.disabled_done': { zh: '⏸ 已禁用 skill "{name}"（本 workspace）', en: '⏸ Skill "{name}" disabled (this workspace)' },
  'skill.enabled_done': { zh: '▶ 已启用 skill "{name}"（本 workspace）', en: '▶ Skill "{name}" enabled (this workspace)' },
  'skill.delete_done': { zh: '🗑 已删除 skill "{name}"（{scope}）', en: '🗑 Deleted skill "{name}" ({scope})' },
  'skill.delete_failed': { zh: '删除失败: {error}', en: 'Delete failed: {error}' },

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
  'compact.running': { zh: '当前任务还在跑，等它结束再 /session compact', en: 'Task is still running, wait for it to finish before /session compact' },
  'compact.already': { zh: '已经在压缩中', en: 'Already compacting' },
  'compact.started': { zh: '⏳ 开始压缩上下文…', en: '⏳ Compacting context…' },

  // ── /new ──
  'new.done': { zh: '✅ 已开始新会话。/session list 查看历史，/session switch <编号> 切回', en: '✅ New session started. /session list to see history, /session switch <number> to go back' },
  'new.failed': { zh: '创建失败: {error}', en: 'Failed to create: {error}' },

  // ── /list ──
  'list.empty': { zh: '没有会话。发任何消息即可开始新会话', en: 'No sessions. Send any message to start one' },
  'list.title': { zh: '会话列表（最新在前）：', en: 'Sessions (newest first):' },
  'list.switch_full': { zh: '/session switch <编号> 切换（可切到任何会话）', en: '/session switch <number> to switch (can switch to any session)' },
  'list.switch_readonly': { zh: '/session switch <编号> 切换（readonly 仅能切到自己的 [我] 会话）', en: '/session switch <number> to switch (readonly: own sessions only)' },

  // ── /switch ──
  'switch.empty': { zh: '没有会话可切换', en: 'No sessions to switch to' },
  'switch.usage': { zh: '用法：/session switch <编号>  （1-{max}）', en: 'Usage: /session switch <number>  (1-{max})' },
  'switch.readonly': { zh: '⚠️ readonly 模式不允许切换到别人的会话', en: "⚠️ Readonly mode can't switch to others' sessions" },
  'switch.done': { zh: '✅ 已切换到会话 {idx}（{time}）\n{desc}', en: '✅ Switched to session {idx} ({time})\n{desc}' },

  // ── /workspace ──
  'workspace.current': { zh: '当前 workspace:\n{path}', en: 'Current workspace:\n{path}' },
  'workspace.readonly': { zh: '⚠️ readonly 模式不允许切换 workspace', en: '⚠️ Readonly mode cannot switch workspace' },
  'workspace.not_found': { zh: '路径不存在：{path}', en: 'Path does not exist: {path}' },
  'workspace.same': { zh: '已经在这个 workspace 了', en: 'Already in this workspace' },
  'workspace.done': { zh: '✅ 已切换到：\n{path}', en: '✅ Switched to:\n{path}' },
  'workspace.failed': { zh: '切换失败：{error}', en: 'Failed to switch: {error}' },

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
  'evo.full_only': { zh: '只有 full 权限可以触发 /evo。', en: 'Only full access can trigger /evo.' },
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

  // ── /goal verbs (goal mode) ──
  'verb.goal.create': { zh: '在当前会话上启动 goal 意图对话', en: 'Start goal intake on the current session' },
  'verb.goal.status': { zh: '查看当前 goal 的轮次 / 上限 / 状态', en: "Show the current goal's round / caps / state" },
  'verb.goal.pause':  { zh: '暂停 goal（停止 worker 和 goal 会话）', en: 'Pause the goal (stops worker + goal session)' },
  'verb.goal.resume': { zh: '恢复已暂停的 goal', en: 'Resume a paused goal' },
  'verb.goal.clear':  { zh: '拆除 goal 绑定', en: 'Tear down the goal binding' },
  'goal.already_active': { zh: '⚠️ 已有进行中的 goal（每个 workspace 同时只跑一个）：', en: '⚠️ A goal is already active (one per workspace at a time):' },
  'goal.no_session': { zh: '当前没有可绑定的 root 会话。', en: 'No active root session to bind.' },
  'goal.cannot_bind_goal': { zh: '不能在 goal 会话上再建 goal。', en: 'Cannot create a goal on a goal session.' },
  'goal.create_failed': { zh: '创建 goal 失败：{error}', en: 'Failed to create goal: {error}' },
  'goal.created': { zh: '🎯 Goal 会话已创建：{goal}\n（worker: {worker}）接下来和 goal 会话对话，确认目标后它会开始调度。', en: '🎯 Goal session created: {goal}\n(worker: {worker}) Talk to the goal session to define the contract; it dispatches once you confirm.' },
  'goal.none': { zh: '这个 workspace 还没有 goal。', en: 'No goal in this workspace yet.' },
  'goal.none_active': { zh: '没有进行中的 goal。', en: 'No active goal.' },
  'goal.not_running': { zh: '没有正在运行的 goal。', en: 'No running goal.' },
  'goal.not_paused': { zh: '没有已暂停的 goal。', en: 'No paused goal.' },
  'goal.paused': { zh: '⏸ Goal 已暂停（worker 和 goal 会话都已停止）。/goal resume 恢复。', en: '⏸ Goal paused (worker + goal session stopped). /goal resume to continue.' },
  'goal.resumed': { zh: '▶️ Goal 已恢复，goal 会话将重新派发当前任务。', en: '▶️ Goal resumed — the goal session will re-dispatch the current work order.' },
  'goal.cleared': { zh: '🗑 Goal 绑定已拆除，会话回到 {worker}。', en: '🗑 Goal binding cleared — the surface returns to {worker}.' },
  'goal.status_head': { zh: '状态: {status} · 轮次 {round}/{cap}', en: 'status: {status} · round {round}/{cap}' },
  'goal.status_meta': { zh: '已运行 {elapsed} · 无进展 {noProgress}/3 · 代答 {decisions}/5', en: 'elapsed {elapsed} · no-progress {noProgress}/3 · delegated decisions {decisions}/5' },
  'goal.status_halt': { zh: '停机原因: {reason}', en: 'halt reason: {reason}' },

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
