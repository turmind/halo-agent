# Halo City · 像素街区可视化

Halo 服务器运行态的**街景式**像素可视化:每个 **workspace 是一栋楼**,每个
**agent session 是一只 Q 版动物市民**,点任何人打开他的真实会话日志。前端从
1.6.5 起迁到 halo-hub,作为扩展 `halo-city` 安装(装好后 admin 活动栏多一个
入口);本仓库只留数据接口 `packages/server/src/routes/halo-city.ts`。

> 前端设计(街区结构、交互、嵌入模式、文件结构、前端渲染性能)见 hub 的
> [extensions/halo-city/DESIGN.md](https://github.com/turmind/halo-hub/blob/main/extensions/halo-city/DESIGN.md)。本文只讲服务端配套。

## 服务端配套

- 接口契约见 [dev/api.md](../dev/api.md#show-world-snapshot):`GET /api/show/state`
  (快照轮询)和 `GET /api/show/session?ws=&id=`(只读会话详情)的字段与鉴权。
- **鉴权二选一**:带 token(`x-token`,Web Token,按 accessLevel 限定可见范围;
  带了 token 就只认 token),或不带 token、靠同源的 admin 登录 cookie,按 `full`
  处理——admin 里的扩展页就是这样免 token 的。
- 独立部署(不进 admin、走 token)要和 Halo 同源反代 `/api/show/`,nginx 写法见
  hub [README.md](https://github.com/turmind/halo-hub/blob/main/extensions/halo-city/README.md#和-halo-同源)。
- `/api/show/state` — 无活跃 UIState 的会话(idle/stopped/重启后)token
  从会话文件头读取(按会话 `updatedAt` 缓存,未变化时不随轮询重读),不显示 0;含 `messageCount` 字段
- `/api/show/state` 带弱 `ETag` + `Cache-Control: private, no-cache`:哈希不含
  `serverTime`,`uptime` 按分钟计入,所以服务器空闲时 7 秒一次的轮询绝大多数回
  空 body 的 304,每分钟最多一次 200。浏览器 `fetch` 默认缓存模式自动带
  `If-None-Match`,扩展不用改;鉴权仍在最前,不同 scope 的调用方 ETag 不同

> **`messageCount` 与 admin 的 `exchangeCount` 是两个语义,不要互相对齐**:
> 这里读的是会话文件里的 `messageCount`(活跃 UI 日志的长度),城市只把它
> 当"这个市民最近有多热闹"的活跃度信号,compact 归档后会变小是可以接受的;
> admin 会话列表用的是 sqlite 镜像列 `exchange_count`(整个生命期的主用户
> 轮次数,归档后不缩)。城市这边继续走文件头是有意的:它必须能在**没有活跃
> SessionManager**的情况下降级出图,不依赖 db 镜像何时写入。

## 轮询零副作用(服务端)

show 路由只用 `registry.peek()`(只查内存 Map,**绝不创建** SessionManager——
构造函数是写重的:boot 孤儿回收会批量 stop 子会话行、还会往目录里播 `.halo/`)。
peek miss 时降级为**只读 sqlite 快照**:readonly 模式直开该 workspace 的
`.halo/halo.db`(连接进程内缓存,DB 缺失静默降级为空),行直接投影成 wire shape。
代价是非内存会话的数据滞后到上次持久化点、live 信号(lastTool/activeSkill)为空
——对可视化用途是正确取舍。详见 [dev/api.md](../dev/api.md#show-world-snapshot)。
