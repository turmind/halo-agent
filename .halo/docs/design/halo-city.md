# Halo City · 像素街区可视化

Halo 服务器运行态的**街景式**像素可视化:侧视、剖面的像素城,实时天色下，
每个 **workspace 是一栋楼**，每个 **agent session 是一只 Q 版动物市民**，爬真楼梯
到真工位上班。点任何人打开他的**真实会话日志**（服务端流式拉取，和 admin 面板同源）。

只读、零构建、零贴图素材（每个像素都是代码画的）。网络流量：一个
`GET /api/show/state` 轮询，外加面板打开时的 `GET /api/show/session`。

> 接口契约见 [dev/api.md](../dev/api.md#show-world-snapshot)（`/api/show/state`、
> `/api/show/session` 的字段与鉴权）。本文只讲前端可视化设计。

## 街区结构

```
   ☀/☾  parallax skyline · clouds · stars ──────────────────────────
   ┌─[roof: water tank / AC / antenna / billboard]─┐
   │ W3  desks ×3 · skill station · flavor prop    │
   ├───────────────────────────────────────────────┤   ┌──────────┐
   │ C   公共层: 冰箱·水吧·书架·沙发·街机/鱼缸/猫 ─[阳台]│   │ next     │
   ├───────────────────────────────────────────────┤   │ building │
   │ W2 / W1  work floors …                        │   │          │
   ├───────────────────────────────────────────────┤   │          │
   │ 大堂: 前台 · 咖啡机 · 沙发 · 大门               │   │          │
   └─⌐stairs──────────────────────────────awning───┘   └──────────┘
 ──┴── sidewalk · 餐车 · 野餐桌 · 篮筐 · 单车架 · 路灯 ──┴───────────
      road        (楼距加宽:巷子就是楼下放风的地方)
```

| 看到的 | 意思 |
|---|---|
| 🏬 一栋楼 | 一个 workspace。**每 3 个工作层插 1 个公共层**(楼够高时),楼层数**贴合当前 root 会话数**(每层对应一个真实会话,顶上不留空层;增减都跟,但保留 1 层缓冲——会话数在两次轮询间 ±1 抖动不会让楼顶反复抽搐);砖材/霓虹竖牌/楼顶装置由 id hash 决定 |
| 🐾 动物市民 | 一个 agent session。**制服**(衬衫+条纹)认 agent 名 → 在哪都认得出"researcher";**物种/毛色/花纹/配件**(10 物种 × 多毛色 × 眼镜/耳机/斑纹)认 session id → 同 agent 并发的 session 是穿同款衬衫的不同动物。会眨眼,说话动嘴,狗走路摇尾巴 |
| 🪜 楼梯间 | 大楼左侧,真的逐层爬上爬下(没有传送) |
| 💺 工作层 | 每层 3 张工位(按 agent 名固定)+ 1 个技能站 + 随机小设施(盆栽/小书架/白板/售货机);干活时屏幕滚代码 |
| 🍵 公共层 | 冰箱(偶尔开门漏光)、水吧(水壶冒汽)、书报架、沙发,外加街机/鱼缸/猫爬架三选一;右侧伸出**阳台**(烟灰桶+盆栽)——抽烟点 |
| 🚬 习惯 | 每个 session 由 id hash 派生 **3 个固定偏好**(抽烟/咖啡/泡茶/翻冰箱/看书/街机/看鱼/撸猫/打电话/下楼遛弯/沙发),摸鱼时偏好权重 ~4×——"这个会话就爱在阳台抽烟"是稳定人设,不是随机骰子 |
| 🧭 就近原则 | 市民**生在自己的归属层**(自己的工位层;子代理用父代理的工位层),不再从大堂爬上来。休息活动以**归属层**为锚点就近找公共层(每 3 层就有),不会为了倒杯茶爬通天,**也不会随时间往低层漂**——12 楼的人永远回 F11 休息,不会一路沉到大堂。高层会话不下大堂:`下楼遛弯` 只有 F5 及以下才真下街,F6+ 改在就近休息层放风 |
| 💡 灯光 | 有人在的楼层灯亮(running 或 idle 都算——摸鱼也开灯),只有彻底 stopped 的层才熄;天黑后街灯/霓虹/远景窗火全亮 |
| ↳ 小一号 | 子代理:生在并聚在父代理那层桌边,不占工位 |

进出有戏:新会话直接出现在自己的工位层(从本层楼梯口走到工位,不再从街上爬通天);结束的走出门沿街远去淡出。

## 点击 = 真实数据

点任何市民,面板里是**真东西**:

- **会话日志**:`/api/show/session` 拉来的最近 40 条消息流——用户输入、助手回复、
  工具调用(带耗时),像 `tail -f` 一样贴底自动滚,面板开着每 6s 只刷日志框
  (面板本体原地补丁,不再整页重建闪烁)
- **上下文仪表**:`134k / 200k (67%)` —— 分母是该会话的**真实** `maxContextTokens`
- **委派链**:父/子会话可点击跳转,每行带 token 数和消息数
- **点楼层**:该层的会话委派关系树(缩进、可点跳转)——工作层看"谁在这层干活、
  带着哪些子代理",公共层看"谁在摸鱼"
- 点大楼:全员 roster + token 合计;点技能站:谁在用

## 街景与载具

街区不只是静态背景,会按**真实时间**自己演(`traffic.js`):

| 事件 | 节奏 | 说明 |
|---|---|---|
| 🛸 UFO | 每天 0:00 | 午夜从街头飘过 |
| ✈️ 飞机 | 每半点(`:30`) | 高空掠过,方向随机 |
| 🚌 巴士 | 每 3 分钟 | 进站、开门、接走在站台等车的人,再开走 |
| 🚗 进出场载具 | 跟随会话 | 新会话打车/电动车/跑车送到门口;结束的会话走到站台**体面地等车离场**,不再凭空消失 |
| 🏗️ 盖楼 / 拆楼 | 跟随楼层增减 | 长楼层有施工动效;拆楼留 ~30s 缓冲(先让人撤离再慢慢消散,不穿帮) |

> 定时全用真实 `Date.now()` 计算(`?hour=` 只冻结天色、不冻结这些事件)。

## 交互与显示

操作:滚轮缩放(九档 `0.3×–6×`)· 拖拽平移 · 点击查看 · **双击**在 1×/3× 间快速切 ·
**F** 全街区 · **H**(或点左上角 logo)切纯净模式 · **Esc** 逐层退(先关面板,再退纯净)·
右上角 **中/EN** 一键切语言。闲置 10s 后镜头沿街慢慢巡游。

- **纯净模式(zen)**:淡出所有 HUD(统计/动态/图例/缩放条/面板),只留街景,适合大屏常驻展示
- **多语言(i18n)**:中文 / English 一键切;`?lang=en`/`?lang=zh` 直达,选择存 localStorage。
  运行时文案走 `t()`,静态 DOM 走 `data-i18n` 属性填充

## 调试参数

- `?hour=22.5` — 把昼夜定格在某个时刻(支持小数;只冻结天色,不冻结街景事件)
- `?lang=en` / `?lang=zh` — 指定语言
- kiosk 直链:`/#api=…&token=…`(token 立即从地址栏抹掉)

## 文件结构

```
js/
  main.js      入口:setup → world → 输入/轮询
  api.js       state 轮询 + session 详情客户端(content-type 防呆)
  world.js     快照 → 城市/市民 diff,渲染循环,拾取
  city.js      街区:楼(材质/楼层/霓虹/楼顶)、大堂、街道、视差天际线
  citizen.js   市民:楼层×楼梯 2D 路径规划 + 行为 FSM
  people.js    人物绘制:动物物种×毛色×配件池,眨眼/口型
  props.js     家具:工位/技能站/咖啡机/街机/鱼缸/猫爬架/窗/灯
  palette.js   EDG32 + 建筑材质 ramp + 关键帧天空
  camera.js    整数吸附镜头(九档缩放 0.3×–6×)
  inspector.js 面板 + 实时会话日志查看器
  ticker.js    街区动态 feed
  traffic.js   街景事件:UFO(0点)/飞机(每半点)/进出场载具/每 3 分钟 bus/盖楼·拆楼
  i18n.js      多语言词典(zh/en)+ 运行时 t() + 静态 data-i18n 填充
  util.js      hash/PRNG/格式化
```

## 服务端配套

- `GET /api/show/session?ws=&id=` — 只读会话详情:裁剪后的消息日志 + 真实
  token 上限。鉴权同 `/api/show/state`(x-token;`full`/`observer` 可跨
  workspace 读取,其余 accessLevel 只能看自己 workspace)
- `/api/show/state` — 无活跃 UIState 的会话(idle/stopped/重启后)token
  从会话文件头读取(mtime 缓存,不随轮询刷盘),不显示 0;含 `messageCount` 字段

> **`observer` token 的权限面**:除了 `/show/state` 的聚合计数外,`observer`
> 还能调 `/show/session` 读取**任意 workspace** 任意会话的明细——最近 40 条
> 消息(每条截断到 600 字,tool input 截到 200 字)。它是"看板/监控"用的
> 全局只读角色,但这条 transcript 读取能力不止是计数;签发 observer token 时
> 要知道它相当于给了跨 workspace 的会话内容只读权限,不要把它当成纯粹的
> "数字仪表盘"凭证随手发放。

## 性能设计

原则:一个纯只读可视化页面,轮询**不得对服务端会话生命周期产生任何副作用**,
前端渲染成本随"画面里实际可见、实际变化的东西"伸缩,而不是随世界大小。

### 轮询零副作用(服务端)

show 路由只用 `registry.peek()`(只查内存 Map,**绝不创建** SessionManager——
构造函数是写重的:boot 孤儿回收会批量 stop 子会话行、还会往目录里播 `.halo/`)。
peek miss 时降级为**只读 sqlite 快照**:readonly 模式直开该 workspace 的
`.halo/halo.db`(连接进程内缓存,DB 缺失静默降级为空),行直接投影成 wire shape。
代价是非内存会话的数据滞后到上次持久化点、live 信号(lastTool/activeSkill)为空
——对可视化用途是正确取舍。详见 [dev/api.md](../dev/api.md#show-world-snapshot)。

### 前端渲染(js/ 各文件的注释有完整细节)

- **palette 记忆化**(palette.js):`shade/tint/alpha/mix` 纯函数按输入两级 Map
  缓存;alpha 比例 8-bit 量化、sky 颜色按 5s 量化,确定性验证像素 0 差异
- **vGradient 缓存**(city.js):sky/beach/sea/haze 的 `createLinearGradient`
  按几何+颜色 key 缓存,相机静止时 steady-state 分配归零
- **skyline offscreen layer**(city.js `Layer`):天际线剪影带在相机静止时每 5s
  sky tick 渲一次,其余帧一次 blit。**gradient 填充不得入 layer**——Skia 的
  gradient dither 锚定 device y,带偏移 blit 会整片移相(drawSea 因此回退直绘,
  教训详见 [memory/2026-07-02-canvas-gradient-dither.md](../../memory/2026-07-02-canvas-gradient-dither.md))
- **视口剔除**:楼整体(`buildingVisible`)与楼内逐层(`drawFloors`)双级剔除;
  市民绘制列表同样剔除(但位置模拟不剔——否则回屏跳变)
- **stateSig 签名比对**(main.js):快照签名(剔除 serverTime、uptime 取分钟粒度)
  未变时跳过整个 ingest/diff/rebuild,空闲服务器的轮询近乎零成本
- **后台停轮询**(api.js / inspector.js):`document.hidden` 时停止轮询,
  `visibilitychange` 恢复并立即刷一次——后台标签页零流量零 CPU
