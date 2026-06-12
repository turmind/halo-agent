// i18n: a tiny zh/en dictionary + reactive language switch. Language is picked
// from ?lang= → localStorage → navigator.language → 'zh'. `t(key, ...args)`
// looks up the active dictionary; functions in the dict take args. Calling
// setLang() persists the choice and notifies subscribers so the live UI
// re-renders (HUD, ticker, inspector) without a reload.

const DICT = {
  zh: {
    // document / setup modal
    title: 'Halo Show · 像素街区',
    setupTitle: '欢迎来到 Halo 像素街区',
    setupSub: '输入你的 Halo 服务器地址与 Web Token，看 agent 们在城里上班。',
    fieldServer: '服务器地址',
    tokenPlaceholder: 'full 权限的 web token',
    remember: '记住（存于本机 localStorage）',
    connect: '上街 →',
    connecting: '连接中…',
    setupTiny: '本页只读、纯本地渲染，不消耗任何模型 token。',
    needToken: '请填写 Web Token',
    // hud / chrome
    zenTitle: '纯净模式：只看像素世界（H 键切换）',
    settings: '设置',
    tickerToggle: '点击收起 / 展开',
    tickerTitle: '街区动态',
    langTitle: '切换语言 / Switch language',
    zoomOut: '缩小',
    zoomIn: '放大',
    close: '关闭',
    // legend
    lgRun: '干活中',
    lgIdle: '摸鱼',
    lgStop: '休息',
    pixelHint: '滚轮 / 拖条缩放 · 拖拽平移 · 点小人看日志 · F 全街区',
    // hud stats
    statBuildings: '栋楼',
    statRunning: '干活中',
    statIdle: '摸鱼',
    statStopped: '休息',
    statOutTok: '输出 tok',
    uptime: (s) => '运行 ' + s,
    // conn
    connDown: '连接断开',
    connRefreshing: '刷新中…',
    connOk: '已连接',
    connFail: '连接失败',
    // api errors
    errToken: 'token 无效或已禁用',
    errForbidden: '该 token 无权访问此会话',
    errRate: '请求过于频繁，请稍后再试',
    errServer: (code) => `服务器返回 ${code}`,
    errNotApi: '该地址返回的是网页而非 API — 请填 Halo 服务器地址本身（如 http://localhost:9527）',
    // ticker events
    evTool: '动作',
    evSkill: (s) => `启用技能 <b>${s}</b>`,
    evSpawnSub: (d) => `被委派进场 <span class="t-dim">L${d}</span>`,
    evSpawn: '走进大楼',
    evWake: '开始干活',
    evRest: '收工休息',
    evLeave: '离开了街区',
    tickerCount: (n) => `${n} 条`,
    // status / doing
    stRunning: '干活中', stIdle: '摸鱼中', stStopped: '休息中',
    doWalk: '正在走动', doStairs: '在爬楼梯', doWork: '伏案敲代码', doRead: '翻阅资料',
    doCoffee: '在喝咖啡', doGame: '打街机', doPhone: '打电话', doChat: '聊天中',
    doWater: '在浇花', doStretch: '伸懒腰', doSleep: '睡着了', doIdleStand: '发呆中',
    doLook: '看热闹', doLean: '靠着歇会',
    // inspector
    msgCount: (n) => `${n} 条消息`,
    msgCountShort: (n) => `${n}条`,
    subAgent: (d) => `子代理 · L${d}`,
    logLoadFail: (e) => `日志加载失败：${e}`,
    logEmpty: '（还没有消息）',
    logHead: (a, b) => `会话日志（近 ${a} / 共 ${b} 条）`,
    delegationChain: (n) => `委派链 (${n})`,
    usingSkill: '正在使用技能',
    lastAction: '最近动作',
    contextTokens: '上下文 Tokens',
    totalOutput: '累计输出',
    sessionLog: '会话日志',
    loading: '加载中…',
    inBuilding: '所在大楼',
    lastActive: '最近活动',
    floorWork: '工作层', floorCommons: '公共层', floorLobby: '大堂', floorGeneric: '楼层',
    floorEmpty: '这层现在没有人',
    clickRowHint: '点会话行可跳到对应的小动物',
    floorSessions: (n) => `本层会话与委派关系 (${n})`,
    skillUsing: (n) => `正在使用 (${n})`,
    skillNobody: '当前没人使用这个技能',
    buildingEmpty: '空荡荡的大楼',
    skills: (n) => `技能 (${n})`,
    population: '人口',
    popRunning: (n) => `${n} 干活`,
    popIdle: (n) => `${n} 摸鱼`,
    popStopped: (n) => `${n} 休息`,
    popTotal: (n) => `共 ${n}`,
    tokensField: 'Tokens（上下文合计 / 输出合计）',
    sessionsField: (n) => `会话 (${n})`,
    // tools
    tools: {
      file_read: '读文件', file_write: '写文件', file_edit: '改代码',
      file_list: '翻目录', glob: '找文件', grep: '搜代码',
      shell_exec: '敲命令', web_fetch: '上网查', view_image: '看图片',
      draft: '打草稿', activate_skill: '用技能',
      start_session: '叫帮手', query_session: '问同事', session_list: '点名',
      interrupt_session: '喊停', stop_session: '收工', archive_session: '归档',
      get_session_output: '看进度', list_agents: '找人选', query_agent: '查档案',
    },
    // time ago
    agoSec: (n) => `${n}秒前`, agoMin: (n) => `${n}分钟前`,
    agoHour: (n) => `${n}小时前`, agoDay: (n) => `${n}天前`,
    langLabel: '中',
  },
  en: {
    title: 'Halo Show · Pixel Block',
    setupTitle: 'Welcome to the Halo Pixel Block',
    setupSub: 'Enter your Halo server URL and Web Token to watch the agents at work in the city.',
    fieldServer: 'Server URL',
    tokenPlaceholder: 'web token with full access',
    remember: 'Remember (stored in this browser)',
    connect: 'Enter →',
    connecting: 'Connecting…',
    setupTiny: 'Read-only, rendered locally. Consumes no model tokens.',
    needToken: 'Please enter a Web Token',
    zenTitle: 'Zen mode: pixel world only (press H to toggle)',
    settings: 'Settings',
    tickerToggle: 'Click to collapse / expand',
    tickerTitle: 'Street Feed',
    langTitle: '切换语言 / Switch language',
    zoomOut: 'Zoom out',
    zoomIn: 'Zoom in',
    close: 'Close',
    lgRun: 'Working',
    lgIdle: 'Idle',
    lgStop: 'Resting',
    pixelHint: 'Wheel / bar to zoom · drag to pan · click a sprite for logs · F to fit',
    statBuildings: 'buildings',
    statRunning: 'working',
    statIdle: 'idle',
    statStopped: 'resting',
    statOutTok: 'output tok',
    uptime: (s) => 'up ' + s,
    connDown: 'Disconnected',
    connRefreshing: 'Refreshing…',
    connOk: 'Connected',
    connFail: 'Connection failed',
    errToken: 'Token invalid or disabled',
    errForbidden: 'This token may not access that session',
    errRate: 'Too many requests, please retry shortly',
    errServer: (code) => `Server returned ${code}`,
    errNotApi: 'That URL returns a web page, not an API — enter the Halo server address itself (e.g. http://localhost:9527)',
    evTool: 'action',
    evSkill: (s) => `using skill <b>${s}</b>`,
    evSpawnSub: (d) => `delegated in <span class="t-dim">L${d}</span>`,
    evSpawn: 'entered the building',
    evWake: 'started working',
    evRest: 'clocked off',
    evLeave: 'left the block',
    tickerCount: (n) => `${n}`,
    stRunning: 'Working', stIdle: 'Idle', stStopped: 'Resting',
    doWalk: 'walking', doStairs: 'on the stairs', doWork: 'heads-down coding', doRead: 'reading docs',
    doCoffee: 'getting coffee', doGame: 'at the arcade', doPhone: 'on a call', doChat: 'chatting',
    doWater: 'watering plants', doStretch: 'stretching', doSleep: 'asleep', doIdleStand: 'spacing out',
    doLook: 'rubbernecking', doLean: 'taking a breather',
    msgCount: (n) => `${n} messages`,
    msgCountShort: (n) => `${n}`,
    subAgent: (d) => `sub-agent · L${d}`,
    logLoadFail: (e) => `Log failed to load: ${e}`,
    logEmpty: '(no messages yet)',
    logHead: (a, b) => `Session log (last ${a} / ${b} total)`,
    delegationChain: (n) => `Delegation chain (${n})`,
    usingSkill: 'Active skill',
    lastAction: 'Last action',
    contextTokens: 'Context tokens',
    totalOutput: 'Total output',
    sessionLog: 'Session log',
    loading: 'Loading…',
    inBuilding: 'Building',
    lastActive: 'Last active',
    floorWork: 'work floor', floorCommons: 'commons', floorLobby: 'lobby', floorGeneric: 'floor',
    floorEmpty: 'nobody on this floor right now',
    clickRowHint: 'Click a session row to jump to its sprite',
    floorSessions: (n) => `Sessions & delegation on this floor (${n})`,
    skillUsing: (n) => `In use (${n})`,
    skillNobody: 'Nobody is using this skill right now',
    buildingEmpty: 'an empty building',
    skills: (n) => `Skills (${n})`,
    population: 'Population',
    popRunning: (n) => `${n} working`,
    popIdle: (n) => `${n} idle`,
    popStopped: (n) => `${n} resting`,
    popTotal: (n) => `${n} total`,
    tokensField: 'Tokens (context total / output total)',
    sessionsField: (n) => `Sessions (${n})`,
    tools: {
      file_read: 'read file', file_write: 'write file', file_edit: 'edit code',
      file_list: 'list dir', glob: 'find files', grep: 'search code',
      shell_exec: 'run shell', web_fetch: 'fetch web', view_image: 'view image',
      draft: 'draft', activate_skill: 'use skill',
      start_session: 'call helper', query_session: 'ask peer', session_list: 'roll call',
      interrupt_session: 'interrupt', stop_session: 'stop', archive_session: 'archive',
      get_session_output: 'check progress', list_agents: 'list agents', query_agent: 'query agent',
    },
    agoSec: (n) => `${n}s ago`, agoMin: (n) => `${n}m ago`,
    agoHour: (n) => `${n}h ago`, agoDay: (n) => `${n}d ago`,
    langLabel: 'EN',
  },
}

