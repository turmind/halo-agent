# Halo

[English](README.md) | [中文](README.zh-CN.md)

多 Agent 协作工作区。用自然语言对话驱动复杂项目的全流程交付。

## 为什么选 Halo

**透明的多 Agent 协作** -- 大多数 agent 工具要么黑盒运行（跑完看结果），要么是单 agent CLI。Halo 让你实时看到每个 agent 的推理过程、工具调用和文件变更。随时暂停、纠正或接管。你始终在 loop 里。

**IDE 级 Admin UI** -- 聊天 + Monaco 代码编辑器 + 文件树 + 终端（xterm.js），一个浏览器标签页搞定。不用在"跟 AI 对话"和"看代码"之间来回切换。

**跨端共享工作区** -- 在浏览器里启动任务，手机微信上查看进度，Telegram 里下达指令。所有渠道连接同一个工作区和会话。协作锚点是工作区，不是聊天窗口。

**权限隔离** -- 三级访问控制（`full` / `workspace` / `readonly`），bubblewrap 沙箱强制执行。分享一个 `readonly` 入口，让别人安全使用你的 agent。

**工作区即项目上下文** -- 一切都是文件：agent 配置、技能、会话历史、项目文档。Git 友好，可 fork、可分享。没有隐藏记忆，没有不透明状态。

**轻量** -- 约 28K 行 TypeScript。单 Node.js 进程。无微服务、无容器编排，外部依赖仅 SQLite。

## 技术栈

- **Monorepo**：pnpm workspace（`packages/core`、`server`、`admin`、`cli`）
- **后端**：Hono + WebSocket，单进程监听 9527
- **前端**：Next.js 15 静态导出，Hono 直接提供
- **Agent**：自建编排循环，provider 无关的 ModelRuntime 接口
- **模型**：AWS Bedrock Claude（主力），以及 Anthropic、OpenAI、Deepseek、Kimi、MiniMax、Qwen、Hunyuan、Doubao
- **存储**：SQLite + Drizzle ORM
- **运行时**：Node.js 22+，ESM，TypeScript strict

## 前置依赖

| 依赖 | 版本 |
|------|------|
| Node.js | >= 22 |
| pnpm | >= 9 |
| AWS 凭证 | Bedrock 访问权限，默认 region `us-east-1` |

## 快速开始

```bash
npm install -g @turmind/halo   # 一个二进制，包含所有子命令
halo setup                      # 交互式：密码 / 端口 / 模型密钥 / 可选技能
halo server start               # 默认监听 :9527
```

浏览器访问 http://localhost:9527

Docker / CI 场景用 `halo setup --non-interactive`，通过 `HALO_PASSWORD` 环境变量提供凭证。如需从源码构建，执行 `pnpm install && pnpm build`。

## 核心功能

### 多 Agent 协作
- 主 Agent 自动拆解任务并派发子 Agent
- 层级式会话，父子 Agent 异步协调
- 优雅中断 + 对话修复（不只是硬停）
- 子 Agent 完成后自动回报
- 所有拆解和工具调用在 UI 上可见

### 工作区工具
- `file_read` / `file_write` / `file_edit` -- 工作区内文件操作
- `shell_exec` -- 沙箱化命令执行
- `grep` / `glob` -- 代码搜索
- `web_fetch` -- HTTP 请求
- `view_image` -- 视觉支持
- 会话工具（`start_session`、`query_session`、`interrupt_session` 等）用于多 Agent 调度

### 渠道
- **Admin（WebSocket）** -- 全功能浏览器 UI
- **Web（HTTP + SSE）** -- Token 认证 API，可独立部署
- **CLI / TUI** -- 独立终端客户端，内嵌 agent loop（无需服务端）
- **Telegram** -- Bot API 集成
- **Slack** -- Socket Mode，无需公网 webhook
- **飞书 / Lark** -- appId + appSecret 长连接
- **微信** -- 扫码绑定，手机端访问
- **ACP adapter** -- stdio JSON-RPC 桥接，供 Claude Code 等使用，复用 Web 渠道

所有渠道共享同一工作区和会话状态。

### 安全
- bubblewrap（`bwrap`）沙箱 OS 级隔离
- 应用层路径校验兜底
- 敏感路径屏蔽（`~/.aws`、`~/.ssh`、`~/.gnupg` 等）
- 按 Agent 强制执行访问级别：`full`、`workspace`、`readonly`

### 技能系统
- 基于 Markdown 的技能定义，按需注入 Agent 提示词
- 工作区级或全局技能
- 无需改代码即可扩展

## 文档

- [`.halo/INDEX.md`](.halo/INDEX.md) -- 项目概况 + 文档索引
- [`.halo/docs/requirements/overview.md`](.halo/docs/requirements/overview.md) -- 产品概念
- [`.halo/docs/dev/deploy.md`](.halo/docs/dev/deploy.md) -- 部署（systemd / Nginx）
- [`.halo/docs/dev/env.md`](.halo/docs/dev/env.md) -- 环境变量、构建命令
- [`.halo/docs/design/architecture.md`](.halo/docs/design/architecture.md) -- 后端架构
- [`CLAUDE.md`](CLAUDE.md) -- Claude Code 开发说明

## Roadmap

见 [`.halo/docs/plans/roadmap.md`](.halo/docs/plans/roadmap.md)。

## License

MIT
