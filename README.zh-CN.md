# Halo

[![npm](https://img.shields.io/npm/v/@turmind/halo?color=cb3837&logo=npm)](https://www.npmjs.com/package/@turmind/halo)
[![license](https://img.shields.io/npm/l/@turmind/halo?color=blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-43853d?logo=node.js&logoColor=white)](https://nodejs.org)

[English](README.md) | [中文](README.zh-CN.md)

**扔进去一个想法，一支 Agent 团队把它做出来。**

Halo 是一个用自然语言驱动的多 Agent 工作区。主 Agent 理解你的意图、拆解任务、并行派发给子 Agent —— 每一步推理和每一次工具调用都实时流过你眼前，你随时可以打断、纠偏、亲自上手。团队的所有知识和产出都是工作区里的普通文件，可读、可编辑、可 `git clone`、可分享。没有隐藏记忆，没有黑盒状态。

![Halo 管理台 —— 并行子 Agent 组装出的落地页，正在 Canvas 里实时预览](assets/workspace-hero.jpg)
<p align="center"><sub>一句话 ——「给我们的咖啡烘焙坊做个落地页……各节拆给子 Agent 并行做，最后组装」。Executor 们并行开工、逐个汇报，拼好的页面直接在 Canvas 里预览，全程一个浏览器标签页。</sub></p>

## 安装

```bash
npm install -g @turmind/halo   # 一个二进制，全部子命令
halo setup                     # 交互式：密码 / 端口 / 模型 key / 可选技能
halo server start              # → 打开 http://localhost:9527
```

> [!IMPORTANT]
> **第一条消息就报 `Could not load credentials from any providers`？** `halo setup` 里配的 API key 只是存下来了，**不会自动绑定到 Agent** —— 内置的 `default` Agent 初始指向 AWS Bedrock。去管理台 **Agents → default** 把 model provider 切成你配置的那家即可。（有可用 AWS 凭证链的 Bedrock 用户不受影响。）详见[快速开始](#快速开始)。

## 为什么是 Halo

### 🧬 它会改写自己的提示词 —— 而你审核这份 diff

Halo 从自己的对话里学习。执行 `/evo`（或 pre-compact 自动触发）：内置进化 Agent 分析本次会话、起草一份针对工作区提示词文件的补丁、在沙箱里用原始场景对打过补丁的 Agent 做 dry-run，再由打分 Agent 评定效果。你在 **Evolution** 标签页通过或驳回；通过的补丁合并回工作区。是你亲自审核的真实文件 diff —— 不是悄悄发生的微调。

![Evolution 标签页 —— 一条待审核记录：分数、dry-run 评语和补丁本体](assets/evolution-review.jpg)
<p align="center"><sub>一条真实的待审核记录：lint / behavior / scope 三项分数、打分 Agent 的评语、补丁本体 —— 点一下就合并进工作区。</sub></p>

### 📁 整支 Agent 团队就是一个文件夹

人设、技能、知识、会话历史 —— 整个团队都以普通文件的形式住在 `.halo/` 里：

```
my-project/
├─ .halo/
│  ├─ agents/     # 团队成员 —— 每个 Agent 的人设、模型、工具
│  ├─ skills/     # 会做什么 —— Markdown 技能，按需注入
│  ├─ docs/       # 学到了什么 —— Agent 读写的知识库
│  ├─ memory/     # 按日期记录的决策笔记
│  └─ sessions/   # 每一次对话，可回放
└─ src/ …         # 你真正的项目
```

`git clone` 这个工作区，对方拿到的是一支完整可运行的 Agent 团队 —— 不是导出物，是本体。这也是自进化成立的前提：进化 Agent 改的是真实文件，你审的是真实 diff。

### 🌐 一个工作区，所有屏幕

在浏览器里开工，地铁上用微信看进度，Telegram 或 Slack 里补一句需求，最后在终端里收尾。所有渠道连的都是*同一个*工作区和会话 —— 渠道只是门，工作区才是房间。

<p align="center">
  <img src="assets/wechat-phone.jpg" alt="微信里的 Halo" width="270" />
  &nbsp;&nbsp;
  <img src="assets/telegram-phone.jpg" alt="Telegram 里的 Halo" width="270" />
</p>
<p align="center"><sub>同一个工作区，在手机微信和 Telegram 上无缝续聊。</sub></p>

### 👁 看着它思考

每一步推理、每次工具调用、每处文件改动都实时可见 —— 子 Agent 内部也不例外。打断是优雅的（对话修复，而非硬杀进程），子 Agent 完工自动汇报。你始终在环内，而不是「跑起来听天由命」。

![聊天面板 —— 主 Agent 并行派发三个 executor 子 Agent](assets/orchestration.jpg)
<p align="center"><sub>主 Agent 并行拉起三个 executor —— 每个 <code>start_session</code>、每次工具调用都即时可见。</sub></p>

如果比起日志你更想要点氛围感：[Halo City](#halo-city) 会把同一份运行时渲染成一座活的像素小镇。

## 开箱即有

- **11 家模型 Provider，一套运行时** —— provider 和模型按 Agent 配置：重活给 Bedrock 上的 Claude，例行子任务给便宜的本地区模型，零代码改动。
- **IDE 级管理台** —— 聊天 + Monaco 编辑器 + 文件树 + Git 面板 + 终端（xterm.js），一个浏览器标签页全搞定。
- **技能系统** —— Markdown 技能定义按需注入提示词；工作区级或全局，不用写代码。
- **Cron 定时任务** —— 定时（循环或一次性）跑 Agent，产出自动分发到绑定的聊天渠道。
- **权限隔离** —— `full` / `workspace` / `readonly` 三级访问，由 bubblewrap 沙箱强制执行（仅文件系统层 —— 见[现状与局限](#现状与局限)）。
- **ACP 适配器** —— 把 halo 工作区作为原生 ACP Agent 接进 Claude Code，或让一个 halo 委派另一个 halo。
- **结构化会话** —— 父子层级会话、异步协同、完工自动汇报。

## v0.2.1 新亮点

- 🎨 **四套 UI 主题** —— dark / light / midnight / warm，服务端同步，换个浏览器也是你选的那套。
- ⌨️ **TUI 大改** —— 独立终端客户端重做了输入体验，新增 verbose 模式和历史持久化。
- 🏙 **Halo City 性能** —— 视口裁剪 + 离屏天际线，繁忙服务器上依然流畅。
- 📊 **PPTX 演讲备注侧栏** —— 幻灯片预览现在带备注栏。
- ✂️ **优雅打断，全程可见** —— 被打断的工具调用会被修复并显示在会话里，不再凭空消失。

![四套主题 —— dark、light、midnight、warm](assets/themes.jpg)

## 快速开始

以 [`@turmind/halo`](https://www.npmjs.com/package/@turmind/halo) 发布在 npm —— 一个二进制，全部子命令。跑完上面三行安装命令后，打开 **http://localhost:9527**。

| 前置条件 | 说明 |
|---|---|
| Node.js >= 22 | 唯一的硬性系统要求 |
| 任一受支持模型 Provider 的 API key | `halo setup` 时填入；AWS Bedrock 用户可以不填 key，走标准凭证链（env / `~/.aws` / 实例角色） |
| pnpm >= 9 | 仅源码构建需要 |

- **把 Provider 绑到 Agent 上**：`halo setup` 只负责存 key，用哪家是 Agent 自己的配置。内置 `default` Agent 出厂指向 AWS Bedrock —— 如果你配的是别家，去 **Agents → default → model provider** 切换一次，第一次对话就能顺利跑通。
- **升级**：`halo upgrade && halo server restart`。启动检查会在磁盘模板版本落后时自动刷新内置文档 / Agent / 技能。
- **Docker / CI**：`halo setup --non-interactive`，凭证走 `HALO_PASSWORD` 环境变量。
- **源码构建**：`pnpm install && pnpm build`。

### 用 curl 直接对话

每个工作区都能暴露一个 token 鉴权的 HTTP + SSE 端点 —— 即 Web 渠道，「自己造 UI」专用通道：

1. 管理台打开 **Channels → Web → Add Account**，选好工作区和访问级别，复制 token（只显示一次）。
2. 流式对话：

```bash
curl -N -H "x-token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"这个工作区里有什么文件？"}' \
  http://localhost:9527/api/web/chat
```

响应是 SSE 帧 —— `session` / `thinking` / `tool_call` / `stream` / `complete` —— 完整协议见 [`.halo/docs/guide/channels/web.md`](.halo/docs/guide/channels/web.md)。

## 模型

按 Agent 配置，走同一套 provider 无关的运行时。AWS Bedrock Claude 是第一优先目标，其余同为一等公民。

| Provider | 说明 |
|---|---|
| **AWS Bedrock Claude** | 主力 —— Bedrock Invoke API |
| AWS Bedrock Mantle | 经 Bedrock 使用 OpenAI GPT 系模型 |
| Anthropic | 官方直连 API |
| OpenAI | 直连 / 任意 OpenAI 兼容端点 |
| DeepSeek | |
| Kimi（月之暗面） | |
| MiniMax | |
| Mimo（小米） | Anthropic 兼容网关，1M 上下文 |
| Qwen（阿里云） | |
| Hunyuan（腾讯混元） | |
| Doubao（火山引擎豆包） | |

![设置页 —— 全部模型 Provider，按 Agent 配置](assets/models.jpg)

## 渠道

所有渠道共享同一份工作区与会话状态。各渠道接入指南见 [`.halo/docs/guide/channels/`](.halo/docs/guide/channels/)。

| 渠道 | 传输 | 说明 |
|---|---|---|
| **Admin** | WebSocket | 全功能浏览器管理台 |
| **Web** | HTTP + SSE | Token 鉴权 API，可独立部署 —— 见 [curl 示例](#用-curl-直接对话) |
| **CLI / TUI** | 本地 | 独立终端客户端，内嵌 Agent 循环（无需服务器） |
| **Telegram** | Bot API | 长轮询 |
| **Slack** | Socket Mode | 无需公网 webhook |
| **飞书 / Lark** | 长连接 | `appId` + `appSecret` |
| **微信** | 扫码绑定 | 手机扫码即用 |
| **ACP 适配器** | stdio JSON-RPC | 把 ACP 客户端（Claude Code 等）桥接到 Web 渠道 |

![Halo TUI —— 终端里流式呈现委派与汇报](assets/tui.jpg)
<p align="center"><sub>TUI 在你的终端里跑同一套 Agent 循环 —— 图中正委派 executor 干活并汇总其报告，全程无需服务器。</sub></p>

## Halo City

一座只读的像素之城，实时可视化一台 halo 服务器：每个工作区是一栋楼，每个会话是一只动物市民 —— 干活时伏案敲键盘，闲下来喝咖啡、打街机。点击任意市民，看到的是真实数据：实时会话日志、委派链、最近一次工具调用、token 用量。纯客户端 canvas，只轮询一个接口 —— **零模型 token 消耗**。

![Halo City 街景 —— 子 Agent 市民伏案工作，右侧检查面板已打开](assets/halo-city-street.jpg)
<p align="center"><sub>街景视角：<code>aurora-cafe</code> 楼里三只子 Agent 市民埋头干活；检查面板里是其中一个 executor 的实时日志和委派链。</sub></p>

代码在 [`halo-city/`](halo-city/)（纯静态文件，无需构建）—— 设计笔记见 [design/halo-city.md](.halo/docs/design/halo-city.md)。

## 技术栈

- **Monorepo**：pnpm workspace（`core`、`server`、`admin`、`cli`、`desktop`、`acp-adapter`、`web-demo`）
- **后端**：Hono + WebSocket，单 Node.js 进程，端口 9527
- **前端**：Next.js 15 静态导出，由 Hono 直接托管
- **Agent**：自研编排循环，provider 无关的 `ModelRuntime` 接口
- **存储**：SQLite + Drizzle ORM —— 不需要额外拉起任何外部服务
- **运行时**：Node.js 22+，ESM，TypeScript strict

## 文档

- [`.halo/INDEX.md`](.halo/INDEX.md) —— 项目总览 + 文档索引
- [`.halo/docs/requirements/overview.md`](.halo/docs/requirements/overview.md) —— 产品概念
- [`.halo/docs/design/architecture.md`](.halo/docs/design/architecture.md) —— 后端架构
- [`.halo/docs/design/evolution.md`](.halo/docs/design/evolution.md) —— 自进化设计
- [`.halo/docs/guide/channels/`](.halo/docs/guide/channels/) —— 各渠道接入指南
- [`.halo/docs/dev/deploy.md`](.halo/docs/dev/deploy.md) —— 部署（systemd / Nginx）
- [`.halo/docs/dev/env.md`](.halo/docs/dev/env.md) —— 环境变量、构建命令
- [`CLAUDE.md`](CLAUDE.md) —— 面向 Claude Code 的开发说明

## 现状与局限

Halo 还年轻，且只有一个维护者。它能跑，但请把它当早期项目看待，而不是打磨成熟的产品：

- **沙箱隔离的是文件系统，不是网络。** bubblewrap 沙箱覆盖访问级别与文件系统边界（宿主路径、`~/.aws`/`~/.ssh` 屏蔽），但**不做**网络隔离 —— 沙箱内代码仍可对外连接。威胁模型是「可信 Agent 的误操作与路径逃逸」，**不是**「恶意技能的数据外泄防护」。网络隔离在路线图上。
- **还没有自动化测试。** 正确性目前依赖 review 和人工验证。计划优先为对外锁定的契约（会话文件格式、WS 协议）补针对性测试，而非铺开单测覆盖。
- **单人维护，外部验证很少。** 会有毛边；API 和磁盘格式在版本间仍可能变化。

碰到坏掉或奇怪的行为，请开 issue —— 现阶段的早期反馈真的很有用。

## 许可证

MIT