const SUPPORTED = ['zh', 'en']
function detect() {
  const q = new URLSearchParams(location.search).get('lang')
  if (q && SUPPORTED.includes(q)) return q
  try { const s = localStorage.getItem('halo_city_lang'); if (s && SUPPORTED.includes(s)) return s } catch {}
  const n = (navigator.language || 'zh').toLowerCase()
  return n.startsWith('zh') ? 'zh' : 'en'
}

let lang = detect()
const subs = new Set()

/** Look up a key in the active dictionary. If the entry is a function, call it
 *  with the given args; otherwise return the string. Falls back to the key. */
export function t(key, ...args) {
  const v = DICT[lang][key]
  if (v == null) return key
  return typeof v === 'function' ? v(...args) : v
}

/** Friendly label for a halo tool name in the active language. */
export function toolLabel(name) {
  return (DICT[lang].tools && DICT[lang].tools[name]) || name || ''
}

export function getLang() { return lang }
export function nextLang() { return lang === 'zh' ? 'en' : 'zh' }

export function setLang(l) {
  if (!SUPPORTED.includes(l) || l === lang) return
  lang = l
  try { localStorage.setItem('halo_city_lang', l) } catch {}
  document.documentElement.lang = l === 'zh' ? 'zh' : 'en'
  subs.forEach((fn) => fn(l))
}

/** Subscribe to language changes (for live re-render). Returns an unsubscribe. */
export function onLangChange(fn) { subs.add(fn); return () => subs.delete(fn) }

/** Fill all [data-i18n] / [data-i18n-title] / [data-i18n-ph] elements. */
export function applyStaticI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((e) => { e.textContent = t(e.dataset.i18n) })
  root.querySelectorAll('[data-i18n-title]').forEach((e) => { e.title = t(e.dataset.i18nTitle) })
  root.querySelectorAll('[data-i18n-ph]').forEach((e) => { e.placeholder = t(e.dataset.i18nPh) })
  document.title = t('title')
}
