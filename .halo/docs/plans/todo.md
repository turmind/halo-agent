# TODO

## Architecture

(done)

## Deep session nesting

(done) — detailed analysis in [issue-session-deep-nesting.md](issue-session-deep-nesting.md)

## Other

- [ ] `eventListeners` should support multiple listeners (Map<string, handler> → Map<string, handler[]>) so multiple frontends can subscribe to the same session tree simultaneously

## Workspace settings.yaml copy in share-workspace

share-workspace 当前完全排除 `settings.yaml`(stage.py:63 ALWAYS_EXCLUDED)。
但 workspace 自己的 `settings.yaml`(如 `<ws>/.halo/settings.yaml`,跟
`~/.halo/secrets/settings.yaml` 不同)其实包含项目特定的非 secret 偏好,
应该带走。需要区分:

- `~/.halo/secrets/settings.yaml` — 含密码 / API key,**永远不带**
- `<workspace>/.halo/settings.yaml`(如果存在) — 项目级偏好,**应该带**

实施时要看 workspace 是否真的支持 `<ws>/.halo/settings.yaml` 加载;如果
不支持,这条 todo 是个 feature request 而非修复。

## i18n: agent management "Internal" section

`agent-management-main.tsx` 新加的 internal scope label 当前是硬编码英文
"Internal"。其他 scope label 用了 i18n key (`t('common.global')` /
`t('common.workspace')`)。下次集中补 i18n 时加 `t('common.internal')`。
