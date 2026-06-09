# Halo

[![npm](https://img.shields.io/npm/v/@turmind/halo?color=cb3837&logo=npm)](https://www.npmjs.com/package/@turmind/halo)
[![license](https://img.shields.io/npm/l/@turmind/halo?color=blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-43853d?logo=node.js&logoColor=white)](https://nodejs.org)

[English](README.md) | [中文](README.zh-CN.md)

**用自然语言驱动的多 Agent 协作工作区。** 描述你想做的东西，主 Agent 自动拆解任务、派发子 Agent 并完成交付 —— 全程你都能观察、纠正、随时接管。一切都以文件形式存在于一个可读、可编辑、可 fork、可分享的工作区里。

![Halo 工作区 —— 文件树、代码画布、聊天三合一](assets/workspace.jpg)

## 亮点

**🧬 会自我进化。** Halo 从自己的对话里学习。执行 `/note`（或 pre-compact 触发）后，内置的进化 Agent 会分析本次会话、起草对自身提示词文件的改进、在沙箱里 dry-run，再由打分 Agent 评估结果。你在 **Evolution** 标签页审核通过 → 改动合并回工作区。Agent 真的在打磨自己的指令，而你是审核人。

![Agents 面板 —— 全局 Agent，以及驱动自进化的内置 Apply / Evolution / Score Agent](assets/agents.jpg)

**🌐 一个工作区，全渠道接入。** 在浏览器里启动任务，手机微信上查看进度，Telegram 或 Slack 里追加指令。所有渠道连接的是*同一个*工作区和会话 —— 协作锚点是工作区，不是聊天窗口。

**🧠 模型 provider 无关。** 统一的 `ModelRuntime` 接口接入 10 家模型 provider，可按 Agent 配置。主力用 Bedrock 上的 Claude，常规子任务用更便宜的本地区域模型 —— 无需改代码。

**👁 透明编排。** 每个 Agent 的推理、工具调用、文件变更都实时可见。中断是优雅的（对话修复，而非硬停），子 Agent 完成后自动回报。你始终在 loop 里，而不是跑完看天意。

**🖥 IDE 级 Admin UI。** 聊天 + Monaco 编辑器 + 文件树 + 终端（xterm.js），一个浏览器标签页搞定。不用在"跟 AI 对话"和"看代码"之间来回切。

**📁 工作区即项目上下文。** Agent 配置、技能、会话历史、项目文档全是 `.halo/` 下的文件。Git 友好、可 fork。没有隐藏记忆，没有不透明状态。

**🔒 权限隔离。** 三级访问控制（`full` / `workspace` / `readonly`），由 bubblewrap 沙箱强制执行。给别人一个 `readonly` 入口，他们就能使用你的 Agent，但无法写你的文件。（仅文件系统隔离——见[现状与局限](#现状与局限)。）

## 快速开始

已发布到 npm，包名 [`@turmind/halo`](https://www.npmjs.com/package/@turmind/halo) —— 一个二进制，包含所有子命令：

```bash
npm install -g @turmind/halo
halo setup            # 交互式：密码 / 端口 / 模型密钥 / 可选技能
halo server start     # 默认监听 :9527
```

然后打开 **http://localhost:9527**。

- **Docker / CI**：用 `halo setup --non-interactive`，通过 `HALO_PASSWORD` 环境变量提供凭证。
- **从源码构建**：`pnpm install && pnpm build`。

| 前置依赖 | 版本 |
|---|---|
| Node.js | >= 22 |
| pnpm（仅源码构建需要） | >= 9 |
| AWS 凭证 | Bedrock 访问权限，默认 region `us-east-1` |

## 模型

通过统一的 provider 无关运行时按 Agent 配置。AWS Bedrock Claude 是主力目标，其余均为一等公民。

| Provider | 说明 |
|---|---|
| **AWS Bedrock Claude** | 主力 —— Bedrock Invoke API |
| AWS Bedrock Mantle | 经 Bedrock 接入 OpenAI GPT 系列 |
| Anthropic | 官方 API |
| OpenAI | 官方 / 任意 OpenAI 兼容端点 |
| DeepSeek | |
| Kimi（月之暗面） | |
| MiniMax | |
| Qwen（阿里云通义千问） | |
| Hunyuan（腾讯混元） | |
| Doubao（火山方舟豆包） | |

![设置 —— 全部模型 provider，可按 Agent 配置](assets/models.jpg)

## 渠道

所有渠道共享同一工作区和会话状态。接入指南见 [`.halo/docs/guide/channels/`](.halo/docs/guide/channels/)。

| 渠道 | 传输方式 | 说明 |
|---|---|---|
| **Admin** | WebSocket | 全功能浏览器 UI |
| **Web** | HTTP + SSE | Token 认证 API，可独立部署 |
| **CLI / TUI** | 本地 | 独立终端客户端，内嵌 agent loop（无需服务端） |
| **Telegram** | Bot API | 长轮询 |
| **Slack** | Socket Mode | 无需公网 webhook |
| **飞书 / Lark** | 长连接 | `appId` + `appSecret` |
| **微信** | 扫码绑定 | 扫码绑定，手机端访问 |
| **ACP adapter** | stdio JSON-RPC | 把 ACP 客户端（Claude Code 等）桥接到 Web 渠道 |

<p align="center">
  <img src="assets/wechat-phone.jpg" alt="微信里的 Halo" width="270" />
  &nbsp;&nbsp;
  <img src="assets/telegram-phone.jpg" alt="Telegram 里的 Halo" width="270" />
</p>
<p align="center"><sub>同一个工作区，在手机微信和 Telegram 上驱动。</sub></p>

## 更多能力

- **多 Agent 协作** —— 主 Agent 拆解任务并派发子 Agent；层级式会话，父子 Agent 异步协调。
- **工作区工具** —— `file_read` / `file_write` / `file_edit`、沙箱化 `shell_exec`、`grep` / `glob`、`web_fetch`、`view_image`，以及会话工具（`start_session`、`query_session`、`interrupt_session` 等）用于多 Agent 调度。
- **技能系统** —— 基于 Markdown 的技能定义，按需注入 Agent 提示词；工作区级或全局，无需改代码即可扩展。
- **Cron 定时任务** —— 定时（周期或一次性）运行 Agent，结果分发到绑定的渠道账号。

![技能面板 —— 全局与工作区技能，无需改代码即可扩展](assets/skills.jpg)

![Halo CLI / TUI](assets/cli.jpg)

## 技术栈

- **Monorepo**：pnpm workspace（`packages/core`、`server`、`admin`、`cli`）
- **后端**：Hono + WebSocket，单 Node.js 进程监听 9527
- **前端**：Next.js 15 静态导出，Hono 直接提供
- **Agent**：自建编排循环，provider 无关的 `ModelRuntime` 接口
- **存储**：SQLite + Drizzle ORM —— 无需搭建任何外部服务
- **运行时**：Node.js 22+，ESM，TypeScript strict

## 文档

- [`.halo/INDEX.md`](.halo/INDEX.md) —— 项目概况 + 文档索引
- [`.halo/docs/requirements/overview.md`](.halo/docs/requirements/overview.md) —— 产品概念
- [`.halo/docs/design/architecture.md`](.halo/docs/design/architecture.md) —— 后端架构
- [`.halo/docs/design/evolution.md`](.halo/docs/design/evolution.md) —— 自我进化设计
- [`.halo/docs/dev/deploy.md`](.halo/docs/dev/deploy.md) —— 部署（systemd / Nginx）
- [`.halo/docs/dev/env.md`](.halo/docs/dev/env.md) —— 环境变量、构建命令
- [`CLAUDE.md`](CLAUDE.md) —— Claude Code 开发说明

## 现状与局限

Halo 还很年轻，且为单人维护。它能跑，但请把它当作早期项目，而非成熟产品：

- **沙箱隔离文件系统，不隔离网络。** bubblewrap 沙箱覆盖访问级别和文件系统可达范围（宿主路径、`~/.aws`/`~/.ssh` 已遮蔽），但**不**隔离网络——沙箱内的代码仍可发起对外连接。它的威胁模型是防止受信任的 Agent **误操作和路径逃逸**，**而非**遏制一个蓄意外传数据的恶意 skill。网络隔离在路线图上。
- **暂无自动化测试。** 正确性依赖 review 和手工验证。相比铺开单测，更优先为已被外部钉死的契约（会话文件格式、WS 协议）补针对性测试。
- **单人维护，外部验证有限。** 预期会有粗糙之处；API 与磁盘格式在版本间仍可能变化。

如果你遇到问题或意外行为，欢迎提 issue——现阶段早期反馈非常有价值。

## Roadmap

见 [`.halo/docs/plans/roadmap.md`](.halo/docs/plans/roadmap.md)。

## License

MIT
