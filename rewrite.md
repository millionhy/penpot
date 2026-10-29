# Penpot 技术改造计划（渐进式路线）

> 本次修订（2026-10-02）依据 `archify` 生成的架构图与当前仓库真实结构（Penpot v2.17.0）重排：
> 新前端落到 `frontend-nextjs/`，新后端落到 `backend-rust/`；**前端优先**。2026-10-16 阶段 B
> 改口径为「**实现但不接入部署**」（可写 `backend-rust` 实现与测试，仍不改 `backend/`、不接 nginx）。

| 项目 | 值 |
| --- | --- |
| 文档状态 | 规划已对齐当前仓库；阶段 F 进行中（F0–F4 完成；F5 dashboard：F5.1 外壳与数据基座、F5.2 完整网格与 files 路由、F5.3 libraries/deleted/search、F5.4 自定义字体、F5.5 团队管理、F5.6 templates/binfile/快捷键注册表完成，F5.7 organization/team switch 与 subscription/nitrate 完成；F6 viewer：F6.1 数据层、F6.2 外壳、F6.3 导航与缩放交互、F6.4 WASM 渲染、F6.5 interactions、F6.6 收尾完成；F7 plugins：F7.1–F7.4 完成；F9 workspace：F9.1–F9.12、F9.3 伴随变更与文本/图片/路径工具完成） |
| 基线版本 | Penpot v2.17.0（archify revision `84c794c5b8`） |
| 架构依据 | `.archify/architecture-penpot-20261002-123416/penpot-architecture.html`（validate/deliver/check/browser-check 四门禁全过） |
| 当前阶段 | 阶段 F（frontend-nextjs）进行中；阶段 B（backend-rust）**计划已批准**，按「实现但不接入部署」推进 |
| 策略 | 绞杀者模式（Strangler Fig），新旧并行、逐模块替换 |
| 硬性门禁 | 不改 `backend/` 一行；`backend-rust` **可写代码但不接入部署**（不接 nginx/反代、不加灰度开关、不改 `docker/` 与 `scripts/ci` 现有 target）；执行计划见 `backend-rust/PLAN.md`，上下文快照见 `backend-rust/HANDOFF.md` |
| 最后更新 | 2026-10-28 |

> **状态更正**：本文件早期修订声称阶段一已产出 `tools/`、`api/`、`apps/`、`packages/`、根
> `Cargo.toml` 等交付物。核对当前 checkout（`git status` 干净，仅 `.archify/` 未跟踪）后确认这些
> 产物**均不在本仓库**，且基线应为 v2.17.0 而非 v1.20.0。本版据此把相关状态重置为「未落地」，
> 改用 `frontend-nextjs/` + `backend-rust/` 目录方案，并以架构图为事实来源。

---

## 0. 任务追踪总表

图例：✅ 完成　🔧 进行中　⬜ 未开始　⛔ 阻塞（附解锁条件）

### 阶段 F：frontend-nextjs（前端优先）

| 编号 | 任务 | 状态 | 交付物 / 说明 |
| --- | --- | --- | --- |
| F0 | Next.js 脚手架 + RPC 传输层 | ✅ | `frontend-nextjs/`：App Router 路由树、`lib/rpc.ts`（移植 `repo.cljs` 的 `send!/cmd!`）、`lib/{transit,errors,config,routes,types}.ts`、登录页 P0 样板、`next.config.mjs` 后端反代 |
| F0.1 | 安装依赖并跑通构建 | ✅ | `pnpm install` / `pnpm typecheck` / `pnpm build` 全部通过；登录页经 3450 代理对 docker 后端端到端验证 |
| F1.1 | 移植 Transit 自定义 handler | ✅ | `lib/transit.ts`：u/m/:/n/duration/uri/ordered-map/ordered-set/set/penpot/pointer 读取 handler + mapBuilder 规范化为普通 JS，12 项编解码单测通过；file-data 写入 handler（point/matrix 等）随 F6/F9 移植 |
| F1.2 | `packages/api-types` 生成器 | ✅ | `scripts/generate-types.mjs`：解析 backend/src + common/src 的 malli schema（含 ns 别名/:as-alias/:refer/限定符号/基础类型表）→ `src/index.ts`（RpcCommandName/RpcParams/RpcResults）；186 命令，params 184、results 51；file-data 域动态 schema 降级 unknown（F6/F9 收口）；已接线 app（workspace 依赖 + transpilePackages + lib/types.ts） |
| F1.3 | URL 兼容层 | ✅ | `lib/legacy-routes.ts` + `components/url-compat.tsx`：`?screen=<name>` 与 legacy `#/<path>`（含 `:file-id` 路径参数）客户端 replace 到 App Router 路径，14 项解析器单测通过 |
| F1.4 | 会话与引导 | ✅ | `lib/session.tsx`（SessionProvider：get-profile 引导，zero-uuid=匿名）+ `components/auth-guard.tsx`；dashboard/settings 布局与 workspace/view 页加守卫；根路径复刻空 token 分支；登录页接入 `session.refresh` |
| F2 | 设计系统基线 | 🔧 | 令牌移植完成：`styles/tokens.css`（调色板/双主题语义色 light+default/spacing/sizes/borders/z-index/elevations/typography 变量）+ `app/globals.css`（@font-face worksans/vazirmatn/robotomono、`.pp-typ-*` 排版工具类、token 化基础样式）+ 字体资产 `public/fonts/`。F4 的 modal 需求由外壳自带的 `components/modal.tsx`（ModalProvider/ConfirmDialog）满足，profile 驱动的主题切换也已接上令牌；`@penpot/ui`（React + react-aria-components + SCSS modules，exports 指向未构建的 dist）接线推到 F5 dashboard（首个需要 menu/dropdown 的路由组） |
| F3 | auth 路由组（`/auth/*`） | ✅ | login/register/register-validate/register-success/recovery-request/recovery/verify-token 七页 + `app/auth/layout.tsx`（对应 `app.main.ui.auth/auth*`）；命令链 `login-with-password`、`prepare-register-profile`→`register-profile`、`request-profile-recovery`、`recover-profile`、`verify-token`、`create-demo-profile`；随附公共件：词条生成器 + `lib/forms` + 通知 + `lib/storage` + flags 解析；vitest 91 例；SSO/LDAP 未做（需 OIDC 配置，另立任务） |
| F4 | settings 路由组（`/settings/*`） | ✅ | `app/settings/{layout,profile,password,notifications,options,feedback,shortcuts}`（shortcuts 占位后随 F5.6 补齐）；命令 `update-profile`、`update-profile-password`、`update-profile-notifications`、`update-profile-props`、`update-profile-photo`、`delete-profile-photo`、`request-email-change`、`delete-profile`、`send-user-feedback`；随附公共件 `cmdUpload`（multipart）、ModalProvider/ConfirmDialog、ThemeManager（profile → `<html>` class）、canvas 头像、forms 的 select/radio/textarea + `oneOf`；修两处缺陷：词条抽取漏扫 `labelKey` 数据字段（169→174 条）、dev 下 `/assets` 反代拿不到 `x-accel-redirect` 的文件（拆出 `PENPOT_ASSETS_ORIGIN`）；vitest 137 例 + headless Chrome/CDP 33 项端到端断言；subscription/integrations/release-notes 未做（见 7.6） |
| F5 | dashboard 路由组（`/dashboard/*`） | 🔧 | 11 个路由、约 7000 行 CLJS UI + 1600 行 data 层，切成 F5.1–F5.7 七片（F5.1–F5.6 完成；F5.7 进行中，organization/team switch 与 subscription/nitrate 已完成），见下与第 4 节 |
| F6 | viewer（`/view`） | ✅ | 六片全部完成（F6.1–F6.6：数据层、外壳、导航与缩放、WASM 渲染、interactions、收尾），见下与第 4 节；集成 `render-wasm`（route B 复用编译产物） |
| F7 | 插件运行时 | ✅ | 复用 SES 沙箱与 Plugin API（`frontend/src/app/plugins*`、`plugins/`）；四片全部完成（F7.1 数据层、F7.2 安装与管理 UI、F7.3 运行时接入、F7.4 完整 API 上下文：workspace 代理 + 事件派发 + 画布桥接，见 7.44）；结构写/文本/媒体/代码生成等延后项以命名错误登记 |
| F8 | WebSocket 协作客户端 | ⬜ | 连 `/ws/notifications`（直连后端源，见 README） |
| F9 | workspace 编辑器 | 🔧 | 最高风险，按切片推进：F9.1 数据基础与只读画布（f94a–f94j，见 7.23）、F9.2 画布交互与选择（悬停/点选/框选/平移，SVG 覆盖层，零写入，见 7.24）、F9.3 拖动移动与保存（首个写路径，见 7.25）、F9.4 外壳与菜单（三栏、左头/主菜单/缩放/图层/工具栏/帧标题，见 7.27）、F9.5 绘制工具与样式面板（frame/rect/ellipse 绘制 + 右栏基础样式段，见 7.29）、F9.6 resize/rotate 手柄（八手柄 + 四旋转区、修饰键、一次提交，见 7.30）、F9.7 撤销/重做（客户端栈、自动反向、Ctrl/Cmd+Z 与菜单，见 7.31）与 F9.8 z-order 插入（四条命令、index 全链路、撤销保真，见 7.32）完成；F9.3 伴随变更（hide-in-viewer、layout-item 清理、组件元数据同步、flex sizing，见 7.33）与 drop-index（flex 插入/重排、绘制插入、mov index，见 7.34）完成；F9.9 样式面板扩展（尺寸/位置/旋转、阴影/模糊、布局/布局项/约束、多选批量，见 7.36–7.37）与 F9.10 子级传播与约束（resize 按约束重排子级、rotate 刚性带动子树，见 7.38）完成；F9.11 布局 reflow（约束与重排统一走 wasm 的 propagate，见 7.39）与 F9.12 grid cells 入口（面板 Grid cell 段、cell map 分区维护、uuid/keyword 编码，见 7.40）完成；F9.5 的文本/图片/自由手绘路径补齐（行内文本编辑、媒体上传与 wasm 图像注册、curve 手势，见 7.45）；余下按 7.25 路线补浏览器冒烟；F7.4 已完成（见 7.44）；Web Worker + 协作光标等留 F8 后 |

### 阶段 B：backend-rust（Rust + axum，计划已批准）

门禁口径：实现但不接入部署。执行计划（里程碑 M0–M8、已核对契约事实、风险、红线）在
`backend-rust/PLAN.md`。

| 编号 | M | 任务 | 状态 | 说明 |
| --- | --- | --- | --- | --- |
| B0 | — | `backend-rust/` 目录 + 规划 README | ✅ | 占位、crate 规划、门禁说明 |
| B0.1 | — | 阶段 B 执行计划 | ✅ | `PLAN.md` + `HANDOFF.md`；决策：axum、crate 名无前缀、`transit` 自建 enum、实现但不接入部署 |
| B0.2 | M0 | Cargo workspace + Makefile | ⬜ | `crates/{transit,errors,config,session,db,storage,worker,ws,rpc}`；不接 `scripts/ci` |
| B1 | M1 | `transit` crate | ⬜ | Transit+JSON reader/writer + Penpot 标签 + `^ `/`^N` 缓存；预言机 = `transit-js`（不需后端） |
| B2 | M2 | `errors` + `config` crate | ⬜ | `ex-data` → HTTP status/body；`PENPOT_*` env + flags |
| B3 | M3 | `rpc` crate（axum 骨架） | ⬜ | 三组路由 + 中间件同序 + Registry；本地 `cargo run`，不接 nginx |
| B4 | M4 | `session` crate | ⬜ | JWE `a256kw`+`a256gcm` + HKDF-BLAKE2b-512；会话查 **`http_session_v2`**（旧表已由 `0155` 删除）；兼容性待 C1 向量 |
| B5 | M5 | `storage` crate | ⬜ | `storage_object`/bucket/去重/GC；`:fs`/`:s3`；对齐 `backend/src/app/storage` |
| B6 | M6 | `worker` crate | ⬜ | Quartz 6 段 cron、task 状态机、`FOR UPDATE SKIP LOCKED` 认领、Redis `tenant:queue`；`task.props` = **jsonb transit**（不是 Fressian） |
| B7 | M7 | `ws` crate | ⬜ | axum WebSocket + msgbus topic；RedisBus trait + InMemoryBus（离线测试） |
| B8 | M8 | `rpc` 只读命令承接 | ⛔ | 前置：C3 DDL + C4 OpenAPI + 补齐 `::sm/result` + 可用 devenv。永久排除：`add-file-transient-changes`/binfile/files 写路径/thumbnails/nitrate（`file.data` blob = Fressian v4/v5，JVM 专有） |
| — | — | `render-native` | ⬜ 暂缓 | `render-wasm` 无 headless-native API（24 处 `cfg(target_arch="wasm32")` + GL `gpu_state`），需先抽 core 且要 file-data 解码 |

### 支撑任务（契约，只读后端，可与阶段 F 并行）

| 编号 | 任务 | 状态 | 说明 |
| --- | --- | --- | --- |
| S1 | RPC 命令清单提取 | ✅ | `packages/api-types/scripts/scan-rpc-inventory.mjs` 静态扫描 `backend/src`（只读）→ `rpc-inventory.json`：189 条命令（29 公开、183 有 params schema、50 有 result schema），含 ns/文件/行号/auth/added |
| S2 | OpenAPI 快照 | ⛔ | 需 JVM + Clojure 依赖或运行中的后端；解锁见 §8 |
| S3 | DB Schema 快照 | ⬜ | 从迁移重放 DDL（`scripts/db-schema`）；B5/B6 的 sqlx 类型输入。需活 PG |
| S4 | Transit 金样本语料 | ⬜ | 用 `frontend-nextjs/node_modules/transit-js` 作预言机离线生成（**不需后端**）；解锁 B1 |
| S5 | JWE 兼容性向量 | ⛔ | 仓库内无样本（grep `eyJ` 无命中）；需 devenv 登录后取 cookie `auth-token` + `PENPOT_SECRET_KEY`；解锁 B4 |

---

## 1. 背景与现状

### 1.1 模块盘点

来自 `.serena/memories/critical-info.md` 与仓库实际目录（v2.17.0）：

| 模块 | 技术 | 位置 | 迁移取向 |
| --- | --- | --- | --- |
| 前端 | ClojureScript + Potok + Rumext/React 19 | `frontend/` | 由 `frontend-nextjs/` 逐路由绞杀 |
| 后端 | Clojure（JVM）+ Integrant | `backend/` | 保留；阶段 B 起由 `backend-rust/` 增量承接 |
| 共享层 | CLJC（类型/几何/schema/file-change） | `common/` | 保留；前端侧以 TS 类型重表达（F1.2） |
| 渲染引擎 | Rust → WASM（Skia + WebGL） | `render-wasm/` | **保留并复用**（Next.js 直接加载 wasm） |
| 导出服务 | ClojureScript + Node + Playwright | `exporter/` | 保留；阶段 B 评估 Rust 原生导出 |
| 媒体处理 | TypeScript/Node（sharp + FontForge） | `media-processor/` | 保留 |
| MCP | TypeScript（WS :4402） | `mcp/` | 保留 |
| 插件 | TypeScript 运行时 + Plugin API | `plugins/` | 保留；前端侧复用 SES 运行时 |
| 设计库 | `@penpot/library` | `library/` | 保留 |

依赖图：`frontend → common`、`backend → common`、`exporter → common`、`frontend → render-wasm`。

### 1.2 架构图谱（archify）

架构图（已通过 4 项 finalize 门禁）给出的组件与关键连线，是本次改造的事实来源：

- **客户端**：`designer`（浏览器）→ `frontend`（CLJS · Potok）；前端动态载入 `wasm`
  （render-wasm，Rust→WASM·Skia）与 `plugins`（SES 沙箱），缩略图/索引/导入跑在独立 Web Worker。
- **前后端主链路**：`frontend → backend` 走 **Transit RPC `/api/main/methods`**（强调边）；
  `backend → frontend` 走 **WS 广播文件变更**。
- **后端下游**：`backend → { postgres（SQL，强调边）, redis（Pub/Sub·缓存）, objstore（媒体对象）,
  mediaproc（图片/字体）, oidc（OAuth2）, ldap（可选登录） }`。
- **导出流水线**：`frontend → exporter`；`exporter → backend`（共享密钥 RPC · upload-tempfile）、
  `exporter → redis`（发布进度）。
- **异步任务**：`dispatcher → postgres`（FOR UPDATE SKIP LOCKED 认领）+ `→ redis`（RPUSH 任务 ID）；
  `runner → redis`（BLPOP）+ `→ postgres`（回写状态）+ `→ smtp`（sendmail）。Postgres `task` 表是
  唯一跨实例协调点，Redis 只做进程内交接。
- **扩展**：`plugins → mcp`（WS :4402）。
- **部署**：nginx 反代到 `backend:6060`（路由表 `/api/main`、`/api/management`、`/ws/notifications`、`/assets`）。

> 对前端的含义：`frontend-nextjs` 要替换的是 `frontend` 节点，**保留**它对 `backend`（RPC+WS）、
> `wasm`、`plugins` 的既有连线。render-wasm 已是 Rust→WASM，可被 Next.js 原样复用，是最低风险的
> 性能资产；真正的 Rust 后端切入点在阶段 B（render-native/storage/worker/ws-gateway）。

### 1.3 关键发现

- 前端已用 React 19.3.0，并有本地设计系统包 `@penpot/ui`（`frontend/packages/ui`，当前含 menu/modal）。
  Next.js 外壳应复用它，无需另起 shadcn/Tailwind（早期修订的选型据此更正）。
- 认证不是 JWT：会话令牌是 JWE（`A256KW`+`A256GCM`），载荷 transit+json，密钥由 HKDF-BLAKE2b-512
  派生；且「密码学有效」≠「已认证」——登出/吊销/`is_blocked` 在 `http_session` 表。前端只经 cookie
  `auth-token` 复用既有会话，无需新令牌机制。
- 当前 URL 形态是查询串路由（`?screen=<name>`）+ legacy `#/…`（见 `app.main.ui.routes`）；Next.js
  改用路径段，需要 F1.3 兼容层。
- 已核对的真实 RPC 命令（用于 P0/P1 页面）：`login-with-password`、`get-profile`、`create-profile`、
  `request-profile-recovery`、`update-profile-password`、`get-teams`、`get-projects`、
  `get-project-files`、`get-team-members`。
---

## 2. 全量重写不可行（结论保留）

近千个源文件、深层嵌套的不可变数据结构、`common/` 跨端共享、实时协作一致性、上百个迁移的兼容——
全量 Clojure→Rust+Next.js 投入产出比过低（早期修订估约 4.5 年、峰值 16 人、200+ 人年），且业务
连续性风险极高。**不推荐全量重写**，改为绞杀者模式渐进替换。

> 注：上述量化数字来自早期修订在另一 checkout 的静态统计，本仓库尚未重新提取；待 S1/S3 重新生成后回填。

---

## 3. 渐进式策略

### 3.1 目标架构（与 archify 对齐）

```
                         Nginx / CDN
                              |
        +---------------------+---------------------+
        |                                           |
  frontend-nextjs                          frontend (CLJS)
  (Next.js · React 19 · SSR)               (保留, 逐路由绞杀, 最后剩 workspace)
        |                                           |
        +---------------------+---------------------+
                              |  Transit RPC /api/main/methods · WS /ws/notifications
                              v
                  backend (Clojure, 保留)   <-- 阶段 B 起增量并存 -->  backend-rust (axum)
                              |                                        render-native / storage /
                    PostgreSQL / Redis / S3                            worker / ws-gateway / rpc

  客户端复用： render-wasm (Rust→WASM, 前后端共用) · plugins (SES) · @penpot/ui
  契约(只读后端)： RPC 清单(S1) · OpenAPI(S2) · DB Schema(S3) → packages/api-types(F1.2)
```

### 3.2 核心原则

1. **前端优先，后端「实现但不接入部署」**：`frontend-nextjs` 的路由组继续逐个迁移到功能对等；
   `backend-rust` 可写实现与测试，但不接 nginx/反代、不加灰度开关、不改 `backend/` 与 `docker/`。
2. **复用而非重写**：render-wasm、plugins(SES)、`@penpot/ui`、既有会话与 RPC 协议全部复用。
3. **Next.js 做外壳**：替换路由/SSR/首屏与外层页面（auth/settings/dashboard/view），改善 SEO 与首屏。
4. **契约先行**：任何跨栈调用都落在可校验产物（S1/S2/S3 → api-types）上，不靠读源码手抄。
5. **每阶段可上线**：每个路由组迁移后即可与旧前端并行发布，避免长期无产出。
6. **Rust 强化性能关键路径**：渲染/导出/存储/Worker 优先，核心业务 RPC 最后。

### 3.3 目标目录结构

```
penpot/
├── frontend/          (ClojureScript, 保留, 逐路由绞杀)
├── frontend-nextjs/   (新 Next.js 前端) —— 本轮已建脚手架 ✅
│   ├── app/           App Router 路由树(auth/settings/dashboard/view/workspace)
│   ├── lib/           rpc/transit/errors/config/routes/types
│   ├── components/    外壳共享组件
│   ├── packages/api-types/  生成的 RPC 类型(占位)
│   └── next.config.mjs      /api、/assets 反代到 backend:6060
├── backend/           (Clojure, 保留；阶段 B 全程只读参照，不改一行)
├── backend-rust/      (新 Rust+axum 后端) —— 计划已批准（PLAN.md/HANDOFF.md），实现但不接入部署
│   └── crates/        transit / errors / config / session / db / storage / worker / ws / rpc
├── common/            (CLJC 共享, 保留)
├── render-wasm/       (Rust→WASM, 保留, 前后端共用)
├── exporter/  media-processor/  mcp/  plugins/  library/  docs/   (保留)
└── api/               (契约产物, S1/S2/S3 生成后落地) —— 未建 ⬜
```

与早期修订的差异：不再引入顶层 `apps/`、`packages/`、`tools/` 与根 `Cargo.toml`。新前端自成一个
pnpm 工作区（`frontend-nextjs/`，`storeDir: ../.pnpm-store`），新后端自成一个 Cargo 工作区
（`backend-rust/`），两者都与既有模块隔离，避免改动整仓 CI 行为。
---

## 4. 阶段计划

### 阶段 F：frontend-nextjs（前端优先，进行中）

目标：用 Next.js 外壳逐路由替换 CLJS 前端，后端 API 保持不变。

技术选型（依据真实结构更正）：

| 类别 | 选型 | 理由 |
| --- | --- | --- |
| 框架 | Next.js 15（App Router）+ React 19 | 仓库前端已用 React 19.3.0；SSR/首屏/SEO |
| UI | 复用 `@penpot/ui` + 移植 `ds/*.scss` 令牌 | 已有本地 React DS，避免引入 shadcn/Tailwind 造成体验割裂 |
| 数据 | `lib/rpc.ts`（Transit）+ TanStack Query（可选） | 复用既有 RPC 协议；服务端缓存按需引入 |
| 状态 | Zustand（按需） | 替代 Potok 事件流的轻量方案 |
| 国际化 | next-intl + 复用 `frontend/translations` | 已有 PO 翻译资产 |
| 表单 | react-hook-form + zod | 对应 Malli schema |
| 测试 | Vitest + Playwright | 复用仓库既有 Playwright |

开发任务分解（每个路由组 = 一个可上线增量）：

- **F0 脚手架（本轮已完成）**：目录、`lib/rpc.ts` 传输层、路由注册表、登录页 P0 样板、反代配置。
- **F1 契约与会话基础**：
  - F1.1 移植 Transit handler（uuid/instant/关键字命名空间），保证 file/change 等复杂值往返一致；
  - F1.2 `api-types` 生成器：以 S1 的 RPC 清单为输入生成 `RpcParamsMap`/`RpcResultMap`，替换
    `lib/types.ts` 手写切片；
  - F1.3 URL 兼容层：`?screen=<name>` 与 `#/<path>` → App Router 路径；
  - F1.4 会话引导：cookie `auth-token` + `get-profile`，未登录跳 `/auth/login`，已登录进 `/dashboard/recent`。
- **F2 设计系统基线**：把 `frontend/src/app/main/ui/ds` 的 colors/spacing/typography/elevations/
  z-index/borders/sizes 令牌移植为 CSS 变量；接入 `@penpot/ui` 的 menu/modal。
- **F3 auth**：login（样板已通）→ register/register-validate/register-success → recovery-request/
  recovery → verify-token。命令：`login-with-password`、`create-profile`、`request-profile-recovery`、
  `update-profile-password` 等。
- **F4 settings（本轮已完成）**：profile/password/notifications/options/feedback 已移植（shortcuts 占位后随 F5.6 补齐），
  subscription/integrations 未建路由（`settingsNav` 已按 flag 门控留位）。命令：`update-profile`、
  `update-profile-password`、`update-profile-notifications`、`update-profile-props`、`update-profile-photo`、
  `delete-profile-photo`、`request-email-change`、`delete-profile`、`send-user-feedback`。详见 7.6。
- **F5 dashboard（切片进行中）**：11 个路由、约 7000 行 CLJS UI（`ui/dashboard*`）加 843 行
  `data/dashboard.cljs`、753 行 `data/team.cljs`，一次做完不现实，切成七片：
  - **F5.1 外壳与数据基座**：team 解析（`?team-id=` → last-team-id → default-team-id）、
    `get-teams`/`get-team`/`get-projects`/`get-team-recent-files`、dashboard context、
    `app/dashboard/layout.tsx`（AuthGuard + 侧边栏 + 内容槽）、侧边栏（搜索、projects/drafts、
    sources、pinned 与全部项目、新建项目）、`profile-section`（F4 遗留项）、
    `/dashboard/recent` 的项目分区与文件卡片。
  - **F5.2 完整网格（完成）**：`grid.cljs` 移植——多选、右键菜单、重命名/复制/移动/删除、
    `layout-toggle`、`inline-edition`、`check-updates`、`/dashboard/files`。两处修正：
    CLJS 并无「设为封面」功能（原规划笔误，已删）；缩略图本轮只经 `resolve-media` 展示
    既有 media，media-worker 客户端生成随 workspace 移到 F9 规模。
  - **F5.3 libraries / deleted / search（完成）**：`/dashboard/libraries`（摘要卡）、
    `/dashboard/deleted`（SSE 批量恢复/彻底删除 + 进度组件 + 项目级菜单 + 页签）、
    `/dashboard/search`（三态占位 + 只读结果网格）；随附 SSE 传输层
    （`parseSseBlocks`/`drainSse`/`cmdSse`）与 `lib/progress.ts` 进度状态机。
  - **F5.4 fonts（完成）**：`/dashboard/fonts`（上传队列 + 已安装字体表：TTF/OTF/WOFF 元数据解析与高度告警、10 MiB 分块上传、字体族/字重合组、重命名/删除/下载、搜索）、`/dashboard/fonts/providers`（页头占位，同 CLJS）；随附分块上传层（`lib/uploads.ts`）与自定义字体 @font-face 注册表；补回 F5.3 推迟的 typography 样本字体加载。
  - **F5.5 团队管理（完成）**：`/dashboard/members`（成员表：角色变更、移出、三种离开流程）、
    `/dashboard/invitations`（邀请表：排序、勾选工具栏、角色、复制链接、重发/删除）、
    `/dashboard/webhooks`（列表与空态 hero、新建/编辑弹窗、无权限占位）、`/dashboard/settings`
    （团队照片、资料块、owner 行、成员/项目计数）；随附 team-hero（recent 页横幅）、
    team-form（新建/改名）、change-owner 与 no-permission 弹窗。
  - **F5.6 templates / binfile / 快捷键（完成）**：templates 抽屉（recent/files 页内建模板与
    库链接）、binfile 导出/导入（files 页导出弹窗、项目菜单/OS 拖入/空项目卡导入流）、
    dashboard 快捷键注册表（补齐 settings/shortcuts：三页签 + 录制编辑 + 导入/导出 +
    路由级运行时）。
  - **F5.7（进行中）** organization/team switch（已完成：nitrate/org-switch 无头逻辑、
    leave-organization 全流程与转让弹窗、org/team 两级切换器与侧边栏接线）、
    subscription/nitrate（已完成：订阅无头逻辑、nitrate 激活弹窗、侧边栏/members/团队设置
    的订阅横幅、`/settings/subscriptions` 订阅页与五个对话框、trash 的 90 天保留分支）、
    comments、插件注册、WebSocket `subscribe-team` 实时刷新（依赖 F8）。
- **F6 viewer**：`/view` + `frame-preview` + `render-sprite`；集成 render-wasm 渲染画布（复用
  `app.render_wasm.api` 的加载方式）。切成 F6.1–F6.6 六片：
  - **F6.1 数据层（完成）**：`lib/viewer.ts`（feature 门控、bundle 拉取与 pointer
    两趟解析、`fdata` objects-map 解码、帧读取与 z-index 排序、分页构建、URL 查询
    解析、帧选择钳制、zoom 数学、`viewerHref`）；随附两个传输层缺陷修复（rpc 集合
    查询参数、transit objects-map 缓存隔离）。
  - **F6.2 外壳（完成）**：`app/view/page.tsx`（bundle 加载状态机、帧导航与 URL
    双向镜像、fit/fill zoom、全屏、thumbnails 开关、`window.name` 会话命名）、
    `viewer-header.tsx`、`viewer-pagination.tsx`、`viewer-icons.tsx`、
    `styles/viewer.css`。
  - **F6.3 导航与缩放交互（完成）**：thumbnails 面板（展开/收起、左右步进、
    缩略图导航）、viewer 快捷键注册表（13 条）、滚轮 zoom（mod+wheel）。
  - **F6.4 WASM 渲染（完成）**：render-wasm 加载桥（bridge/packages/interop）、
    原始 transit 交给编译解码器（cmdRaw + values）、快照渲染 viewport
    （viewer-wasm-viewport）、带 padding 的 bounds（calculate-size over
    gsb/object-bounds）、path-data reader、position pass、thumbnails 位图
    （frame-render 重建 render-to-canvas）。
  - **F6.5 interactions（完成）**：hotspots 命中层（SVG rect 命中、pointer 事件与
    after-delay）、flows/interactions 菜单（含 show-interactions 的 500 ms flash）、
    overlay 开合与 go-to-frame/overlay 的 WAAPI 动画（六片，`a00e36adae`–
    `dd072bd0bb`）。
  - **F6.6 收尾（完成）**：`frame-preview` 路由（跨窗口 `window.load` 协议、
    尺寸与 zoom 滑块）、not-found 异常页（error-container、request-access
    流程）；`render-sprite` 不做（CLJS 注册了但无渲染消费者）。
- **F7 插件**：复用 SES 运行时与 Plugin API（`app.plugins`），保持 `plugins → mcp`（WS :4402）连线。
  完整 Plugin API 上下文强依赖 workspace 状态（`app.plugins.api/create-context` 全部从
  `@st/state` 读取），故切成 F7.1–F7.4 四片：
  - **F7.1 数据层（完成）**：`lib/plugins.ts`（manifest 解析与校验、注册表与订阅、
    in-flight 追踪、install/remove 乐观更新与回滚、fetch-manifest、权限 peek）与
    `lib/plugin-flags.ts`。
  - **F7.2 安装与管理 UI（完成）**：`lib/config.ts` 增 `pluginsListUri`/`pluginsWhitelist`；
    `components/plugins.tsx`（权限弹窗 + try-out 弹窗）、`components/plugin-management.tsx`
    （URL 安装 + Remove 确认的插件管理列表）、`components/plugin-install-flow.tsx`
    （dashboard `?plugin=` 安装流，挂 `app/dashboard/layout.tsx`）。CLJS 入口在
    workspace 主菜单（`main_menu.cljs` plugins-menu*）与 top_toolbar；shell 无
    workspace，暂挂 dashboard profile 菜单（F9 后迁回），列表行 Open 按钮同缺
    （等 F7.3 运行时）。
  - **F7.3 运行时接入（完成）**：SES boot（`initPluginsRuntime`）与 `ɵloadPlugin`/`ɵunloadPlugin`
    桥、最小 Context（theme/flags/事件；workspace 相关 API 暂缺）。
  - **F7.4 完整 API 上下文（完成）**：`lib/plugin-shape.ts`、`lib/plugin-workspace.ts`
    的 shape/file/page/viewport/history 代理与 selection 读写；写路径经
    `lib/workspace-bridge.ts` 落到画布命令（创建/对齐/分布/撤销块/视口），页面
    切换经 `lib/workspace-navigation.ts`；`plugin-context` 派发 finish/filechange/
    pagechange/selectionchange/shapechange/contentsave（见 7.44）。
    shape 删除/克隆/结构、文本/SVG/路径、媒体、代码生成、字体/库/用户、评论/
    令牌/版本/导出、flow 与 ruler guide 写入仍以命名错误失败，等对应切片。
- **F8 WebSocket 协作客户端**：连 `/ws/notifications`（直连后端源），订阅文件变更广播。
- **F9 workspace**：最后迁移、最高风险。切成 F9.1–F9.x 多片：F9.1 数据基础与只读画布
  已启动（原为解 F7.4 阻塞而提前，不依赖 F8；数据层 + 视口数学 + WASM 直绘 + /workspace
  路由，见 7.23）；F9.2 画布交互与选择完成（悬停/点选/框选/平移 + SVG 覆盖层，零
  写入，见 7.24）；F9.3 拖动移动与保存完成（首个写路径：预览、update-file、重父级，
  见 7.25）；F9.4 外壳与菜单完成（三栏、左头重命名、主菜单、缩放、Layers、工具栏、
  帧标题，见 7.27）；F9.5 绘制工具与样式面板完成（frame/rect/ellipse 绘制、右栏基础
  样式段，见 7.29；文本与图片、自由手绘路径随后补齐，见 7.45）；F9.6 resize/rotate
  手柄完成（八手柄 + 四旋转区、修饰键、一次
  提交，见 7.30）；F9.7 撤销/重做完成（客户端栈、自动反向、Ctrl/Cmd+Z 与菜单，
  见 7.31）；F9.8 z-order 插入完成（四条命令、index 全链路、撤销保真，见 7.32）；
  F9.3 伴随变更完成（hide-in-viewer、layout-item 清理、组件元数据同步、flex sizing，
  见 7.33）；drop-index 完成（flex 插入/重排、绘制插入、mov index，见 7.34）；
  F9.9 样式面板扩展完成（尺寸/位置/旋转、阴影/模糊、布局/布局项/约束、多选批量，
  见 7.36–7.37）；F9.10 子级传播与约束完成（resize 按 constraints-h/v 重排直接
  子级、rotate 刚性带动子树、面板改动同样传播，见 7.38）；F9.11 布局 reflow 完成
  （约束与重排统一走 wasm 的 propagate，布局属性编辑后自动重排子级，见 7.39）；
  F9.12 grid cells 编辑入口完成（面板的 Grid cell 段、cell map 的分区维护、
  transit 的 uuid/keyword 编码，见 7.40）；
  余下补浏览器冒烟；F7.4 已完成（见 7.44）；
  Web Worker
  （缩略图/索引/导入）+ 协作光标 + 其余绘制（线条/箭头/笔工具）/布尔/编辑/token
  子流程仍在 F3–F8 验证后推进。

每个路由组的完成标准（DoD）：

1. 页面在 `frontend-nextjs` 下可渲染并通过 `pnpm typecheck` / `pnpm build`；
2. 经 `lib/rpc.ts` 打通该页所需命令（参数/响应类型来自 api-types，或明确标注为手写切片）；
3. 与旧 CLJS 页面功能对等（关键交互清单逐项核对）；
4. Playwright 覆盖新路径；
5. 不改动 `backend/`（如需新服务端行为，登记到阶段 B，不在 F 内做）。

### 阶段 B：backend-rust（Rust + axum，计划已批准，不接入部署）

**门禁（2026-10-16 改口径）**：可以写实现与测试、可以本地 `cargo run`；**不**接 nginx/反代、**不**加命令级
灰度开关、**不**改 `docker/`、**不**改 `scripts/ci` 现有 target。`backend/` 保持只读参照。执行计划
（M0–M8、已核对契约事实、风险、红线）在 `backend-rust/PLAN.md`，换机器上下文快照在
`backend-rust/HANDOFF.md`。

顺序：`M0 workspace → M1 transit（关键路径）→ M2 errors+config ∥ M3 rpc(axum) → M4 session →
M5 storage → M6 worker → M7 ws`。`transit` 先做的理由：RPC 请求体、应答体、`task.props`、session payload
**全是 transit**，它不对后面全错。

- M1 `transit`：自建 enum 值模型；`^ ` map 头与 `^N` 缓存；`~u/~m/~n/~:`/`~b`；`~#list` 与裸数组不对称；
  `~#penpot/objects-map/v2` 嵌套 reader 隔离缓存；`~#penpot/path-data` 二进制。
- M3 `rpc`：三组路由（`/api/main/methods/:name`、别名 `/api/rpc/command/:name`、
  `/api/management/methods/:name` + shared-key）；GET 只允许 `get-` 前缀；`nil` → 204；
  10 层中间件同序复刻。
- M4 `session`：JWE `a256kw`+`a256gcm`，payload = transit，key =
  `HKDF(HMAC-BLAKE2b-512, salt="tokens", 32B)`；会话状态在 **`http_session_v2`**（旧 `http_session` 已由
  迁移 `0155` 删除）。兼容性验证需真 token 向量（`PLAN.md` §10 C1）。
- M5 `storage`：对齐 `backend/src/app/storage`（`storage_object` 闭包 metadata、11 canonical bucket、
  hash 去重、`status/deletion_attempts`、`:fs`/`:s3` + 遗留别名）。
- M6 `worker`：`task.props` = jsonb transit；`FOR UPDATE SKIP LOCKED` + `tenant:queue` + Quartz 6 段 cron；
  17 任务 / 10 条 cron。
- M7 `ws`：axum WebSocket + msgbus（`profile-id`/`file-id`/team topics/`uuid/zero` 系统 topic）。

永久排除（`file.data` blob = Fressian v4/v5，JVM 专有，Rust 无实现）：`add-file-transient-changes`、
binfile 导入导出、files 写路径、thumbnails 生成、nitrate（`mgmt:nitrate` 31 + `nitrate` 13 命令）。
这些永久留在 Clojure 侧。

---

## 5. 里程碑（前端优先）

```
阶段 F  █████████████████████████████░░░░░░░░░░░░░░░░  (F0–F4 已完成；F5.7 大半、F6 全部完成：F6.1–F6.6；F7.1–F7.3 完成；F9.1–F9.11、F9.3 伴随变更、drop-index、F9.10 子级传播、F9.11 布局 reflow 与 F9.12 grid cells 入口完成：只读画布、交互选择、拖动保存、外壳与菜单、绘制与样式面板、缩放手柄、撤销/重做、z-order、伴随变更、布局内插入与重排、布局/约束段与多选批量、resize 约束传播、布局重排走 wasm 传播)
        F0 脚手架 | F1 契约/会话 | F2 设计系统 | F3 auth | F4 settings | F5 dashboard
        | F6 viewer | F7 plugins | F8 ws | F9 workspace
阶段 B  ▒▒░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  计划已批准（不接入部署）；M0/M1 待开工
        M0 workspace | M1 transit | M2 errors+config | M3 rpc(axum) | M4 session | M5 storage | M6 worker | M7 ws
支撑    ▒▒▒▒▒▒▒▒  S1 RPC 清单 → F1.2 ; S2 OpenAPI ⛔ ; S3 DB schema → B5/B6 ; S4 transit 金样本 → B1 ; S5 JWE 向量 ⛔
图例： █ 进行中/完成　▒ 可并行　░ 未开始
```

---

## 6. 风险矩阵（精简）

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| 两套前端体验割裂 | 中 | 中 | 复用 `@penpot/ui` + 移植 ds 令牌，统一设计系统（F2） |
| Transit 复杂值往返不一致 | 中 | 严重 | F1.1 完整移植 handler；对 file/change 做往返测试 |
| 响应类型覆盖不足 | 高 | 中 | S1/F1.2 生成 api-types；缺 `::sm/result` 的命令先标手写类型 |
| 会话吊销在两栈不一致 | 中 | 严重 | 前端只复用 cookie 会话；后端侧统一由网关代查 `http_session_v2`（B4） |
| workspace 迁移复杂度 | 高 | 严重 | 放到 F9 最后，前置 F3–F8 验证；必要时长期保留 CLJS workspace |
| Rust 与 WASM 渲染差异 | 中 | 中 | render-native 已暂缓；将来开工时像素级对比 + CI 金丝雀 |
| 契约工具需 JVM/GitHub | 中 | 中 | S2/S3/S5 解锁条件见 §8；S1/S4 走静态扫描/离线预言机不依赖运行时 |
| file data blob = **Fressian v4/v5**（JVM 专有，无 Rust 实现） | 高 | 严重 | 阶段 B 不读写 `file.data`/`file_data.data`；写路径与领域核心永久留在 Clojure（见 B8 排除清单） |
| Transit 缓存（`^N`）语义移植不全 → 大应答解码错位 | 中 | 严重 | B1 金样本必含缓存用例（照搬 `lib/transit.test.ts` 两条针对性断言） |
| 只写代码、无流量验证 → 缺陷延后暴露 | 高 | 中 | 每里程碑 DoD 必须是可执行测试；需活依赖的测试标 `#[ignore]` + 写清解锁条件 |

---

## 7. 执行记录

### 7.1 本轮（2026-10-02）

- 依据 archify 架构图与真实仓库结构（v2.17.0）重排计划，改用 `frontend-nextjs/` + `backend-rust/`
  目录方案。
- 落地 `frontend-nextjs/` 脚手架（F0）：App Router 路由树、`lib/rpc.ts`（移植 `repo.cljs` 的
  `send!/cmd!`：端点/方法选择/头部/cookie 凭据/GET 重试/类型化错误）、
  `lib/{transit,errors,config,routes,types}.ts`、登录页 P0 端到端样板、`next.config.mjs` 反代、
  独立 pnpm 工作区、`packages/api-types` 占位、README。
- 落地 `backend-rust/README.md`（B0）：仅规划与门禁说明，无实现代码。
- 未改动 `frontend/`、`backend/`、`common/`、根 `package.json`、根 `pnpm-workspace.yaml`
  （绞杀者模式 + 不改整仓 CI）。
- F0.1 已完成：typecheck/build 通过；登录页经 Next 代理（3450）对 docker 后端端到端验证通过。

### 7.2 本轮（2026-10-02，第二批：F1 契约/会话）

- 修复登录不可用（`0e762c96e0`）：transit-js 的 `transit.map()` 忽略变参导致请求体为空 map；
  默认 reader 返回 Transit.Map 导致 `profile.id`、错误码等字段 undefined。改为 `.set()` 构建 +
  mapBuilder/handler 规范化，并用真实账号经 3450 代理端到端验证（登录、带 cookie 的
  get-profile、错误密码返回 `validation/wrong-credentials`）。
- F1.1 完成：`lib/transit.ts` 移植 `common/src/app/common/transit.cljc` 的读取 handler
  （u/m/:/n/duration/uri/ordered-map/ordered-set/set/penpot/pointer），12 项编解码单测通过。
- F1.3 完成：`lib/legacy-routes.ts` + `components/url-compat.tsx`，对照 `ui/routes.cljs` 移植
  legacy `#/` 路由表（含 `:file-id` 路径参数）与 `?screen=` 解析，14 项单测通过。
- F1.4 完成：`lib/session.tsx` + `components/auth-guard.tsx`；根路径引导复刻 on-query-navigate
  空 token 分支（zero-uuid → `/auth/login`，已登录 → `/dashboard/recent`）；dashboard/settings
  布局与 workspace/view 页加守卫；登录页改用 `session.refresh`。
- S1 完成：`packages/api-types/scripts/scan-rpc-inventory.mjs` 静态扫描 backend/src 的
  `sv/defmethod`（只读，不改后端），产出 `rpc-inventory.json`：189 条命令，含
  ns/文件/行号/auth/docstring/added 与 params/result schema 引用。
- 验证：`pnpm typecheck` + `pnpm build` 通过（路由全部预渲染）；实测匿名 get-profile 返回
  zero-uuid（守卫判定依据）。
- 未改动 `frontend/`、`backend/`、`common/`、docker-compose 栈。
- 下一步：F1.2（malli schema → TS 类型生成器，输入已就绪）、F3 auth 路由组
  （register/recovery/verify-token）。

### 7.3 本轮（2026-10-02，第三批：F1.2 契约类型生成）

- F1.2 完成：`packages/api-types/scripts/generate-types.mjs` 以 S1 清单为输入，静态解析
  `backend/src` + `common/src` 的 malli schema（Clojure 形式读取器 + ns 别名/`:as-alias`/
  `:refer`（含逗号）/别名限定符号解析、`register!` 与 `(-> (reduce mu/union …))` 展开、
  `:=` 等值类型、参数化 `::sm/set`/`::sm/one-of`、几何/颜色等 register! 类型精确映射），
  生成 `src/index.ts`：186 条命令（按名去重，公共 API 优先），params 184 条、results 51 条。
- 残余 8 类未解析引用全部为 file-data 域动态 schema（path content、changes set-*-change、
  tokens-lib、profile props-writeable），按门禁留给 F5/F6/F9；生成器会持续报告。
- 接线：`frontend-nextjs` 增加 `@penpot/api-types` workspace 依赖 + `transpilePackages`；
  `lib/types.ts` 的 `Profile`/`LoginWithPasswordParams` 切换为生成类型
  （`RpcResults["get-profile"]`/`RpcParams["login-with-password"]`）。
- 修复 `pnpm-workspace.yaml` 中 pnpm 自动写入的 `allowBuilds` 占位文本（unrs-resolver: true），
  否则 `pnpm install` 直接失败。
- 验证：`pnpm install` / `pnpm typecheck` / `pnpm build` 全部通过。
- 下一步：F2 设计系统基线（ds 令牌 → CSS 变量）、F3 auth 路由组（register/recovery/verify-token）。

### 7.4 本轮（2026-10-02，第四批：F2 设计令牌基线）

- F2（令牌部分）完成：`frontend/src/app/main/ui/ds/*.scss` 全量移植为
  `frontend-nextjs/styles/tokens.css`——原始调色板（--pp-*）、light/default 双主题语义色
  （--color-*，与 :global(.light)/:global(.default) 块一一对应，px2rem 与 color.change
  已预解析）、spacing/borders/sizes/z-index/elevations/typography 变量。
- `app/globals.css`：@font-face 对齐 `dependencies/fonts.scss`（worksans/vazirmatn 可变字体 +
  robotomono，含 unicode-range）；`use-typography` 的 11 个 mixin 移植为 `.pp-typ-*` 工具类；
  基础元素样式全部 token 化。字体资产（3 个 ttf，约 692KB）复制到 `public/fonts/`。
- `app/layout.tsx` 的 `<html>` 挂 `light` 主题类；profile.theme 驱动切换随 F4 settings 落地。
- `@penpot/ui`（menu/modal）接线推迟：该包是 React + react-aria-components + SCSS modules，
  exports 指向未构建的 `dist/`，且 shell 尚无页面消费 menu/modal；随 F4/F5 首个消费页
  一并落地（link: 依赖 + alias 到 src 或构建 dist，二选一）。
- 验证：`pnpm typecheck` + `pnpm build` 通过；产物 CSS 确认包含令牌。

### 7.5 本轮（2026-10-02，第五批：F3 auth 路由组）

- F3 完成：`app/auth/*` 七个路由全部从 CLJS 移植——login、register、
  register/validate、register/success、recovery/request、recovery、verify-token，
  外加 `app/auth/layout.tsx`（对应 `app.main.ui.auth/auth*`：logo、注册插图、
  `?error=` 的 OIDC 重定向横幅、注册页专属条款页脚、html title）。
- 命令链路（后端未改动）：`login-with-password`、`prepare-register-profile` →
  `register-profile`、`request-profile-recovery`、`recover-profile`、`verify-token`、
  `create-demo-profile`、`get-profile`。`lib/auth.ts` 封装命令并把 CLJS 的错误分支
  逐条映射到字段错误或 toast；`verify-token` 的 `handle-token` 多方法与错误分支抽成
  纯函数 `classifyVerifyToken` / `classifyVerifyTokenError`，登录后的跳转（邀请 token
  → login-redirect → dashboard）抽成 `postLoginTarget`，团队 id 解析留给 F5。
- 公共件（后续每个路由组都要用，随 auth 一起落地）：
  - 词条：`scripts/extract-translations.mjs` 扫描 `tr("k")` 与 `<Tr k="k">` 调用点，
    从 `frontend/translations/en.po` 生成 `lib/translations/en.ts`（本轮 77 条），
    缺 key 直接失败；后端在 `:details` 里回传的动态 key 登记在 `runtimeKeys`。
    `[label](url)` 由 `components/tr.tsx` 解析成真链接，不用 dangerouslySetInnerHTML。
  - 表单：`lib/forms.ts`（无头）+ `components/form.tsx`（视图），校验规则与文案对齐
    CLJS 表单声明的 malli schema 与 `common/src/app/common/schema/messages.cljc`；
    与 `fm/submit-button*` 一致，表单不合法时提交按钮禁用。
  - 通知：`components/notifications.tsx` 复刻 `app.main.data.notifications`
    （单条通知槽、success/info/warning 7s 自动消失、error 常驻、路由切换即隐藏）。
  - 存储：`lib/storage.ts` 复刻 `app.util.storage` 的键布局（`<prefix>:<ns>/<name>`）
    与 transit 值编码，承载 login-redirect 与注册邮箱回传。
  - 配置：`lib/config.ts` 补 `parseFlags`（`enable-x`/`disable-x` 叠加在
    `common/src/app/common/flags.cljc` 默认集之上）与条款/隐私链接，修掉
    「flags 为空导致 auth 页面什么都不渲染」的隐患。
- 样式：`styles/auth.css`（auth.scss + auth/common.scss + register.scss 的移植，
  SCSS module 类名 1:1 改成普通类）与 `styles/forms.css`（ds input/button 的临时替身，
  `@penpot/ui` 接线后退场）。字体与图片资产复制到 `public/fonts`、`public/images`。
- 测试：引入 vitest（`pnpm test`，91 例），覆盖 i18n 格式化与链接解析、表单校验、
  auth 错误映射、verify-token 派发、flags 解析、legacy URL 解析器（F1.3 此前只有
  临时验证，这次入库）。为让无头逻辑跑在 node 环境，`lib/i18n.tsx`/`lib/forms.tsx`
  拆成 `lib/*.ts`（逻辑）+ `components/*.tsx`（视图）。
- 端到端验证（docker 后端 2.18 + Next dev 反代 :3451）：匿名 `get-profile` 返回
  zero-uuid；`login-with-password` 200 且随后 `get-profile` 已认证；`verify-token`
  传坏 token 返回 `400 {type: validation, cause: signature}` → 落到 invalid-token
  卡片；`request-profile-recovery` 对存在与不存在的地址都返回 204（不泄露账号）；
  `prepare-register-profile` → `register-profile` 返回 `is-active: true` 且会话已建立；
  `recover-profile` 坏 token 同样 400。七个页面 HTTP 200，HTML 含正确词条与令牌类名。
- 有意未做：SSO 按钮（`sso-buttons*` + `login-with-oidc` + `get-sso-provider`）与
  `login-with-ldap`，两者都需要 OIDC/LDAP 配置项，另立任务；因此登录页的密码字段在
  本外壳里是必填（CLJS 里为了 SSO 优先流程才标 optional）。
- 验证：`pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm test` 全部通过。
- 下一步：F4 settings 路由组（profile/password/feedback/options/notifications/
  shortcuts），并在那里接入 `@penpot/ui` 的 menu/modal 与 profile 驱动的主题切换。

### 7.6 本轮（2026-10-02，第六批：F4 settings 路由组）

- F4 完成：`app/settings/*` 六个路由从 CLJS 移植——profile、password、notifications、
  options、feedback、shortcuts（占位），外加 `app/settings/layout.tsx`（AuthGuard +
  侧边栏 + 「你的账户」页头，对应 `app.main.ui.settings/settings*`）。
- 命令链路（后端未改动）：`update-profile`、`update-profile-password`、
  `update-profile-notifications`、`update-profile-props`、`update-profile-photo`、
  `delete-profile-photo`、`request-email-change`、`delete-profile`、`send-user-feedback`、
  `get-profile`。`lib/settings.ts` 承载无头逻辑：主题解析、语言清单、参数映射
  （`profileUpdateParams`/`passwordParams`）、错误分类（`passwordError`/`feedbackError`）、
  按 flag 门控的侧边栏清单（`settingsNav`）与命令封装；`app/settings/*` 只是视图。
- 新增公共件（后续路由组共用）：
  - `cmdUpload`（`lib/rpc.ts`）：repo.cljs `multipart-upload` 的移植。Blob 字段转成
    FormData 分片，请求**不设** `content-type`（boundary 交给浏览器生成），响应仍按
    Transit 解码。首个用例是头像上传。
  - 弹窗：`components/modal.tsx` 的 `ModalProvider`/`useModal`/`ModalShell`/`ConfirmDialog`
    对应 `app.main.data.modal` 的单槽 modal；Provider 挂在根布局，所以任何页面打开的弹窗
    都渲染在同一处。改邮箱与删号弹窗分别是 `components/change-email-modal.tsx`、
    `components/delete-account-modal.tsx`。
  - 主题：`components/theme.tsx` 复刻 `app.util.theme/activate-theme`，把
    `resolveTheme(profile.theme, 系统偏好)` 写成 `<html>` 的 class（暗色 = `default`，
    正是 `styles/tokens.css` 里语义色令牌的作用域）。F2 的令牌到这里才真正被切换。
  - 头像：`lib/avatars.ts` 用 canvas 生成首字母头像（仅客户端），对应
    `resolve-profile-photo-url` 在没有存储照片时的回退。
  - 表单：`lib/forms.ts` 补 `select`/`radio`/`textarea` 与 `oneOf` 成员校验
    （`::sm/one-of`），`components/form.tsx` 补 `Select`/`RadioGroup`/`Textarea`。
    `cleanValues` 对 select/radio 保留空串——「Auto (browser)」语言项的值就是 `""`，
    丢掉它等于丢掉一个合法选择。成员校验先于长度校验，与 malli 的报错优先级一致。
- 修掉一个会让标签渲染成裸 key 的缺陷：`settingsNav` 把词条 key 放在 `labelKey` 数据字段
  里、视图再 `tr(item.labelKey)`，而抽取脚本只扫 `tr("...")` 字面量，于是
  `labels.password`、`labels.notifications`、`label.shortcuts` 没进目录，侧边栏直接显示
  key 本身。`scripts/extract-translations.mjs` 增加 `trFieldRe` 扫 `labelKey:`，词条从
  169 条增至 174 条，并加一例「每个 labelKey 都能解析」的回归测试守住它。
- 修掉一个 dev 下头像必坏图的问题：存储后端为 `fs` 时，后端对 `/assets/*` 返回空 204 +
  `x-accel-redirect`（`serve-object-from-fs`），只有 nginx 那个 `internal` 的
  `/internal/assets` location 会把它换成文件，Next rewrite 不认识这个头。
  `next.config.mjs` 把 `/assets` 的反代目标拆成 `PENPOT_ASSETS_ORIGIN`（默认仍等于后端
  源，行为不变），dev 指向 compose 里的 frontend nginx（`http://localhost:9001`）即可拿到
  真字节；生产由既有 nginx 前置，无需设置。
- 测试：vitest 137 例（新增 `lib/settings.test.ts` 覆盖主题解析、语言清单、通知默认值与
  profile 回读、参数映射、password/feedback 错误分类、侧边栏 flag 门控；`lib/forms.test.ts`
  补 select/radio/textarea 校验与 cleanValues 分支）。
- 端到端验证（docker 后端 2.18 + Next dev `:3451`，全程用一次性账号，不动既有资料）：
  - headless Chrome 逐页 dump DOM：六个 settings 路由都渲染出正确的 html title、表单控件、
    侧边栏与身份块；匿名访问 `/` 与 `/settings/profile` 都跳登录页。
  - CDP 驱动 20 项断言：options 的 lang/theme select 回显 profile 存储值；`<html>` 的 class
    随 theme 在 `light`/`default` 间切换；在 UI 里改主题并提交后 `<html>` 与后端同时更新、
    未改动时提交按钮禁用；notifications 三组单选往返一致；profile 的 fullname/email 回显、
    侧边栏标签已翻译；password 三个字段初始为空且提交禁用；feedback 的 type 预选 idea。
  - 头像 13 项断言：无照片时是生成的 data URL 且删除按钮隐藏；经真实 file input 上传
    64×64 PNG 后后端存下 `photo-id`，页面与侧边栏都换成 `assets/by-id/<id>`，`<img>`
    实际解码出 256×256（后端缩略图尺寸），资源 HTTP 200 `image/jpeg`；点删除弹出
    ConfirmDialog，确认后后端清空、界面回退到生成头像、弹窗关闭。
- 有意未做（README 与代码注释均已登记）：
  - shortcuts 仍是 `RouteStub`：它要读 workspace/viewer/dashboard/path 四套快捷键注册表，
    那些随 F5（dashboard）与 F9（workspace）才到位；导航项因 `:custom-shortcuts` 默认开而可见。
  - subscription、integrations 两个路由未建：分别要支付与 access-token/MCP 基础设施，
    `settingsNav` 已按 `:subscriptions`/`:admin-console`/`:access-tokens`/`:mcp` 门控留位。
  - 侧边栏的 release-notes 项与 `profile-section*`（团队切换、评论、版本号、退出菜单）属于
    dashboard store，随 F5 落地；当前只渲染身份块加一个直接退出。
  - 改邮箱与删号弹窗的「多组织」分支（`:admin-console`）未做，本机该 flag 关着。
  - `@penpot/ui` 仍未接线，settings 视图用 `styles/settings.css` 的临时样式。
- 一处与 CLJS 的有意偏差：feedback 的 type 预选 `idea`，CLJS 起始为空——原生 `<select>`
  不额外加一个空 option 就没法显示空白行。
- 验证：`pnpm typecheck`、`pnpm lint`、`pnpm build`（20 个路由全部预渲染）、`pnpm test`
  全部通过。
- 下一步：F5 dashboard 路由组（recent/files/libraries/fonts/members/invitations/webhooks/
  search/deleted），一并接入 `@penpot/ui` 的 menu/modal，补齐 settings 侧边栏缺的团队切换
  与 profile-section，并把 shortcuts 的 dashboard 那一套注册表接上。

### 7.7 阶段 B

计划已批准（见 §7.26），实现尚未开始。执行计划：`backend-rust/PLAN.md`；上下文快照：
`backend-rust/HANDOFF.md`。门禁口径从「不实现」改为「**实现但不接入部署**」。

### 7.8 本轮（2026-10-03，第七批：F5.1 dashboard 外壳与数据基座）

- F5.1 完成：dashboard 外壳与数据基座落地，`/dashboard/*` 十一个路由全部挂在
  `app/dashboard/layout.tsx`（AuthGuard + DashboardProvider + 侧边栏 + 内容槽，对应
  `app.main.ui.cljs/team-container*` 与 `dashboard*`）下。`/dashboard/recent` 从 CLJS
  移植（`projects-section*`/`project-item*`/`header*`）；其余十个路由先建 `RouteStub`
  占位页，按 F5.2–F5.5 逐片替换。
- 数据基座（后端未改动）：`lib/dashboard.ts` 承载无头逻辑——team 解析
  （`?team-id=` → last-team-id → default-team-id → 首个 team）、项目/文件的派生选择
  （`visibleProjects`/`pinnedProjects`/`recentFilesOf`/`defaultProject`/`canEdit`）、
  section↔pathname 映射、`dashboardHref`/`workspaceHref` 构造、`timeAgo`
  （date-fns v4 `formatDistanceToNowStrict` 的 en-US 逐字移植，含 DST 归一化与
  「12 个月折成 1 年」规则）、唯一名生成（`generateUniqueName`/`usedNames`）、
  `fileFeatures`（剥离 `frontend-only-features`）与命令封装；`lib/dashboard-context.tsx`
  的 `DashboardProvider` 复刻 `initialize-team`→`dd/initialize` 链（get-teams → 解析
  teamId → `router.replace` 补全 `?team-id=` → 写 last-team-id → get-projects +
  get-team-recent-files），对外暴露 `useDashboard()`。
- 视图：`components/dashboard-sidebar.tsx`（搜索 500ms 防抖、projects/drafts、sources、
  pinned 项目带取消置顶）与 `components/dashboard-profile-menu.tsx`（`profile-section*`
  移植：账户、help/community 子菜单、about+版本号、退出；F4 遗留项到此补齐）。
- 命令链路（后端未改动）：`get-teams`、`get-team`、`get-projects`、
  `get-team-recent-files`、`get-project-files`、`create-project`、`rename-project`、
  `update-project-pin`、`delete-project`、`create-file`、`search-files`。
- 修掉一个会让整个 dashboard 空白的缺陷：后端把**所有 vector 应答**包成 Transit
  `~#list` 标签，而 `lib/transit.ts` 只登记了 set/ordered-* 处理器、没有 `list`，于是
  `get-teams`/`get-projects` 解出来不是 JS 数组（`Array.isArray` 为假 → teams=[] →
  provider 判定无团队）。补上 `list` 处理器（→ 数组），与其它集合归一化一致。这是 F5
  第一条 list 型命令才暴露的根因。
- `update-project-pin` 实测应答 204 空体（不是项目行），命令封装相应改成
  `Promise<void>`，调用方一律 re-fetch 项目列表。
- `create-file` 的 `features` 必须是团队启用集减去 `frontend-only-features`：后端
  `check-client-features!` 会拒绝声明不足的客户端（实测少声明报
  `feature-not-supported`）。`fileFeatures(team)` 供这个集合，实测带它 create-file 200
  且返回体含 `data.pages`（`firstPageId` 据此导航到 workspace 首页）。
- 样式：`styles/dashboard.css`（`dashboard.scss`/`sidebar.scss`/`projects.scss` 与 grid
  度量的移植），全部作用域在 `.pp-dashboard-main`/`.pp-dashboard-sidebar` 下，避免与
  settings 的 `.pp-dashboard` 外壳冲突；`app/globals.css` 增加 `@import`。
- settings 侧边栏「返回 dashboard」链接补上 `?team-id=`（F4 遗留项）：挂载后从
  last-team-id（或 profile 默认团队）读取，因为 localStorage 在 SSR 阶段不可读。
- 测试：vitest 164 例（新增 `lib/dashboard.test.ts` 27 例，覆盖 team 解析优先级、项目
  选择、权限/section 派生、href 构造、`projectsTitleName`、`timeAgo` 各时间桶与未来/
  ISO/无效值、唯一名生成、`fileFeatures` 剥离）。
- 端到端验证（docker 后端 + Next dev `:3451`，全程一次性账号 `f4-shell-check@…`，不动既有
  资料；验证后软删本轮造的项目）：headless Chrome/CDP 驱动 18 项断言——外壳解析出团队并把
  `?team-id=` 写回 URL、侧边栏团队名与分区标签、recent 的 h1（默认团队 = Personal
  Projects）与 document title、项目行含 Drafts、文件卡带 `Last modified … ago` 标题；
  新建项目按钮追加一行「New Project N」；置顶/取消置顶切换侧边栏 pinned 列表；新建文件
  导航到 `/workspace?file-id&page-id`；侧边栏搜索防抖跳 `/dashboard/search` 且保留
  team-id；`/dashboard/files` 占位页在外壳内渲染且 drafts 链接高亮；profile 下拉列出五个
  移植项、「你的账户」跳 `/settings/profile` 且返回链接带 team-id。
- 有意留到后续切片（代码注释与 README 均登记）：完整 `grid.cljs`（media-worker 缩略图、
  多选、右键菜单、拖拽、layout 切换、inline 重命名）→ F5.2，所以文件卡暂是点击即导航的
  普通链接；team hero（邀请成员）→ F5.5；templates 分区 → F5.6；dashboard 快捷键注册表 →
  F5.6；organization/team 切换、subscription/nitrate、comments、插件注册、`subscribe-team`
  实时刷新 → F5.7。`@penpot/ui` 仍未接线，menu/dropdown 用外壳临时样式。
- 与 CLJS 的有意偏差：`create-project` 不进入 inline 重命名（F5.2 才有），保留生成的唯一名；
  `create-file` 的唯一名只在团队 recent files 内计算（后端不强制文件名唯一）；项目行在
  `count>0` 但文件尚未取回时显示 `labels.loading`（CLJS 用专门的 loading 占位）。
- 验证：`pnpm translations`（209 词条）、`pnpm typecheck`、`pnpm lint`（无警告）、
  `pnpm build`（30 个路由全部预渲染，含 11 个 dashboard）、`pnpm test` 全部通过。
- 下一步：F5.2 完整网格（`grid.cljs`：缩略图、多选、右键菜单、重命名/复制/移动/删除、
  layout 切换、inline 编辑）与 `/dashboard/files`。

### 7.9 本轮（2026-10-03，第八批：F5.2 完整网格与 /dashboard/files）

- F5.2 完成：`grid.cljs` 与周边逐件移植。`/dashboard/files` 从占位升级为完整
  `files-section*`（逐项目取 `get-project-files`、按 modified-at 倒序、标题双击 inline
  重命名、新建文件、置顶、项目菜单）；`/dashboard/recent` 升级为完整 `project-item*`
  （layout 切换、项目标题 inline 重命名、`create-project` 进入重命名态、show-all-files、
  LineGrid 跨项目行拖拽移动文件）。
- 组件：`dashboard-grid.tsx`（GridItem 卡片/列表两形态、选中描边、右键与「…」菜单锚点、
  dragstart `penpot/files`、LineGrid 行内 drop、加载/空占位）、`dashboard-menu.tsx`
  （portal 弹出菜单：点/矩形锚点、drilldown 子菜单、视口夹取、外点/Esc/滚动关闭）、
  `file-menu.tsx`（`useFileActions`：重命名、复制（"(copy)" 后缀唯一名）、删除（共享库
  二次确认）、移动（drilldown 列 `get-all-projects`，跨团队共享库先警告）、发布/取消发布
  共享库）、`project-menu.tsx`（复制/移动/删除/置顶/重命名）、`inline-edition.tsx`、
  `layout-toggle.tsx`、`delete-shared-dialog.tsx`、`check-updates.tsx`（最新/有新版/无法
  检查三弹窗）、`modal.tsx` 的 ConfirmDialog 增加 `hideCancel`。
- 无头逻辑：`lib/dashboard.ts` 增加选择集（`toggleFileSelect`，跨项目不合并）、
  `computeGridLayout`（`use-dynamic-grid-item-width` 的度量数学）、`resolveMediaUri`、
  layout 持久化（`penpot-user:app.main.ui.dashboard.layout-toggle/dashboard-layout`，
  写 transit keyword 与 CLJS 互通）、`groupProjectsByTeam`、`copySuffixFn`，及命令封装
  `rename-file`/`delete-file`/`duplicate-file`/`set-file-shared`/`move-files`（数组转
  transit set）/`get-all-projects`/`duplicate-project`/`move-project`/`get-file-summary`/
  `get-library-file-references`；`lib/check-updates.ts`（`check_updates.cljs` 的无头移植，
  fetcher 可注入）；`lib/transit.ts` 增加 `set()` 写入器；`lib/dashboard-context.tsx`
  增加选择与 `editingFileId`；`app/dashboard/layout.tsx` 增加全局 Enter（打开唯一选中
  文件）与内容区点击清空选择；`lib/dom.ts` 的 useDocumentTitle 跳过空串。
- 修掉三个缺陷（均由本轮 CDP 端到端断言暴露）：① 三处菜单锚点在 `setState` 函数式
  更新器里读 `event.currentTarget`——React 在更新器执行前已将其置空，「…」按钮点击抛
  TypeError、菜单永远打不开（改为同步先读元素）；② `LineGrid` 的加载/空分支缺
  `line-grid-<id>` testid，drop 目标不可定位（补齐，与其它分支一致）；③ `lib/config.ts`
  用动态 `process.env[name]` 读环境变量——Next 只内联**静态书写**的
  `process.env.NEXT_PUBLIC_*`，浏览器包里所有 NEXT_PUBLIC 值一直静默落到默认（版本行与
  check-for-updates 入口因此不显示）；补静态引用表 `publicEnv`，服务端仍回退动态读取。
- 与 CLJS 的有意偏差（代码注释均登记）：缩略图只经 `resolve-media` 展示既有 media
  （`thumbnail-id`），media-worker 客户端生成随 workspace 移到 F9 规模；binfile 导出/
  导入（下载、多选导出、导入卡、OS 文件拖入）→ F5.6，当前吞掉 OS drop 防止导航；
  `can-restore`（deleted 视图）与 `grid-item-library*` 摘要卡 → F5.3；拖拽计数元素省略
  （用浏览器默认拖影）；`use-visible` 的 IntersectionObserver 用原生 `loading="lazy"`
  替代；drafts 行无菜单（CLJS 该菜单只剩被推迟的导入项）；遥测与 set-file-shared 后的
  第二次 get-file-summary 刷新省略。核实 `dashboard.copy-suffix` 官方英文即 "(copy)"
  （en.po），复制命名与 CLJS 一致；原规划 F5.2 行的「设为封面」无对应 CLJS 功能，已从
  第 4 节删除。
- 测试：vitest 186 例（新增 22 例：选择集、`computeGridLayout`（1400px → 242px 缩略
  宽）、`copySuffixFn`、`groupProjectsByTeam`、`resolveMediaUri`、`parseDashboardLayout`；
  `lib/check-updates.test.ts` 12 例：版本比较、CHANGES.md 解析、highlights 截断、inline
  markdown 降级）。其中非 http 链接降级断言按 CLJS 实况修正：前缀与原始匹配拆成两个
  `:text` 片段，不合并成一段。
- 端到端验证（docker 后端 + Next dev `:3451`，一次性账号 `f4-shell-check@…`，验证后
  软删本轮数据）：headless Chrome/CDP 35 项断言全过——files 页渲染取回的文件、列表/
  网格切换写入 localStorage 并跨刷新生效、点选/shift 多选/点空白清空、「…」菜单六项
  齐全、inline 重命名（文件与项目标题）落库、复制得 "(copy)"、发布共享库（badge +
  is-shared）与取消发布、移动 drilldown 迁移后跳转目标项目、删除确认弹窗、recent 跨
  项目行拖拽出成功 toast 且落库、profile 菜单版本行与 check-for-updates（拉真实
  CHANGES.md，弹「有新版本」弹窗）。
- 环境备注：`NEXT_PUBLIC_PENPOT_VERSION` 在 dev/build 进程启动时设置才生效（Next 编译
  期内联）；本轮验证以 `2.11.0` 运行。
- 验证：`pnpm translations`（272 词条）、`pnpm typecheck`、`pnpm lint`（无警告）、
  `pnpm build`（30 路由全部预渲染）、`pnpm test`（186 例）全部通过。
- 下一步：F5.3——`/dashboard/libraries`、`/dashboard/deleted`（含 SSE 批量恢复/删除
  进度）与 `/dashboard/search`。

### 7.10 本轮（2026-10-03，第九批：F5.3 libraries / deleted / search）

- F5.3 完成：三个路由从 `RouteStub` 升级为完整页面。`/dashboard/search`
  （`search-page*`：type-something / searching-for / no-matches 三态占位 + 结果网格，
  不传 `can-edit`，菜单只剩「在新标签打开」，卡片不可拖）；`/dashboard/libraries`
  （`libraries-page*`：`get-team-shared-files` 按 team 过滤 + modified-at 倒序，卡片换成
  `grid-item-library*` 摘要卡，无 layout 切换）；`/dashboard/deleted`（`deleted-section*`：
  Recent/Deleted 页签、保留期提示、Restore All / Clear trash、逐项目行、项目级
  恢复/彻底删除菜单；无编辑权限时重定向到 recent，对齐 `dashboard-content*` 的
  `show-deleted?`）。`/dashboard/recent` 补上同一套页签。
- SSE 传输层（`lib/rpc.ts`）：`parseSseBlocks`（纯函数，按 WHATWG EventStream 规则切块，
  多 `data:` 行拼接、注释行丢弃、keep-alive 跳过）+ `drainSse` + `cmdSse`（POST transit、
  消费 `text/event-stream`：`progress` 走回调、`end` 解出返回值、`error` 抛 `RpcError`；
  非 SSE 响应回落到 transit 解码）。对应 repo.cljs 的 `::sse/*` 分支；CLJS 依赖
  `eventsource-parser`，外壳不引第三方包。
- 进度组件：`lib/progress.ts`（`initialize-progress`/`update-progress`/
  `toggle-progress-visibility`/`clear-progress` 与 280px 进度条数学的无头移植）+
  `components/progress-notification.tsx`（context + svg 进度条，healthy 用
  `--color-accent-primary`、slow 用 `--color-accent-warning`），挂在
  `app/dashboard/layout.tsx` 的内容区（`position: relative` 与 CLJS 的绝对定位一致）。
- 网格与菜单扩展：`dashboard-grid.tsx` 增加 `LibraryCard`（三段资产摘要、`(...)` 溢出项、
  颜色样本圆点、typography 样本）、`canRestore`（缩略图 `is-deleted`、卡片不导航、日期换成
  `will-be-deleted-at`）、`origin`（libraries/search 各自裁剪菜单）与库视图的
  `pp-library-item`；`file-menu.tsx` 增加 `bulk` 流（restore / delete-forever 两个确认
  弹窗）与 `canRestore` 短路分支（回收站里只有这两项）；新增 `components/deleted-tabs.tsx`。
- 无头逻辑（`lib/dashboard.ts`）：`get-team-deleted-files`/`get-team-shared-files` 封装、
  `visibleDeletedFiles`（丢弃 deadline 已过的行，对齐 `deleted-files-fetched`）、
  `deletedFilesOf`/`deletedProjectsFor`、`subscriptionType`/`deletionDays`、
  `colorSampleValue`、`restoreDeletedTeamFiles`/`permanentlyDeleteTeamFiles`（ids 转
  transit set、progress 回调），`computeGridLayout` 支持自定义最小宽（libraries 用 350）。
- 与 CLJS 的有意偏差（代码注释均登记）：组件样本的 `component-svg` 降级为占位方块
  （要 F9 的渲染栈）；typography 样本只套 font-family/weight/style，团队自定义字体加载
  推到 F5.4；nitrate 的 90 天分支推到 F5.7（订阅切片）；遥测事件省略；`dd/restore-files`
  结尾的两次 `fetch-projects` 去重为一次；进度组件的 `:error` 分支（含重试按钮）属资产
  导出流，推到 F5.6；进度条颜色用主题令牌而非 `clr/new-primary`（浅色主题下 CLJS 的
  `#fe4811` 与令牌 `#fe9c07` 有别）；页签用 `<button>` 而非 `div`（快捷键注册表 F5.6 才到，
  先保证键盘可达）。
- 后端上游竞态（本轮端到端暴露，非外壳缺陷）：`delete-file`/`delete-project` 除写库外还投递
  `:delete-object` 任务，任务几秒后按当时算好的删除时刻**重写** `file.deleted_at`
  （`backend/src/app/tasks/delete_object.clj`），期间发生的恢复会被覆盖，文件重新出现在
  回收站（`is-shared` 也被一并置回 false）。CLJS 同样存在此洞；按门禁本轮不改后端，只在
  `lib/dashboard.ts` 注释登记，端到端脚本在软删后等任务队列排空再操作 UI。
- 测试：vitest 219 例（新增 33 例：`parseSseBlocks` 的分块/多 data 行/注释/keep-alive、
  进度状态机与 280px 数学、`visibleDeletedFiles`/`deletedFilesOf`/`deletedProjectsFor`/
  `subscriptionType`/`deletionDays`/`colorSampleValue`/`computeGridLayout(350)`）。
- 端到端验证（docker 后端 + Next dev `:3450`，一次性账号 `f4-shell-check@…`，脚本开头清空
  回收站脏数据、结尾清理本轮数据）：headless Chrome/CDP **56 项断言全过**——search 三态
  占位、输入即路由到结果网格、结果菜单只有「在新标签打开」、清空回到占位；libraries 只列
  已发布文件、摘要卡三段 `(0)`、库视图不显示共享 badge、无 layout 切换、菜单保留
  rename/duplicate/unpublish 而去掉 move/delete；deleted 页签选中态、7 天保留期文案、
  Restore All / Clear trash、单文件恢复（进度组件 + toast + RPC 复核）、项目级恢复
  （`project.deleted_at` 清空、文件回队）与项目级彻底删除（文件离开可见回收站、渲染空态）、
  Recent↔Deleted 页签互跳并保住 `team-id`。
- 验证：`pnpm translations`（323 词条，+51）、`pnpm typecheck`、`pnpm lint`（无警告）、
  `pnpm build`（30 路由全部预渲染；`/dashboard/deleted` 3.63kB、`/dashboard/libraries`
  825B、`/dashboard/search` 1.01kB）、`pnpm test`（219 例）全部通过。
- 下一步：F5.4——`/dashboard/fonts` 与 `/dashboard/fonts/providers`（自定义字体上传、
  字体族与变体、`team-font-variant` 资产），顺带补回 F5.3 推迟的 typography 样本字体加载。

### 7.11 本轮（2026-10-09，第十批：F5.4 自定义字体）

- F5.4 完成：`/dashboard/fonts` 从 `RouteStub` 升级为完整 `fonts-page*`（上传队列 +
  已安装字体表）；`/dashboard/fonts/providers` 与 CLJS 的 `font-providers-page*` 一致，
  只有页头加占位说明。
- 无头逻辑（`lib/fonts.ts`，652 行，`app.main.data.fonts` 的移植）：mtype 由前 4 字节
  签名判定（OTTO/0x00010000/wOFF/wOF2 → font/otf|ttf|woff|woff2）；TTF/OTF/WOFF 经
  `opentype.js` 读 preferredFamily/preferredSubfamily 与 hhea/os2 垂直度量（两表不一致
  即 `height-warning`），WOFF2 不可解析回退文件名去 token（`familyFromFilename` +
  `parseFontWeight`/`parseFontStyle`）；`validFontFamily` 拦非法族名。上传队列：
  `processUpload`（单趟读取 + 逐文件错误收集）→ `joinUploadedFonts`（同
  family/weight/style 合并 mtype）→ `mergeAndGroupFonts`（与已安装字体同族时复用其
  font-id）→ `uploadFontVariant`（10 MiB 分块、2 并发、`create-font-variant`）。
  @font-face 注册表：`registerCustomFonts`/`customFontCss`/`ensureLoaded`
  （`custom-<font-id>` 键、`font-display: block`、媒体 URI 经 `resolveMediaUri`，
  注入单个 `<style id>` 并按 loadedFontIds 缓存）；命令封装 `get-font-variants`、
  `update-font`、`delete-font`、`delete-font-variant`、`download-font`、
  `download-font-family`。
- 分块上传层（`lib/uploads.ts`，`app.main.data.uploads` 的移植）：`chunkRanges` 切片表 +
  `uploadBlobChunked`（`create-upload-session` → 双并发 `upload-chunk` → 返回 session
  id，第三步留给调用方）；`cmdUpload` 增加 `[Blob, filename]` 元组支持（对应 CLJS 的
  `(list chunk "chunk-N")`），分片以命名文件部件发送。
- 视图：`components/fonts-page.tsx`（794 行）——上传队列（文件选择、family 输入
  校验、逐行上传与 upload-all 串行、dismiss、最短 2000ms 的 “Uploading…”、bad-font
  toast 单/复数分支）与已安装字体表（按 family 分组、不区分大小写的搜索、inline
  重命名、删除字体/变体的 ConfirmDialog、下载单变体/整族）；`lib/dashboard-context.tsx`
  增加 fonts 切片（`fonts`/`refreshFonts`；`loadFonts` = `get-font-variants` +
  `registerCustomFonts`，切换团队时重置）；`components/dashboard-grid.tsx` 的 LibraryCard
  补 typography 样本字体加载（F5.3 推迟项；deps `[file, fonts]`，字体到达后重跑）；
  `lib/dom.ts` 增加 `triggerDownload`；`components/tr.tsx` + `lib/i18n.ts` 支持
  `**bold**` 段（hero/warning 文案用）；新增依赖 `opentype.js@^2.0.0` 与
  `types/opentype.js.d.ts` 垫片。
- 样式：`styles/dashboard.css` 追加 fonts 块（+340 行，fonts.scss 的移植，全部作用域在
  `.pp-dashboard-fonts` 下）。
- 修掉三个上传错误路径缺陷（CLJS 原样存在，代码注释均登记）：① 单行上传失败不清理
  `:uploading`，按钮永久卡在 “Uploading…”——外壳失败后清 uploading 且保留行可重试；
  ② `on-upload-all` 失败的 `[id nil]` 分支 dissoc 掉行，用户无法重试——外壳保留行；
  ③ `disable-upload-all?` 的 `(some bad-font-family-tmp? fonts)` 遍历 MapEntry，
  `contains? :font-family-tmp` 恒 false，按钮从不禁用——外壳改为检查 values。
- 与 CLJS 的有意偏差（代码注释均登记）：`update-font`/`delete-font`/
  `delete-font-variant` 成功后 refetch，不用乐观更新；上传成功后也 refetch
  （CLJS `add-font` 只 patch store，不重注册 @font-face 注册表）；bad-font toast 在整批
  解析完成后发（CLJS 从第二个订阅里边读边发）；文件选择器是隐藏 `<input type="file">`
  （同 CLJS file-uploader 的等价物），搜索框受控。
- 测试：vitest 262 例（+43）：`lib/fonts.test.ts` 33 例（mtype 四签名、weight/style/
  family 解析与文件名回退、同族合并/分组/重命名、processUpload 错误与高度告警、
  @font-face 模板、ensureLoaded no-op）、`lib/uploads.test.ts` 6 例（切片数学、fetch stub
  的会话链、命名分片与截尾、空 blob 跳过）、`lib/rpc.test.ts` +2（cmdUpload 元组/裸
  Blob/丢弃 undefined）、`lib/i18n.test.ts` +2（`**bold**` 段）。
- 验证：`pnpm translations`（353 词条，+30）、`pnpm typecheck`、`pnpm lint`（无警告）、
  `pnpm test`（262 例）、`pnpm build`（30 路由全部预渲染；`/dashboard/fonts` 与
  `/dashboard/fonts/providers` 各 182 B、First Load 216 kB）全部通过。
- 浏览器端到端断言本轮未跑（本机没有 docker，后端栈起不来）：字体上传/重命名/删除/
  下载与 @font-face 注入的交互走查留待在可用环境补做。
- 下一步：F5.5 团队管理——`/dashboard/settings`、`/dashboard/members`、
  `/dashboard/invitations`、`/dashboard/webhooks`（含 change-owner 与 team-form）。

### 7.12 本轮（2026-10-09，第十一批：F5.5 团队管理）

- F5.5 完成：四个路由从 `RouteStub` 升级为完整页面。`/dashboard/members`
  （`team-members-page*`：成员表按 owner→admin→editor→viewer 排序，角色下拉与移出
  成员，三种离开流程（普通离开、转移后离开、离开即关闭）与确认弹窗）；
  `/dashboard/invitations`（`invitation-section*`：按角色/状态排序的表、行勾选与选中
  工具栏、角色变更、复制邀请链接、重发（`resend: true` 的单次 create）与删除确认）；
  `/dashboard/webhooks`（`webhooks-page*`：空态 hero、列表（末次投递与错误摘要）、
  新建/编辑弹窗、删除确认、无权限行的操作区占位）；`/dashboard/settings`
  （`team-settings-page*`：团队照片上传（owner/admin）、资料块、owner 行、成员/项目
  计数）。
- 无头逻辑（`lib/team.ts`，691 行，`app.main.data.team` 与 `ui/dashboard/team.cljs`
  派生逻辑的移植）：成员/邀请/webhook/统计的行形状；角色判定（`memberRole` 与
  `can-change-member-role`/`can-leave-from-menu`/`can-remove-from-menu`/
  `can-edit-webhook` 谓词）；`canSendInvitations`（admin-console 组织分支与
  `profileId` 契约留给 F5.7，flag 关时走团队 flags 回退）；`orderedMembers`；
  邀请排序状态机（`nextSortState`/`sortedInvitations`/`selectedInvitations`/
  `invitationStatus`/`invitationUrl`）；webhook 错误摘要（`extractStatus`/
  `translateErrorHint`/`webhookLastDeliveryText`）；team-hero 存储
  （`read/writeTeamHeroVisible`，键 `show-team-hero` 与 CLJS 互通）；
  `globalEnabledFeatures`（create-team 的 features 集）；`refreshTeamPermissions`
  （`with-refreshed-team` 的移植）；`teamFormErrorMessage`。命令封装：
  `get-team-members`、`update-team-member-role`、`delete-team-member`、`leave-team`、
  `delete-team`、`create-team`、`update-team`、`update-team-photo`、
  `get-team-invitations`、`create-team-invitations`、`update-team-invitation-role`、
  `delete-team-invitation`、`get-team-invitation-token`、`get-webhooks`、
  `create-webhook`、`update-webhook`、`delete-webhook`、`get-team-stats`。
- 组件：`team-header.tsx`（页头 + 四个页签，按 flag 与权限裁剪）、`team-invite.tsx`
  （invite-members 弹窗：邮箱 chips 输入（成员已在队的警示）、`:repeated-invitation`
  横幅、五种 no-permission 弹窗；`useInviteMembers` 供页头/hero/空表复用）、
  `team-form-modal.tsx`（新建/改名，F5.7 团队切换器复用）、
  `leave-and-reassign-modal.tsx`（change-owner：挑选提升者）、
  `webhook-modal.tsx`（新建/编辑）、`team-hero.tsx`（recent 页横幅）、
  `member-avatar.tsx`（照片或生成头像）。
- recent 页补口：挂 `TeamHero`，可见性 = 存储标志（mount 时读，SSR 安全）∧
  可邀请 ∧ 非默认团队；关闭写存储；容器加 `pp-with-team-hero`。
  `lib/dashboard-context.tsx` 增加团队切片（members/invitations/webhooks/stats
  与 `refresh*`，切换团队时重置；`fetch-members` 的 `:not-found` 视为空列表）。
- 样式：`styles/dashboard.css` 追加 team 块（+617 行，`team.scss`/`team_form.scss`/
  `change_owner.scss` 与 `projects.scss` 的 team-hero 段移植）；容器覆盖统一用
  双类（`.pp-dashboard-container.pp-dashboard-team-*`）压过 `settings.css` 的
  同名单类，不依赖加载顺序；类名经差集审计清零（模板字符串拼出的假前缀除外）。
- 与 CLJS 的有意偏差（代码注释均登记）：admin-console 组织分支
  （`check-organization-members`、`all-organization-members-in-team`、组织名提示）、
  members-cta 订阅横幅、settings 的组织块/订阅块 → F5.7；角色/操作下拉用
  `DashboardMenu` 而非 ds dropdown（全站约定）；邀请成功的 attach 弹窗省略
  （只留 tick 与 toast）；删邀请逐条 await 后统一刷新（CLJS 逐条刷新）；members
  页的「转移后离开」把成员快照传给弹窗（modal host 在 dashboard provider 之外）；
  team-hero 的 `dont-show-team-up-hero` 遥测省略；离开/删除失败走
  `errors.generic`。
- 测试：vitest 305 例（+43）：`lib/team.test.ts`——canSendInvitations、角色与菜单
  谓词矩阵、`orderedMembers`、邀请排序与勾选、webhook 状态/末次投递/URL、hero
  存储往返、命令封装参数、team-form 文案、`globalEnabledFeatures`、
  `refreshTeamPermissions`。顺带清掉两处 lint 警告（`team-invite.tsx` 未用 import；
  `canSendInvitations` 的 `profileId` 形参加注释说明契约）。
- 验证：`pnpm translations`（470 词条，+117）、`pnpm typecheck`、`pnpm lint`
  （无警告）、`pnpm test`（305 例）、`pnpm build`（30 路由全部预渲染；
  `/dashboard/members` 4.19kB、`/dashboard/invitations` 3.77kB、
  `/dashboard/webhooks` 3.57kB、`/dashboard/settings` 1.93kB、
  `/dashboard/recent` 5.73kB）全部通过。
- 浏览器端到端断言本轮未跑（本机没有 docker，后端栈起不来，同 7.11）：成员/
  邀请/webhook/团队设置与 team-hero 的交互走查留待在可用环境补做。
- 下一步：F5.6——templates 分区、binfile 导入/导出与 dashboard 快捷键注册表
  （补齐 settings/shortcuts 占位）。
- F5.5 收尾（同日补记）：CLJS 的团队管理入口是 organization-team-switch 关闭
  控件右侧的「…」按钮（`aria-label` 即 "team management"），shell 把整个切换
  控件推到 F5.7 时连入口一并搁置，四个团队页在页面上无路进入（用户报「团队管理
  的入口在哪里」）。补口：新 `components/team-options-menu.tsx`
  （`TeamOptionsButton`：侧边栏团队名旁「…」按钮 + `options-dropdown*` 的非
  组织项——成员/邀请/webhook（flag）/设置/重命名/离开/删除；默认团队不显示，
  同 CLJS `show-team-options-button?`）；新 `components/team-leave-flows.tsx`
  （`useTeamLeaveFlows`：members 页的三种离开流程抽为共享 hook 两边复用；新增
  `onDeleteTeam` 为 `check-and-delete-team` 移植——fetch 最新团队行判定
  `permissions.is-owner`，通过弹删除确认、否则 no-permission 弹窗，组织分支留
  F5.7）；members 页改引 hook（-128 行）；侧边栏头部改横向布局 + 新增
  `.pp-sidebar-team-info`（+9 行 CSS）；补 4 个词条（`labels.team-management`、
  `modals.delete-team-confirm.*`）。验证：lint/tsc 无警告、vitest 305 例、build
  30 路由全过（构建前先停 dev、清 `.next`，后重启 dev 并审计资源 9/9 200）。
  F5.7 剩：组织列、切换器控件本体与 leave-organization。

### 7.13 本轮（2026-10-10，第十二批：F5.6 templates / binfile / 快捷键注册表）

- F5.6 完成：三块收口（file flows 随 `4c56076fd2` 落地、快捷键注册表随后六个提交）。
  导出：`/dashboard/files` 文件菜单进入导出弹窗——无共享库的选中项开弹窗即导出，有
  则先选四种类型（include/merge/detach libraries、link-later 受 `export-link-later`
  flag 门控）；SSE `export-binfile` 的 end 载荷即下载 URI（一小时有效）。导入：项目
  菜单、网格 OS 拖入与空项目卡三入口 → 弹窗按 analyze → 勾选 → 导入 → 库链接解析
  状态机推进（v3 zip 按 manifest.files 展开、v1 单条目；模板克隆走同一弹窗）。
  templates 分区：recent/files 页底部可折叠抽屉（内建模板卡 + 库与模板链接卡），
  折叠标志存 `penpot-global` 与 CLJS 互通。
- 无头逻辑（file flows）：`lib/binfile.ts`（547 行：导出类型集与 SSE 封装、ZIP
  v1/v3 嗅探与条目分析、逐文件导入管线、`clone-template`/`get-builtin-templates`、
  `link-file-to-library`、导入错误消息解析）；`lib/templates.ts`（折叠标志读写、
  缩略图 URL、可见模板集）；`lib/dom.ts` 增 `triggerDownloadUri`/`normalizeWheel`/
  `pickFiles`。
- 快捷键注册表：`lib/shortcuts.ts`（622 行：cMod/aMod/metaLabel 显示助手、Mousetrap
  keydown 归一化与序列匹配（只发最长匹配、未匹配 keydown 重置 pending、未完成序列
  1 秒超时）、自定义覆盖变换与冲突查找、`customShortcutsWire`（profile props 双级
  transit 关键字键；`lib/transit.ts` 增 `keywordMap`））；`lib/dashboard-shortcuts.ts`
  （171 行：五个定义 toggle-theme/go-to-drafts/go-to-libs/go-to-search/
  create-new-project 与页面 set 组合、base 集仅 toggle-theme）；
  `lib/dashboard-shortcuts-runtime.ts`（109 行：`dashboardSetForPath`——/dashboard/
  recent→projects、files/libraries→drafts-libraries、其余 dashboard→shell、/settings→
  base；绑定与 dispatch）；`lib/shortcuts-page.ts`（569 行：树构建与翻译排序、剪枝
  过滤、三页签行过滤、导入校验与 diff/merge、恢复部件抽取、导出文件名）。
- 组件与页面：`shortcut-keys.tsx`（键帽）、`shortcut-row.tsx`（只读/可编辑行 + 录制
  流）、`restore-shortcuts-modal.tsx`、`import-shortcuts-diff-modal.tsx`、
  `dashboard-shortcuts-context.tsx`（Provider 以 ref 保最新 customs，profile 往返
  期间两次连续编辑不丢第一个）；settings/shortcuts 页面（三页签、搜索 + 恢复全部、
  可折叠 dashboard 树、导入/导出 footer）；dashboard 与 settings 布局挂 Provider
  （`dashboardSetForPath` 解析 `/settings`→base）、recent 页注册 create-project
  handler（"+" 快捷键，canEdit 门控）。样式：`styles/settings.css` 追加快捷键块
  （+435 行，pp-shortcuts-* 全套）、`styles/dashboard.css` 追加 templates 与
  导入/导出块。
- 与 CLJS 的有意偏差（代码注释均登记）：file flows 侧——`export-binfile` 不带
  `:version 3`（2.12 起 schema 已删）、worker 的 200ms 节流与对象 URI 生命周期
  省略（直接读 File）、worker 池换成逐文件顺序 analyze、legacy-zip 的改名路径与
  `:libraries` 渲染未移植（该格式已不存在）、zip 无 manifest 用一条 plain Error
  文案、模板卡 Enter 绑在可聚焦容器（CLJS 绑在不可聚焦的内层 `<a>`）、模板 fetch
  每挂载一次（ref 防 StrictMode 双效应）、导入/导出失败在弹窗行内呈现（共享进度
  组件的 `:error` 分支未动）。快捷键侧——tab strip 为页面本地控件、导入/导出是
  两个按钮（CLJS 为 dropdown）、expand-all 效果不再把手动收起弹回、footer 在树后
  （CLJS fixed 到视口）、折叠体条件渲染（CLJS 用 hidden）、默认展开 dashboard
  （CLJS 默认 workspace，shell 树中不存在）、录制监听用目标节点原生 keydown、
  录制命令以 null 判定（"" 走禁用流）、行内通知自绘、tooltip 用 title 属性、
  "+" 亦接受 Shift+=（US 主排）、导入校验对 workspace/viewer 上下文只查形状
  （注册表未迁移）、导出序列化用 plain JSON.stringify（keywordMap 不可 JSON
  序列化）。
- 测试：vitest 485 例（较 F5.5 的 305 增 180）：`lib/binfile.test.ts`、
  `lib/templates.test.ts`、`lib/shortcuts.test.ts`（序列匹配/覆盖/冲突）、
  `lib/dashboard-shortcuts.test.ts`、`lib/dashboard-shortcuts-runtime.test.ts`、
  `lib/shortcuts-page.test.ts`。
- 验证：`pnpm translations`（579/579 全解析）、`pnpm typecheck`、`pnpm lint`
  （无警告）、`pnpm test`（485 例）、`pnpm build`（30 路由全部预渲染；
  `/settings/shortcuts` 7.73kB/229kB、`/dashboard/recent` 3.18kB/250kB）全部通过；
  dev 重启后 `/`、`/settings/shortcuts`、`/dashboard/recent`、`/dashboard/files`
  审计 200。
- 浏览器端到端断言本轮未跑（本机没有 docker，后端栈起不来，同 7.11/7.12）：导出/
  导入/模板克隆与快捷键录制/导入/恢复的交互走查留待在可用环境补做。
- 下一步：F5.7——organization/team switch、subscription/nitrate、comments、插件
  注册、WebSocket `subscribe-team` 实时刷新（依赖 F8）。

### 7.14 本轮（2026-10-10，第十三批：F5.7 organization/team switch 与 subscription/nitrate）

- F5.7 两片完成（13 个提交，`38902899c6`–`7dabf4884c`）。F5.7 剩 comments、插件注册与
  `subscribe-team` 实时刷新。
- organization/team switch：无头模块 `lib/org-switch.ts`（381 行：组织列表与切换状态机）
  与 `lib/nitrate.ts`（nitrate 域命令与许可判定）；`components/org-team-switch.tsx`
  （961 行：两级组织/团队下拉、门控的组织行）替换侧边栏占位并重构
  `team-options-menu.tsx`；leave flows 补全——`org-leave-flows.tsx`、
  `leave-and-reassign-org-modal.tsx`（离开/转让两条路径）与 `team-leave-flows.tsx`
  扩展；侧边栏接线与 `styles/dashboard.css`（+447 行）。翻译随 `2ea0a8f187`。
- subscription/nitrate：无头模块 `lib/subscription.ts`（plan-type、侧边栏/members 两种
  横幅谓词、坐席数学、nitrate 许可读取、deletion-days 条件、账号龄与日期格式）；
  `lib/nitrate.ts` 扩展（checkout 链接、connectivity、激活码、billing 上下文）；弹窗
  五件套 `components/subscription-dialogs.tsx`（管理/成功/nitrate 订阅/联系销售/取消联系
  销售 + popup hook）与 `components/nitrate-modals.tsx`（欢迎/激活码/成功）；
  `components/subscription.tsx`（519 行：侧边栏订阅横幅 + 额外坐席横幅 + 团队 plan 块）；
  `components/subscription-plan-card.tsx` 与 `/settings/subscriptions`
  （`app/settings/subscriptions/page.tsx`，四张计划卡与全部对话框接线）；`lib/config.ts`
  增 `isSaas`（`NEXT_PUBLIC_PENPOT_IS_SAAS`，对应全局 `penpotIsSaas`）；trash 90 天分支
  接线（`deleted/page.tsx` 改用 `deletionDaysFor`，`lib/dashboard.ts` 的旧三分支函数
  删除）。样式：`styles/settings.css` +646 行、`styles/dashboard.css` 追加订阅横幅块。
  翻译随 `7dabf4884c`（742/742 全解析）。
- 与 CLJS 的有意偏差（代码注释均登记）：SPA 外导航一律绝对路径（billing/admin
  console/payments 链接）；订阅页对未知 plan 渲染 null（CLJS case 无 default）；遥测
  省略；`saas?` 由全局注入改为 `NEXT_PUBLIC_PENPOT_IS_SAAS`；弹窗宽度用
  `.pp-modal:has(...)` 选择器（ModalShell 无 className）；`lib/forms` 补 number 字段
  类型（坐席输入）；弹窗按钮统一进 ModalShell footer（CLJS 在内容区）。
- 测试：vitest 585 例（较 F5.6 的 485 增 100），新增 `lib/org-switch.test.ts`（408 行）、
  `lib/subscription.test.ts`、`lib/nitrate.test.ts` 扩展等。
- 验证：`pnpm translations`（742/742 全解析）、`pnpm typecheck`、`pnpm lint`（无警告）、
  `pnpm test`（585 例）全部通过；`pnpm build` 未在本轮重跑（构建需先停 dev、清 `.next`），
  新增 `/settings/subscriptions` 路由留待下次构建确认。
- 浏览器端到端断言本轮未跑（本机没有 docker，后端栈起不来）：组织切换/离开流程、订阅页
  四卡与五个对话框的交互走查留待在可用环境补做。
- 下一步：F5.7 收尾——comments、插件注册、WebSocket `subscribe-team` 实时刷新（依赖 F8）。

### 7.15 本轮（2026-10-10，第十四批：F6.1 viewer 数据层与 F6.2 外壳）

- F6 开局：viewer 切成 F6.1–F6.6 六片（数据层 / 外壳 / 导航与缩放交互 / WASM 渲染 /
  interactions / 收尾），前两片完成并入库（5 个提交，`a328743615`–`bb4264bd7a`）。
- F6.1 数据层（`a328743615`）：`lib/viewer.ts`（522 行：feature 门控、bundle 拉取与
  pointer 两趟解析、帧读取与 z-index 排序、分页构建、URL 查询解析、帧选择钳制、
  zoom 数学、`viewerHref` 链接构建）；单测 `lib/viewer.test.ts`（323 行）。随附两个
  传输层缺陷修复：
  - `5492b09cf3`：RPC 的 GET 集合参数改为重复键编码（`?a=1&a=2`），匹配后端读取
    方式；`lib/rpc.ts` 随回归测试 75 行。
  - `64580fbda3`：view-only bundle 的 `fdata` objects-map 需专用 reader 并隔离
    缓存（共享缓存会串数据）；`lib/transit.ts` +35，回归测试 53 行。
  - `996487c87b`：`.gitignore` 忽略 render-wasm 构建产物（F6.4 预置）。
- F6.2 外壳（`bb4264bd7a`）：`app/view/page.tsx`（520 行：bundle 加载状态机、帧
  导航与 URL 双向镜像、fit/fill zoom、全屏、thumbnails 开关、`window.name` 会话
  命名）；`components/viewer-header.tsx`（403 行：Dropdown/ZoomWidget/SitemapZone）、
  `components/viewer-pagination.tsx`、`components/viewer-icons.tsx`（占位图标集）、
  `styles/viewer.css`（894 行，由 CLJS 样式移植）；`app/globals.css` 挂样式；翻译 +11 条。
- 与 CLJS 的有意偏差（代码注释均登记）：viewer 快捷键与滚轮 zoom 未接（F6.3）；
  thumbnails 面板只有开关（F6.3）；viewport 为占位块、bounds 取 selrect（F6.4）；
  not-found 异常页未移植（F6.6）；bundle 按文件缓存一次（CLJS 随 page-id 重拉）；
  viewer 为公开路由不套 AuthGuard（分享链接访问是常态）。
- 测试：vitest 626 例 / 24 文件（较 F5.7 的 585 增 41）；`pnpm typecheck`、`pnpm build`
  通过。
- 下一步：F6.3——thumbnails 面板、viewer 快捷键注册表（13 条）、滚轮 zoom
  （mod+wheel）。

### 7.16 本轮（2026-10-12，第十五批：F6.3 导航与缩放交互、F6.4 WASM 渲染）

- F6.3 导航与缩放交互（`76d13ebf86`）：thumbnails 面板（摘要行与帧计数、展开/
  收起、箭头步进与滚轮、展开网格；点击条目导航并在展开态收起）；viewer 快捷键
  注册表（13 条，经共享 matcher 绑定；select-all/open-inspect/open-comments
  三条不绑，保留原生行为）、mod+wheel zoom 接入交互视口；`viewer.css` +257、
  翻译 +13。
- F6.4 WASM 渲染（route B：复用 `public/js/shared.js` 编译产物，不在 TS 重写
  序列化器）：
  - `lib/render-wasm/`（新目录）：`bridge`（boot globals、shared.js/main.js
    加载、宿主容器补齐、SES 隔离）、`packages`（动态 import 桥）、`interop`
    （`$APP` 键映射与调用 helpers）、`values`（view-only bundle 以原始 transit
    文本交给编译解码器；`lib/rpc.ts` 为此抽出 `cmdRaw`，与 `cmd` 共享 HTTP
    交换）、`sizes`（gsb/get-object-bounds + zoom，含 stroke/阴影/模糊
    padding）、`position-data`（update-page-position-data 等价）、`frame-render`
    （render-to-canvas 等价，见偏差）。
  - `components/viewer-wasm-viewport.tsx`：WASM 帧视口（wasm 就绪探测、渲染
    事件协调、缩略图 offscreen 拆除后按 `wasm/live?` 重初始化、on-render 时跑
    position pass、软 clear-canvas 卸载）；`viewer-thumbnails.tsx` 帧占位块换成
    真实位图（`screenshot-<id>`）；`styles/viewer.css` +30。
  - `app/dev/render-wasm/page.tsx`：诊断页（非产品页），逐字对照编译调用链；
    查询参数同 viewer 路由（file-id/page-id/frame-id/share-id/scale）。
  - `lib/transit.ts`：新增 `penpot/path-data` reader；依赖接线：render-wasm 用到
    的 `@penpot/*` 包以 `link:` 挂 `frontend/` 源码树，`next.config.mjs` 加
    webpack alias 重定向 linked 树内裸导入（draft-js/immutable/tokenscript
    interpreter）。
- 关键偏差与发现（代码注释均登记）：`app.main.render-viewer-wasm` 命名空间被
  Closure ADVANCED 内联为模块私有（运行时实测 `$APP` 上 0 键），
  `render-to-canvas` 无法直接调用；`frame-render.ts` 用公共 api 原语
  （init-canvas-context、initialize-viewport、render-sync-shape 走
  `internal._render_sync_shape`、位图 blit、clear-canvas）重建等价流程，并自
  实现渲染串行队列。其余偏差：`disable-request-render?` 为模块私有不可达
  （接受）；position pass 借 viewport 已载模型（本 bundle 缺 CLJS 用的 per-shape
  serializer 导出）；viewer-snapshot 无需重置。
- 测试：vitest 676 例 / 28 文件（较 7.15 的 626 增 50）；`pnpm typecheck`、lint
  干净；headless Chrome/CDP 端到端 11/11（board 位图 168×264、offscreen 拆除后
  viewport 重初始化并收敛、console 零错误）。
- 下一步：F6.5 interactions（hotspots 命中、flows 菜单、overlay 动画）。

### 7.17 本轮（2026-10-12，第十六批：F6.5 viewer interactions）

- F6.5 六片完成并入库（6 个提交，`a00e36adae`–`dd072bd0bb`）：hotspots 命中、overlay
  开合、flows/interactions 菜单、WAAPI 动画与 show-interactions 高亮全部落地。
- 交互数学（`a00e36adae`）：`lib/viewer-interactions.ts`（649 行：click/mouse-press/
  mouse-enter 与 overlay 的 activate / deactivate、`calculateDelta`/snap-to 对齐、
  overlay 的位置与尺寸语义、prev-screen 的同源 referrer 守卫）与 652 行单测；
  `lib/viewer.ts` 补 flows/auto-frame 助手（+36）。
- hotspot 层（`14cd87bf68`）：`lib/render-wasm/viewer-shapes.ts`（per-shape path-data
  reader 与对象准备，+262）与 `viewer-wasm-viewport.tsx` 的 SVG 命中层——hotspot rect
  是唯一命中目标（pointer-events 恒 all）、pointer 事件经 stop-propagation 后执行
  activate/deactivate，after-delay 交互按定时器触发；page.tsx 接线动作分发（+49）。
- overlay 片（`a811cf8f33`）：blit 管线重构（`viewer-render.ts` 211 行、
  `pass-common.ts` 167 行、`frame-render.ts` 瘦身）；`components/viewer-overlay.tsx`
  （161 行：close-click-outside / background-overlay 遮罩、fixed-source 固定定位）与
  `lib/viewer-overlays.ts`（开合列表 + 56 行单测）。
- 动画（`5a7ea57170`）：`lib/viewer-animations.ts`（379 行：go-to-frame 三关键帧、
  overlay 开合与反向动画、origin viewport 保持至 rewind）与 346 行单测；page.tsx
  接线（+272）。
- 菜单（`52384ee0dd`）：flows 菜单（`pageFlows`/`getFrameFlow`，pick 走 go-to-frame 的
  index 导航）与 interactions 菜单（`interactions-mode` URL 参数，默认 show-on-click）；
  菜单挂载门控（normalizedFileId，对应 CLJS 的 `(when index ...)`）与 pick 的
  stop-propagation；`viewer.css` +75、en.ts +4。
- 高亮与 flash（`dd072bd0bb`）：show-interactions 切片——菜单 pick 经
  `showInteractionsFor` 映射（:show 保持）、show-on-click 模式的 window click 触发
  500 ms flash（新点击重启、仅新 flash 取消挂起的定时，忠实 take-until）、flag 传给
  orig/current/overlay 三个 viewport（ViewerOverlay 新增透传 prop）。
- 与 CLJS 的有意偏差（代码注释均登记）：动画自 bounds 报告启动（CLJS 从解码页同步
  开始）；overlay 尺寸取 onBounds 报告且 frame 从当前页解析（CLJS 预算尺寸、查全局
  all-frames）；go-to-page 清空 overlay 列表（CLJS 留下不再解析的条目）。
- 测试：vitest 743 例 / 31 文件（较 F6.4 的 676 增 67）；`pnpm typecheck`、lint 干净。
- headless Chrome/CDP 端到端三轮冒烟全绿：三路动画（navigate/overlay/close）、
  flows/interactions 菜单（tick 迁移、URL 持久、归一化回退）、show-interactions 高亮
  （flash 500 ms 与重启、show 常亮、hide/on-click 关闭），console 零错误。
- 下一步：F6.6 收尾——`frame-preview` + `render-sprite` 路由、not-found 异常页。

### 7.18 本轮（2026-10-13，第十七批：F6.6 viewer 收尾）

- F6.6 收尾完成并入库（1 个提交，`5a337179a0`）：`frame-preview` 路由与
  not-found 异常页落地。
- frame-preview：`lib/frame-preview.ts`（跨窗口 `window.load(data, width,
  height)` 协议的写入助手：iframe 尺寸比内容多 64px、zoom 百分比换算）与
  `app/frame-preview/page.tsx`（挂载时暴露 `window.load`、iframe 与 zoom
  滑块）。
- not-found 异常页：`lib/exception-page.ts`（access-info 加载、exception 与
  request-access 状态机、`request-access-params` 与
  `create-team-access-request` 命令）；`components/exception-page.tsx`
  （error-container 布局、deco 条带与版权尾注、NotFoundContent、
  RequestDialog 与 RequestAccess 六分支）；`styles/error.css`；
  `app/view/page.tsx` 两处入口——page-id 不解析（viewer-content* 的
  `:not-found`）与 bundle 拉取失败的 `:not-found` / `:authentication` cause。
- 与 CLJS 的有意偏差（代码注释均登记）：匿名访客显示 not-found 内容加 Login
  按钮（CLJS 弹 login-modal）；刚登录的 loader 分支丢弃；load-info 失败回落空
  info；request-access 对话框固定 overlay。`render-sprite` 路由不做——CLJS
  注册了但无渲染消费者。
- 测试：vitest 769 例 / 33 文件（较 F6.5 的 743 增 26）；`pnpm typecheck`、
  lint 干净；headless Chrome/CDP 冒烟 4/4（window.load 写入与 zoom、坏
  page-id 与坏 file-id 两条异常页入口），console 零错误。
- 下一步：F7 插件运行时；F5.7 遗留的 comments 与 WebSocket 实时刷新（依赖
  F8）仍挂起。

### 7.19 本轮（2026-10-13，第十八批：F7.1 插件数据层）

- F7 按依赖切成四片（见第 4 节）：完整 Plugin API 上下文强依赖 F9 workspace
  状态，故 F7.1 先落数据层（纯逻辑、可完整测试），F7.2 安装流与管理 UI，
  F7.3 运行时接入（SES boot + 最小 context），F7.4 完整 API 上下文（阻塞于 F9）。
- 数据层落地：`lib/plugins.ts`（572 行）——manifest 解析与校验（权限写蕴含读、
  v1 裸 origin / v2 目录、name+host 复用 plugin-id、失败 console.error 返回
  null）、注册表模块状态与订阅（快照引用稳定，供 useSyncExternalStore）、
  in-flight 追踪（订阅即回调）、install/remove 乐观更新与失败回滚（validation
  错误只回滚本地，其他错误补发一次反向 RPC）、fetchManifest（无自定义头、
  15 s 超时）、normalizePluginUrl/iconUrl、权限 peek（1 天过期）、
  checkPluginPermission（zero-uuid 与 MCP 插件豁免）；`lib/plugin-flags.ts`
  （38 行，flags.cljs 移植：natural-child-ordering 恒 false、
  throw-validation-errors 自 version 2 起 true）。
- 与 CLJS 的有意偏差（代码注释均登记）：不能解析的 manifest URL 返回 null
  （CLJS 的 u/uri 产生空 host 的部分 URI）；getPluginsList 过滤缺少条目的 id
  （CLJS mapv 保留 nil）；v1 host 保留 query/fragment，但默认端口由 URL.origin
  归一化；订阅函数返回 unsubscribe（CLJS 以 f 为句柄）。
- 测试：vitest 817 例 / 35 文件（较 F6.6 的 769 增 48：plugins 42 +
  plugin-flags 6）；`pnpm typecheck`、lint 干净。
- 下一步：F7.2 dashboard `?plugin=` 安装流（参数 → fetch-manifest → 权限弹窗
  → install → try-out 提示）与插件管理列表（profile 菜单入口）。

### 7.20 本轮（2026-10-13，第十九批：F7.2 安装与管理 UI）

- 范围：`use-plugin-register`（dashboard.cljs 的 `?plugin=` 安装流）、
  `plugin-management-dialog`、`plugins-permission-list*`、
  `plugins-permissions-dialog`、`plugins-try-out-dialog`（workspace/plugins.cljs）。
- 落地：`components/plugin-install-flow.tsx`（126 行；`?plugin=` query 或 tab
  session `:plugin-url` 回退 → 等 default project 解析后 fetch-manifest →
  权限弹窗；accept → install + try-out 弹窗 + 回 recent，cancel → 回 recent；
  parse-error 与 bad-url 通知分支与 CLJS 一致）；`components/plugins.tsx`
  （142 行；权限弹窗按 plugins-permission-list* 固定顺序渲染、whitelist 命中
  跳过 disclaimer；try-out 弹窗）；`components/plugin-management.tsx`（249 行；
  URL 输入 → normalize → fetch → 权限弹窗 → install；列表行 icon/name/summary/
  Remove，确认对话框 cancel/accept 都重开管理对话框；空态与 discover 链接；
  in-flight 禁用 Remove）；`lib/config.ts` +16（pluginsListUri 默认 penpot.app
  hub、pluginsWhitelist 逗号分隔）；`lib/plugins.ts` +62（634 行；permissionRows、
  storedPluginUrl/clearStoredPluginUrl，键位 "penpot:/plugin-url"）；
  `components/dashboard-profile-menu.tsx` +30（Plugins manager 入口，
  plugins/runtime 门控）；`styles/dashboard.css` +126（pp-plugin-* 样式）。
- 与 CLJS 的有意偏差（代码注释均登记）：入口暂挂 dashboard profile 菜单（CLJS
  在 workspace 主菜单/top_toolbar，F9 前无 workspace）；列表行 Open 按钮不渲染
  （需 F7.3 运行时）；CLJS 权限弹窗的 document keydown 监听会在任意按键时执行
  accept（缺陷），shell 不复制，取消导航只由 Cancel 按钮承担；try-out accept
  创建文件后跳 dashboard-recent（CLJS 跳 workspace 并 delay-open-plugin，依赖
  F9）；安装流按 URL 只跑一次（handled ref），projects 刷新不重跑；遥测
  （ev/event）丢弃。
- 测试：vitest 829 例 / 35 文件（较 F7.1 的 817 增 12：permissionRows 6 +
  stored plugin url 4 + config.plugins 2）；翻译 822/822 键（较 F7.1 新增
  34 键）；`pnpm typecheck`、lint 干净。
- 下一步：F7.3 运行时接入（SES boot + 最小 Context：`initPluginsRuntime`、
  `ɵloadPlugin`/`ɵunloadPlugin` 桥、theme/flags/事件面）；随后 F7.4（阻塞于
  F9）。

### 7.21 本轮（2026-10-13，第二十批：F7.3 运行时接入）

- 范围：`app.plugins/initialize` + `init-plugins-runtime`（app/plugins.cljs）、
  `app.main.data.plugins` 的 load/open/close 半边、workspace/plugins.cljs 的
  `plugin-entry*` Open 按钮与 `permissions-updated-dialog`。
- 落地：`lib/plugin-context.ts`（320 行；最小 Context：$plugin/version/theme/
  flags/localStorage/addListener；workspace 读写面留 F9 占位——读返回 null/[]、
  写方法抛具名错误）；`lib/plugin-runtime.ts`（258 行；startPluginRuntime 动态
  import + initPluginsRuntime，loadPluginEntry/closePluginEntry/
  closeCurrentPlugins/openPluginEntry 三分支与模块级 notifier 桥）；
  `components/plugin-runtime.tsx`（40 行；layout 挂载，feature 门控 + notifier
  注册）；`components/plugins.tsx` +75（抽 PermissionList、
  PluginPermissionsUpdateDialog）；`components/plugin-management.tsx` +63/-15
  （Open 按钮、peek 权限门控、manifest 变更二次确认）；app/layout.tsx 挂载；
  `components/theme.tsx` applyTheme 通知 themechange。
- SES×transit-js 冲突（冒烟发现的真实缺陷）：SES `repairIntrinsics` 在
  `@penpot/plugins-runtime` 模块顶层执行，会删除 intrinsics 上一切未许可
  属性，删不掉就 throw、中断模块求值；transit-js 构建 writer 时给
  Date/Uint8Array 挂 `transit$guid$<uuid>` 缓存（defineProperty 漏了
  `configurable:true`），而 RPC 层每页都先于插件 boot 加载，故 SES 修复必崩
  （"Cannot delete property ..."）。修复（`lib/transit.ts` +57）：writer 构建
  在守卫下把该属性补成 `configurable:true`（属性名由 transit-js 内部随机
  生成、不导出，只能在 defineProperty 处拦截）；`resetTransitGuids()` 在
  boot 的 import 后重建缓存与 writer（旧 writer 的 handler 表以被删的缓存
  id 为键，且首个惰性重建若晚于 hardenIntrinsics 冻结则会 throw）。冒烟
  复验：两条 `[PLUGINS]` 日志齐、无 error、无 hydration 问题；SES 会打印 3 条
  "Removing unpermitted intrinsics" warn（Uint8Array 的 guid 与
  Date.prototype 上 transit 的两个补丁），预期噪音。
- 与 CLJS 的有意偏差（代码注释均登记）：只派发 themechange；theme 读 html
  class（ThemeManager 为权威）；manifest 校验失败归 unreachable；
  openPlugins 集合与 peek 门控在模块状态；userCanEdit 沿 prop 链下传
  （ModalProvider 在 NotificationsProvider 外，modal 内容取不到通知 API）；
  start-plugin!（MCP）与 delay-open-plugin 等待 F9；遥测丢弃。
- 测试：vitest 871 例 / 37 文件（较 F7.2 的 829 增 42：plugin-context 24 +
  plugin-runtime 16 + transit +2）；翻译 827/827 键（较 F7.2 增 5：
  button-open、error.need-editor、error.unreachable、
  permissions-update.title/.warning）；`pnpm typecheck`、lint 干净；boot 冒烟
  （:3450 dev server + 真实浏览器）通过。
- 下一步：F7.4 完整 API 上下文（阻塞于 F9 workspace）；F7 至此全部可动
  部分完成。

### 7.22 本轮（2026-10-13，第二十一批：中文词条与界面语言选择）

- 动机：外壳词条此前只有 en；`frontend/translations/zh_CN.po`、`zh_Hant.po` 上游已
  有，设置页在 F4 已能保存 profile 的 lang，但运行时没有语言选择——保存后界面仍旧
  英文。本批把中文资源文件与选择链路一起补齐。
- 生成器（`scripts/extract-translations.mjs`，246 行）：改由 `locales` 表驱动（en
  是事实源、缺 key 即失败；zh_cn/zh_hant 按上游进度生成并报告覆盖数）。单复数形态
  对齐构建侧语义：两个 msgstr → `[单数, 复数]` 元组，单 form（zh_Hant
  nplurals=1）→ 平字符串（自带 %s，任意数量都走它）；非 en 目录过滤空条目。
- 产物：`lib/translations/zh_cn.ts`（699/827 键，714 行）、`zh_hant.ts`
  （812/827 键，827 行）；`en.ts` 827 键不变（仅头部重排）。生成文件头部注明
  缺词回退英文的语义。
- 运行时（`lib/i18n.ts`，143 行，+65）：catalogs 注册 zh_cn/zh_hant；`matchLocale`
  （profile lang 优先；空值 = Auto，用浏览器语言；`zh-CN`→`zh_cn`；认不出的值回退
  en，对齐 app.util.i18n 的 parse-locale + autodetect）；`setActiveLocale`/
  `getActiveLocale`；`lookup` 默认 locale 改为活动 locale（逐键回退 en）；`htmlLang`
  （`zh_cn`→`zh-CN`，供 `<html lang>`）。
- 选择链路：`components/locale-gate.tsx`（40 行，挂根布局、包住页面子树）：渲染期
  写活动 locale + `Fragment key={locale}` 重挂载子树——tr 是普通函数不是 hook，靠
  context 无法让非消费者重渲染；navigator.language 在 effect 里读，首屏 SSR 恒为
  en、客户端挂载后切换（效果同 CLJS 的异步词条加载），无水合 mismatch；
  `<html lang>` 随 locale 更新。
- 与 CLJS 的有意偏差（代码注释均登记）：不做 storage `::locale`（CLJS 的本地存储位）；
  locale 变化重挂载子树会重置页面瞬态状态（CLJS 响应式重渲染不重置）；`zh-TW` 等
  浏览器标签不映射 `zh_hant`（CLJS 同样不映射）；fr 等无目录语言回退 en（CLJS 有
  全量 po）。
- 测试：vitest 881 例 / 37 文件（较 F7.3 的 871 增 10：matchLocale 4、htmlLang 1、
  目录结构 2、回退 1、active locale 2）；`pnpm typecheck`、lint 干净。
- 浏览器冒烟（:3450 + 真实浏览器，一次性账号）：Auto + zh-CN 浏览器 → 登录页即
  中文；设置页选「简体中文」保存 → `document.documentElement.lang="zh-CN"`、界面
  全中文、刷新保持、下拉回显 zh_cn；对照实验：选 English 保存后界面整体切英文
  （浏览器仍 zh-CN）→ 证明 profile 驱动；无 hydration mismatch；SES 3 条预期
  warn 不变。
- 观察/遗留：环境里既有的 error 级 React 警告（空串传给 img 的 src，每页 1 条，
  与本批无关，未处理）；通知文案在创建时定语言，切换不重译（与 CLJS 一致）。
- 下一步：F7.4 完整 API 上下文（阻塞于 F9）；i18n 如需更多语言，po 已具备，加
  `locales` 表项后重跑生成器即可。

### 7.23 本轮（2026-10-13，第二十二批：F9.1 数据基础与只读画布）

- 动机：F7.4（完整 Plugin API 上下文）阻塞于 F9 workspace。F9 最高风险，按切片
  推进：F9.1 = 只读画布切片（数据层 + 视口数学 + WASM 直绘 + /workspace 路由），
  不依赖 F8，不含 Web Worker / 协作光标 / 编辑交互；f94a–f94j 全部完成。
- 交付（均含代码注释登记偏差）：
  - `lib/file-data.ts`（85 行）：自 viewer 抽出共享件（supportedFeatures、ZERO_UUID、
    FragmentFetcher、resolvePointerMap、parseUuid、resolveFileData）；`lib/viewer.ts`
    改 re-export。
  - `lib/workspace.ts`（154 行）：`cmd("get-file")`（::rpc/auth）+ get-file-fragment
    解析 + `d/removem` 顶层 pointer 清理 + `?file-id/page-id/team-id` 解析；未知
    page-id 回退首页（CLJS 该场景重定向裸 URL，登记为偏差）。
  - `lib/workspace-viewport.ts`（412 行）：纯数学（视口三支适配 initialViewport、
    zoomBy/scrollBy/resizeViewport、wheelZoomFactor/wheelScrollDeltas/normalizeWheel
    ——移植 data/workspace 的视口与缩放、actions.cljs 滚轮语义、Facebook 归一化）。
  - `lib/workspace-store.ts`（95 行）：模块级 store（fileId/file/pageId/status +
    视口切片 zoom/vbox/vport），React 侧 useSyncExternalStore 绑定；F7.4 的
    workspace 代理将直接读它。
  - `lib/render-wasm/workspace-data.ts`（114 行）：wasm 侧加载链
    （`cmdRaw("get-file")` → `decode-str` → resolveBundlePointers → 顶层 pointer
    重建式移除），WeakMap 缓存与失败驱逐。
  - `lib/render-wasm/workspace-render.ts`（117 行）：$APP 直调封装
    （init-canvas-context、resize-canvas! arity 2、initialize-viewport、
    set-view-box、clear-canvas hard teardown）。
  - 配套小改：interop 的 KEY 增 setViewBox（$app$ 成员，探测核对）；values 的
    supportedFeatures 引用改到 file-data（随抽出）。
  - `components/workspace-wasm-canvas.tsx`（393 行）：加载链（try-init 一加三重试
    200ms）、滚轮累积器（schedule-zoom!/schedule-scroll! 语义，单 rAF flush）、
    ResizeObserver（= [vport] effect）、延迟一任务的卸载 teardown（StrictMode
    安全）、data-rendered/data-shapes 完成标记。
  - `components/penpot-loader.tsx`（30 行，自 view 页抽出共享）+ `app/workspace/
    page.tsx`（155 行）：`/workspace` 接管路由（替换 RouteStub）——AuthGuard >
    QueryParams > WorkspaceRoute：useSyncExternalStore 绑 store、同 fileId 只
    重解析、卸载 reset、`title.workspace` 标题；加载/未就绪/异常三分支
    （PenpotLoader / ExceptionPage）；`styles/workspace.css` 经 globals.css 接入；
    store 的 `error` 用 `unknown`（可能承载非 RpcError 异常，页内再收窄）；view
    页改用共享 loader（+3/-29）；词条新增 `title.workspace`（en/zh_cn/zh_hant
    各 +1 条）。
- 关键探测（`public/js/shared.js` 静态分析，探测脚本已清理）：`set_view_box` 是
  $APP 成员且自带完整交互链（view-interaction-start!、from-cache 预览、debounced
  finalize 100ms、渐进续帧）→ shell 直接调用不复刻；`render_finish`/
  `resize_viewbox` module-private，`view_interaction_end!` /
  `stop_progressive_render!` / `set_canvas_background` 被内联消除；
  `internal_frame_type` 为模块闭包变量不可写回。编译版 `cljs.core/get` 对 plain JS
  对象返回 null → vbox 一律以 CLJS PersistentArrayMap 传递（viewer F6.5 传 JS
  `{x,y}` 的潜在隐患已登记，F9.1 冒烟核对通过——见下）。
- 与 CLJS 的有意偏差（代码注释均登记）：不做 page-transition 模糊过渡 / focus
  mode / dpr watcher / position-data pass / web-unavailable modal；滚轮监听绑
  canvas 故 inside-viewport? 恒真、无条件 prevent-default；JS 链与 wasm 链为两
  次 get-file 读同一 rev；卸载 clear-canvas（hard）延迟一任务以便 StrictMode
  重放可取消（clear-canvas 注释：上下文丢失后立即重建在部分浏览器会失败）。
- 验证：vitest 40 文件 935 例全过（较上批 881 增 54：workspace-viewport 35、
  workspace 11、workspace-store 8）；`pnpm typecheck`、`pnpm lint` 干净。
- 浏览器冒烟（:3450 + 真实浏览器，一次性账号）：注册新账号 → dashboard 模板
  「UI mockup example」导入为文件「Plants-app」→ 打开 `/workspace?team-id=…&`
  `file-id=…`：canvas 就位并到达完成态（data-shapes / data-rendered 均 true，
  渐进渲染完成事件送达）；ctrl+滚轮放大：rendered 复位后回 true、144 单元
  像素指纹 90 个变化（亮度差 34.7）；普通滚轮平移：46 个变化（差 13.1）。
  vbox 以 PersistentArrayMap 传递的编组核对通过——F6.5 登记的「plain JS
  `{x,y}` 使编译版 `cljs.core/get` 返回 null」隐患在本切片不复现。
- 标题排查（冒烟首轮曾观察到 `document.title="Penpot"` 疑为偏差）：探针实验
  （主标签硬刷新 + iframe 补偿、手动改标题后再交互）证明加载时间线恒为 SSR
  的 "Penpot" → 1–2s 内切到 "Plants-app - Penpot" 且不回退、重渲染不覆盖；
  首轮观察是后台标签 rAF 冻结会话的遗留态，实现无缺陷。
- 字体 404 修复：冒烟 console 的两条错来自 `/internal/gfonts/font/…` 404——dev
  下 Next 未反代 `/internal/*`（生产由 nginx-external-locations.conf 转发
  fonts.gstatic.com）。`next.config.mjs` 增 `/internal/:path*` →
  `PENPOT_ASSETS_ORIGIN` 的 rewrite；临时 :3451 实例实测 200（191016 字节）
  后清理，用户 :3450 实例未动、重启后生效。
- 下一步：评估 F7.4（workspace 代理 + 完整 API 上下文）解锁；画布编辑交互、
  Web Worker、协作光标留 F8 后切片。

### 7.24 本轮（2026-10-14，第二十三批：F9.2 画布交互与选择）

- 动机：F9.1 只读画布之后补齐「选择与导航」层（悬停/点选/框选/平移），仍不产生
  写入；T1–T6 完成（$APP 复用面探测、命中检测库、选择语义与 store、指针/键盘
  交互、Overlay 渲染、集成验收）。
- 交付（均含代码注释登记偏差）：
  - `lib/workspace-index.ts`（1241 行）：worker 命中检测的同步移植——quadtree
    （app.util.quadtree）+ query-selection（include-frames/full-frame/ignore-groups/
    clip-children/using-selrect 全选项）+ overlaps（rect/circle/path/bool + stroke
    ring 环判定）+ clip 索引 + shapes->rect。
  - `lib/workspace-selection.ts`（546 行）：hover 栈（remove-hover?、mod no-fill
    帧过滤）、hoverShapeId、点击选择（select-shape/toggle）、框选语义
    （handle-area-selection：append=shift、remove=shift+mod、宽或高 >10/zoom 最小
    尺寸、全包）与 $APP 适配器（sort-ids/intersect-position/top-nested-frame）。
  - `lib/workspace-viewport.ts`（417 行）：+clientToWorld 别名（=pointToViewport，
    登记偏差）。
  - `lib/workspace-store.ts`（158 行）：选择/hover 切片（selection、hover、
    hoverTopFrameId、hoverShapeId、areaSelect 与动作）。
  - `components/workspace-wasm-canvas.tsx`（977 行）：指针/键盘交互层——pointerdown/
    move/up/cancel/leave、space/shift/mod/Esc/blur 全局键、rAF 合并 hover 查询、
    50ms 顶帧 debounce、5px 点击阈值、中键/空格平移累积器、指针捕获、光标
    default/pointer/grab/grabbing。
  - `components/workspace-viewport-overlay.tsx`（249 行，新）：SVG 覆盖层
    （viewBox=vbox，世界坐标直画，pointer-events none）——选择外形（rect/polygon）、
    总框 + 8 个静态方块手柄、hover 细线外框、框选虚线矩形；`styles/workspace.css`
    （54 行）色板对齐 selection.cljs。
- 关键语义（对齐 CLJS 原文）：框选起手非 append/remove 即 deselect-all；shift+mod=
  remove；mod 起手强制框选；mod 变化重查 hover（mod-str）；Esc=cancelGesture+
  clear-selection；hover 外框只画单形状（:id @hover）——store 增 hoverShapeId 由
  canvas 计算写入。
- 与 CLJS 的有意偏差（代码注释均登记）：pointerup 5px 阈值替代 DOM click
  （drag/move-selected 归 F9.3）；mod+space 平移替代 start-zooming；hover 同步 rAF
  合并替代 worker ask-buffered 流；overlay 选择与 hover 同用 accent-tertiary（组件
  高亮色未移植）、外形为 selrect/polygon 几何近似（circle→ellipse、path d 留后）、
  手柄 8/zoom 方块只渲染（CLJS 圆 + 交互）、框选虚线（CLJS 实线）且以
  --color-accent-select 代替 tertiary-muted；无双击穿透/进帧、帧标题、焦点模式。
- 验证：vitest 42 文件 998 例全过（较 F9.1 935 增 63：workspace-viewport 38、
  workspace-selection 31、workspace-index 22、workspace-store 15）；`pnpm typecheck`、
  `pnpm lint` 干净；`pnpm build` 通过（/workspace 12 kB）。
- 浏览器冒烟（:3450 + 真实后端 + 既有账号 + Plants-app 文件）：清单 1–5 全过——
  悬停出现/移出消失、点选 1 外形 + 8 手柄、shift 加选 2/反选 1、点空清空、框选
  虚线矩形 + 松开选择 3、空格与中键拖拽 viewBox 变化、Esc 清空；资源时序 +
  fetch/XHR 钩子核对全程零写请求（仅 get-profile/get-teams/get-file 等只读）。
  环境备注：窗口被遮挡致合成器停帧（rAF 停摆、截图超时），子代理以 rAF 垫片 +
  合成 Pointer 事件（setPointerCapture 打补丁）驱动，断言以 DOM/SVG 属性为准。
- 下一步：F9.3 移动/拖拽与保存（resize/rotate 手柄归 F9.5+）；Web Worker、协作光标留 F8 后。

### 7.25 本轮（2026-10-16，第二十四批：F9.3 拖动移动与保存）

- 动机：F9.1 装载链、F9.2 只读交互之后，F9.3 打开**首个写路径**——拖动形状
  实时预览、释放后持久化到后端、拖入帧自动重父级；T1–T6 完成（ABI 探测与
  封装、拖动预览、提交构建与编码、重父级、提交后同步与失败处理、冒烟与
  登记）。
- 交付（均含代码注释登记偏差）：
  - `lib/render-wasm/modifiers.ts`（244 行，新）：internal-module modifiers
    协议封装——`configureModifiers`（40B/条：4×u32 uuid + 6×f32 矩阵；alloc
    后重取 HEAPU32/HEAPF32）、`startModifiers/endModifiers/cleanModifiers`、
    `pushShapeGeometry`（_use_shape + _set_shape_selrect + path 分块
    _start/_set_shape_path_chunk_buffer/_set_shape_path_buffer）、`hasInternal`
    守卫（缺函数禁拖 + console.warn）。
  - `lib/workspace-move.ts`（744 行，新）：纯函数族——`resolveMoveSet`（子树
    展开）、`translateShape`（path/bool content 28B/段字节级平移、text
    position-data、通用 x/y/selrect/points）、`buildMoveChanges`（只发变化
    属性）、`topNestedFrameAt`（JS 模型目标帧判定，排除移动集）、
    `buildReparentChange`（mov-objects 反序 + clean-loops + 已属目标裁剪）。
  - `lib/transit.ts`（517 行）：path-data 写侧标签（读侧 "~#penpot/
    path-data" ↔ 写侧 "~b" base64）+ `encodeUpdateFile`；uuid 键修复——
    position-data 内 *-ref-id/*-ref-file/fill-image id 以键模式 + uuid 形态
    双保险重打标签（后端 malli ::sm/uuid 校验；拖动 E2E 暴露的 500 根因）。
  - `lib/rpc.ts`（468 行）：`cmdEncoded`（预编码 transit body 变体）。
  - `lib/workspace-store.ts`（189 行）：`objects`（提交后整引用替换）+
    `dragDelta`（拖动中轮廓偏移）。
  - `components/workspace-wasm-canvas.tsx`（1367 行）：拖动激活（10/zoom 世界
    阈值）、选择语义（单选/toggle/整组）、rAF 预览、pointerup 提交分派、
    Escape/pointercancel 取消、in-flight 提交门、can-edit 只读门、提交后
    wasm 几何灌入（同任务内清预览→灌入→request-render，无中间帧）。
  - `components/workspace-viewport-overlay.tsx`（277 行）：选择外形/bounds/
    手柄统一叠加 dragDelta（hover 外框不偏移）。
  - 测试：`workspace-move.test.ts`（806 行）、`render-wasm/modifiers.test.ts`
    （381 行）、`transit.test.ts`/`rpc.test.ts`/`workspace-store.test.ts`
    追加（+235/+55/+27）。
- 关键语义（对齐 CLJS 原文）：down 命中 ∈ 选择集 → 整组拖动、∉ → 单选后
  拖动、shift → toggle 后拖动；提交 = 单次 update-file（mod-obj×N +
  mov-objects? 同请求，revn=max(本地,响应)）；mov-objects 只改归属不重算
  坐标（Penpot 绝对坐标）；拖帧入自身被拒（excluded 断链回退父帧 + 已属
  目标裁剪 = no-op）。
- 与 CLJS 的有意偏差（代码注释均登记）：1）撤销（Ctrl+Z）缺失——无 undo
  栈的第一步，留后续切片；2）点击阈值 5px→10px（对齐 CLJS 10/zoom；跨阈值
  从"取消点击"变"进入拖动"）；3）DOM 分层近似——CLJS 选择框 DOM=整组、
  形状本体=单选，外壳以选择集包含关系等价复刻；4）mov-objects 省略
  `index`（尾插；按 z 序插入留后续）；5）伴随变更裁剪——hide-in-viewer/
  layout-item/组件同步未发（只发 mov-objects + mod-obj）；6）optimistic→
  pessimistic——先持久化成功后才应用（JS 模型替换 + wasm 灌入；失败天然
  还原）；7）无 websocket revn 通知——last-write-wins，无冲突合并；8）目标
  帧高亮缺失——拖动中无 ghost outline；9）drop 判定近似——release 点判定
  （CLJS 用拖动盒/形状位置），多选混合归属按简化规则。另登记：组件实例按
  普通形状处理（无 ignore-geometry）；text/组/bool 不可单独悬停点击（F9.2
  hover 层限制延伸，拖动需先命中）；跨帧重父后形状在目标帧界外时不可见
  （CLJS 同语义）。
- 验证：vitest 45 文件 1078 例全过（较 F9.2 998 增 80）；`pnpm typecheck`、
  `pnpm lint`、`pnpm translations`（en 828/828）干净；`pnpm build` 通过
  （/workspace 15.5 kB，First Load 207 kB）。
- 浏览器冒烟（:3450 + 真实后端 + Plants-app 文件）：E2E 主验证 A'/B/R1/F/R2
  + get-file 解码断言（revn 26）全过；单/多选拖动→刷新位置保持；shift
  toggle 拖动、Escape 中途取消（无提交、选择清空、revn 不动）；path 拖动
  提交→刷新 position-data 持久；拖入帧/拖出帧/拖帧入自身被拒；多选跨帧
  混合重父（非帧成员改归属 + 帧成员裁剪，文档化）；断网注入→回位 + 错误
  可见 + revn 不动，恢复后重拖成功；只读文件（DB can_edit=false）拖动被拒
  （无提交/选择空/revn 不动），恢复权限后正常拖动；F9.2 回归集复跑。多轮
  拖动-恢复轨迹 DB revn 30→40、changes 11→21，全程 revn 单调。
- 修正 §7.24 措辞：原"下一步：F9.3 移动/拖拽与手柄交互"把 resize/rotate
  手柄误归 F9.3（F9.2 计划路线图归 F9.5+，本切片不含手柄），上一句已修正。
- 下一步：手柄 resize/rotate、撤销栈、按 z 序插入、伴随变更补齐；Web
  Worker、协作光标留 F8 后。

### 7.26 本轮（2026-10-16，第二十五批：阶段 B 计划批准，无代码）

- 本轮**只出计划，零实现代码**：`backend-rust/PLAN.md`（执行计划）、`backend-rust/HANDOFF.md`
  （换机器上下文快照）、`backend-rust/README.md`（crate 划分与门禁口径重写）。
- 门禁改口径：从「`frontend-nextjs` 对应功能完成前不实现 `backend-rust`」改为
  「**实现但不接入部署**」：可写实现与测试、可本地 `cargo run`；不接 nginx/反代、不加灰度
  开关、不改 `docker/`、不改根 `package.json`/`pnpm-workspace.yaml`、不改 `scripts/ci` 现有
  target；`backend/` 仍不改一行。已同步 §0 表、§3.2 原则 1、§4 阶段 B、§5 里程碑、§7.7。
- 四项决策：web 框架 = **axum**；crate 名**不加任何前缀**（`transit/errors/config/session/db/
  storage/worker/ws/rpc`）；`transit` 值模型 = **自建 enum**；JWE 向量由用户在新机器开 devenv
  后采集（未采前 `session` 按「结构自洽、兼容性待验」交付）。
- 开工顺序定为一个关键路径：`M0 workspace → M1 transit → M2 errors+config ∥ M3 rpc(axum) →
  M4 session → M5 storage → M6 worker → M7 ws`；M8（rpc 只读命令承接）本阶段不交付。
  `transit` 排第一的理由：RPC 请求体、应答体、`task.props`、session payload 全是 transit。
- 代码实测核对出的新事实（已写入 `PLAN.md` §2）：
  - Transit+JSON 的 map 是**紧凑数组带 `^ ` 头 + `^N` 缓存**：`["^ ","~:a",1]`；vector 应答带
    `~#list`，与裸 JSON array 不同，读者两者都要接（旧机器用 `transit-js` 本地实测得到）。
  - `task.props` 是 **jsonb + transit**（`db/tjson`）而**不是 Fressian** → worker 不需要 blob 解码。
  - `file.data`/`file_data.data` blob 是 **Fressian v4/v5**（`app.common.fressian`，JVM 专有）→ 列为
    红线；连带把 `add-file-transient-changes`、binfile、files 写路径、thumbnails、nitrate 定为永久排除。
  - 会话表已是 **`http_session_v2`**（迁移 `0155-drop-http-session-table.sql` 已删旧表），而本文
    与旧 README 写的是 `http_session` → 已订正。密钥 = `HKDF(HMAC-BLAKE2b-512, salt="tokens", 32B)`。
  - RPC 实际有**三组路由**（`/api/main/methods/:name`、别名 `/api/rpc/command/:name`、
    `/api/management/methods/:name` + shared-key），本文旧版只提第一组；OpenAPI 真实路径是
    `/api/main/doc/openapi.json`（`/api/openapi` 仅重定向）。
  - `render-wasm` **没有 headless-native API**（24 处 `cfg(target_arch="wasm32")` + GL `gpu_state`），
    所以 `render-native`（原规划 B1）推迟；先抽 core 才谈得上复用。
  - 体量：`backend/src` 171 文件 / 46,151 行；`common/src` 156 CLJC / 55,433 行；RPC 189 命令
    （160 鉴权 / 29 公开；183 有 params schema，**仅 50 有 result schema**）；168 个 SQL 迁移。
- 新增支撑任务：S4（transit 金样本，用 `transit-js` **离线**生成，不需后端）、S5（JWE 兼容性
  向量，需 devenv）。仓库内无现成 JWE 样本（grep `eyJ` 无命中）。
- 旧机器环境实测（已标为分机器事实）：rustc/cargo 1.98.0；registry 走 `rsproxy.cn` 镜像（crates.io
  直连被 TLS 拦）；axum 0.8.9、tokio 1.53.1、sqlx 0.9.0、aes-kw、aes-gcm、hkdf、blake2、redis、
  proptest 等均已在本地缓存，M0–M7 可离线构建；docker/JVM/PG 不可用，所以 C1–C4 采集改到新机器做。
- 下一步：新机器跑 `HANDOFF.md` §4 自检，执行 M0 + M1（T1.1–T1.5）；devenv 起来后一次性采集
  C1–C4。本轮未动 `backend/`、`common/`、`frontend/`、`frontend-nextjs/`、`docker/`。

### 7.27 本轮（2026-10-20，第二十六批：F9.4 workspace 外壳与菜单）

- 动机：F9.3 打开首个写路径后，F9.4 把 /workspace 从「画布铺满页面」推进到可用的
  编辑器外壳——三栏布局、左头重命名、主菜单、缩放控件、Layers 面板、顶部工具栏与
  帧标题。所有外壳动作经既有 store 与画布 handle，不复制视口数学；UI 状态留在组件
  本地（review 对 AD5 的修正），store 仍只保存文件、页面对象、选择、视口与 dragDelta。
- 交付（均含代码注释登记偏差）：
  - `lib/workspace.ts`（+24 行）：`canEditFile`（从 canvas 提升，供左头与菜单共用）、
    `renameWorkspaceFile`（rename-file RPC）；测试追加 3 例。
  - `lib/workspace-layers.ts`（114 行，新）：`buildLayerTree`（按 root.shapes 原序，
    AD9）、`filterLayerTree`（名字大小写不敏感）、`visibleLayerRows`（展开/过滤后的
    行序）；12 例测试。
  - `lib/workspace-frame-titles.ts`（186 行，新）：`titleTransformUseWidth`、
    `titleTransform`（left/top/right 顶点、rotate + scale(1/zoom) + translate；零缩放或
    缺点返回 null）、`topLevelFrames`（只取根层 frame）；9 例测试。
  - `lib/workspace-viewport.ts`（+53 行）：`fitViewport(vport, srect, padding)` =
    adjustToViewport + clampZoom，零尺寸返回 null；测试追加 4 例。
  - `components/workspace-shell.tsx`（196 行，新）：318px / 1fr / 318px 三栏 grid、
    52px 头、hidden-ui 单列、单一菜单判别联合、restore 按钮与焦点迁移。
  - `components/workspace-left-header.tsx`（187 行，新）：logo、文件名双击/Enter/F2
    重命名（左头持有编辑状态，`startRename()` 暴露给主菜单）、保存勾、菜单触发按钮。
  - `components/workspace-main-menu.tsx`（265 行，新）：File/Edit/View/Help 四组
    drilldown；Rename、回 dashboard、Select all（根子节点）、Deselect all、五条缩放
    命令、Hide UI、帧标题开关、帮助链接可用；Export、版本历史、Undo/Redo、快捷键、
    About 禁用；快捷键仅展示。
  - `components/workspace-zoom-widget.tsx`（153 行，新）：百分比 + −/+；百分比菜单与
    主菜单共享 shell 的 anchor，保证同时只开一个。
  - `components/workspace-layers-panel.tsx`（238 行，新）：Layers/Assets/Tokens 三 tab、
    搜索、树行（aria treeitem/level/selected/expanded）、Shift 多选、Enter/Space、空白
    清除、no-match/empty。
  - `components/workspace-top-toolbar.tsx`（93 行，新）：move 激活；frame/rect/ellipse/
    line/arrow/text/image/path/curve 全部 disabled；只读文件整体返回 null。
  - `components/workspace-frame-titles.tsx`（101 行，新）+ overlay 接线：每个可见顶层
    frame 一个 `<g>`，foreignObject y=-11/height 20，选中 accent tertiary、未选
    #8f9da3，visibility 由 showFrameTitles 控制；标签 pointer-events none。
  - `components/workspace-right-sidebar.tsx`（25 行，新）：右栏空骨架；
    `components/workspace-icons.tsx`（175 行，新）：菜单/缩放/图层等图标。
  - `components/workspace-wasm-canvas.tsx`：`WorkspaceCanvasHandle`（zoomIn/zoomOut/
    resetZoom/zoomToFitAll/zoomToSelection，全部走 applyViewport）、
    `showFrameTitles` prop 与 memo 比较器；F9.2/F9.3 指针与提交路径未改。
  - `components/workspace-viewport-overlay.tsx`：接收 showFrameTitles 并渲染帧标题层；
    `components/dashboard-menu.tsx` + `styles/dashboard.css`：`MenuEntryItem.shortcut`
    的只读展示。
  - `styles/workspace.css`（+494 行）：三栏 grid、左头、菜单触发、Layers、工具栏、
    缩放控件、帧标题、restore 按钮。
  - 词条：`pnpm translations` 从 en.po 补齐生成文件——en +32、zh_cn +28、zh_hant +31
    条（F9.4 首次使用的既有键，无新键）。
- 关键语义：
  - 缩放命令统一走画布 handle → `applyViewport`（stateRef + set-view-box + store），
    滚轮/拖动路径不变；fit-all padding 160、fit-selected padding 40、reset 绕当前
    中心落到 zoom 1。
  - rename 由左头提交：Enter 保存、Esc/失焦取消（CLJS 失焦提交，此处按计划改为
    取消，避免误改）；失败恢复旧名并显示 errors.generic。
  - 只读：canEditFile=false 时工具栏隐藏、Rename/写类菜单禁用，选择、缩放、Layers、
    hide UI 仍可用。
  - 帧标题保持屏幕恒定字号；隐藏 frame 不渲染；无网格偏移/图标/内联编辑。
- 与 CLJS 的有意偏差（AD10 + review 修正）：
  1. 右栏是空骨架，无 options toolbox；
  2. 工具栏平铺，无 flyout、MCP/plugins、调试工具；
  3. 主菜单用 drilldown，快捷键仅展示、不安装全局处理；
  4. Select all 只选根子节点；
  5. Layers 无 hover 高亮/隐藏/锁定/重命名/排序；
  6. 帧标题无文本编辑、类型图标与网格偏移；
  7. 无侧栏 resizer 与响应式折叠；
  8. rename 失焦取消（见上）；
  9. UI 状态不入 store——review 修正 AD5，hideUI/showFrameTitles/menu 归 shell，
     layers* 归面板，viewport 归 canvas。
- 验证：`pnpm typecheck`、`pnpm lint` 干净；`pnpm test` 46 文件 1104 例全过（新增
  layers 12、frame titles 9，workspace/workspace-viewport 追加 7）；`pnpm translations`
  成功（en 860/860、zh_cn 728/860、zh_hant 844/860）；`pnpm build` 通过
  （/workspace 22.5 kB，First Load JS 215 kB）。
- 浏览器冒烟：本轮**未执行**（浏览器子代理被取消，且需要登录会话与可写/只读文件）。
  三栏、rename、菜单、缩放、Layers、帧标题、hide UI、F9.2/F9.3 回归与只读拦截均待
  补做；未测 DB revn，不据此宣称通过。
- 下一步：F9.5 绘制工具与样式面板；补浏览器冒烟（含只读文件）。

### 7.28 本轮（2026-10-22，第二十七批：F9.5 计划，无代码）

- 本轮**只出计划，零实现代码**：`.agents/plans/2026-10-22-f9-5-drawing-tools-and-style-panel.md`
  （953 行，`Status: draft`，`Review Log` 为空）。`frontend-nextjs/` 无改动，工作区只剩
  `backend-rust/` 的未跟踪文件。
- 范围（用户拍板）：绘制只做 frame/rect/ellipse 三种框类工具；右栏只做基础样式段——
  隐藏/锁定、不透明度、纯色填充（颜色/不透明度/增删）、纯色描边（颜色/宽度/不透明度/
  增删）与矩形/画板四角圆角。单选可编辑，多选显示 `inspect.multiple-selected`。
  line/arrow/text/image/path/curve 继续禁用，登记为偏差。
- 计划结构：10 个任务 + 3 个检查点——修 `PersistentArrayMap` 计数 → 绘制数学纯模型 →
  `add-obj` transit 编码 → wasm 形状上传桥 → 绘制手势端到端 → 工具栏与外壳工具状态 →
  样式模型 → `updateShapeAttrs` → 样式面板 + CSS + 词条 → 文档与全量验证。
- 只读核对得到的关键结论：
  - `add-obj` 的 `:obj` 必须通过 `schema:shape`：`selrect`/`points`/`transform`/
    `transform-inverse` 与 uuid 字段都要带 transit tag（`#rect`/`#point`/`#matrix`/
    `#shape`），frame 的 `shapes` 是 uuid vector；否则后端只报 "invalid shape found"。
  - wasm 上传不手搭 PAM：复用 transit 编码 + 既有 `decode_str`，得到 keyword 键、UUID 与
    Shape record；新增形状走 `set_object → use_shape(new) → fills/strokes →
    use_shape(parent) → set_shape_children → request_render`，不重建视口。
  - `interop.ts` 的 `PersistentArrayMap` 把条目数传成数组长度（两倍），`values.test.ts`
    与 `sizes.test.ts` 的 mock 固化了同一误解，列为任务 1。
- 有意不做：另外六种绘制工具、frame 吸收既有形状、吸附/像素网格、撤销、插入索引、
  渐变与图片填充编辑、多选批量编辑、绘制快捷键。
- 下一步：`/review-plan` 审计划后 `/implement-plan` 实施；实现完成后再补 7.29 与 F9 状态行
  的完成标记。浏览器冒烟仍未执行，F9.4 的冒烟也待补。

### 7.29 本轮（2026-10-22，第二十八批：F9.5 绘制工具与样式面板）

- 动机：F9.4 的外壳只能浏览与拖动；F9.5 打开创建与改样式的路径——在 /workspace 选
  frame/rect/ellipse 拖拽（或单击）即得真实写入文件的新形状，选中单个形状时右栏给出
  隐藏/锁定、不透明度、纯色填充、纯色描边与圆角编辑，全部经同一条 update-file 写路径
  持久化并由 wasm 立即重绘。
- 交付（均含代码注释登记偏差）：
  - `lib/render-wasm/interop.ts`（+25/-6）：`PersistentArrayMap` 的 `cnt` 改为条目数
    （数组长度 / 2），`_count`、小 map 的 assoc 分支、迭代器与 `equiv` 随之正确；
    `values.test.ts`/`sizes.test.ts` 的 `MockPAM` 同步修正；新增 `interop.test.ts`（3 例）。
  - `lib/workspace.ts`（+30）：`WorkspaceTool`、`WorkspaceDrawTool`、`isDrawTool`、
    `IDENTITY_TRANSFORM`；测试 +3 例。
  - `lib/workspace-draw.ts`（246 行，新）：`rectFromPoints`（10 屏幕像素阈值、Shift
    adjust-ratio、Alt 以起点镜像、反向拖拽归一化）、`clickRect`（100×100 居中）、
    `createDrawShape`（frame/rect/ellipse 的 schema:shape 工厂：selrect/points/transform/
    transform-inverse/parent-id/frame-id/fills，frame 另有 shapes 与 hide-in-viewer）；
    20 例测试。
  - `lib/transit.ts`（+100/-17）：`add-obj` 写路径与 tag 收口——`#shape`、`#rect`、`#point`、
    `#matrix`、uuid 字段、keyword 枚举（type、stroke-style/alignment、stroke-cap-*、
    gradient type）；`encodeShapeValue` 供 wasm 上传复用；测试 +7 例（共 20）。
  - `lib/render-wasm/shape-upload.ts`（98 行，新）：`uploadNewShape`（set_object →
    use_shape(new) → set_shape_children → request_render）与 `applyShapeStyle`
    （hidden/opacity/fills/strokes/r1..r4 入 wasm，blocked 只留编辑器）；8 例测试。
  - `components/workspace-wasm-canvas.tsx`（+347/-32）：`tool`/`onToolChange` props、
    `sendUpdateFile`（从 commitMove 抽出，revn 守卫 + 单飞）、`commitDraw`、draw 指针
    分支（阈值/Shift/Alt/单击）、`updateShapeAttrs`、绘制光标与 memo 收口。
  - `lib/workspace-store.ts`（+23/-1）：`DrawPreview` 与 `drawPreview` slice；
    `components/workspace-viewport-overlay.tsx`：虚线预览框；`styles/workspace.css`：
    预览与样式面板样式（合计 +172 行）。
  - `components/workspace-top-toolbar.tsx`（+46/-23）：move/frame/rect/ellipse 可用，
    其余六个仍 disabled；`components/workspace-shell.tsx`（+34/-12）：`activeTool` 与
    `onToolChange`，只读时回落 move；`components/workspace-right-sidebar.tsx`（+10/-6）：
    `children` 槽替换空占位。
  - `lib/workspace-style.ts`（245 行，新）：填充/描边的不可变增删改、默认值
    （#B1B2B5 / 黑 1px inner solid）、solid 判定、opacity/width/radius clamp、
    `buildStyleChange`（一次 mod-obj，每个属性一个 set）；19 例测试。
  - `components/workspace-style-panel.tsx`（650 行，新）：右栏样式面板——层开关、
    不透明度、填充、描边、圆角五段；单选可编辑，多选 `inspect.multiple-selected`，
    只读全禁用；draft + blur/Enter 提交 + Escape 恢复 + 失败回退；样式见上。
  - 词条：`pnpm translations` 补 17 个既有键（en 877/877、zh_cn 745/877、
    zh_hant 861/877；无新 en.po 键）。
- 关键语义：
  - 绘制：屏幕距离 × zoom > 10 才算拖拽，否则按单击处理；Shift 出正方形/等比，Alt
    以按下点为镜像中心；父级用 `topNestedFrameAt` + `firstValidParent`，新 frame 的
    `hide-in-viewer` 取 `parent-id !== ZERO_UUID`；add-obj 由后端追加到 parent，本地
    `applyAddShape` 完全镜像。绘制结束后工具回落 move（CLJS clear-drawing）。
  - 写路径：样式与绘制共用 `sendUpdateFile` 的 revn 守卫与 `commitPending` 单飞；失败
    `setWorkspaceState({ error })` 且不改模型；wasm 推送在成功之后，wasm 失败只 warn。
  - 样式：fill/stroke 新增一律前插；按 index 删除；非 solid 行只读但可删；圆角四值
    一次性提交；opacity 0..1、width/radius >= 0；circle 不发 radius。
- 与 CLJS 的有意偏差（AD12）：三种框类工具；frame 不吸收既有形状；无吸附/像素网格/
  grow-type；无撤销事务；新形状追加到尾部（无插入索引）；不自动编号（Rectangle/
  Ellipse/Board 重复）；样式面板只做基础段，渐变/图片只读可删；圆角无单角切换；绘制后
  工具回 move、无快捷键；无尺寸/位置、布局、约束、阴影、模糊、导出；多选不批量编辑。
- 验证：`pnpm test` 50 文件 1165 例全过（新增 4 个测试文件 50 例，既有文件 +11 例）；
  `pnpm typecheck`、`pnpm lint` 干净；`pnpm translations` 成功（en 877/877）；`pnpm build`
  通过（/workspace 26.5 kB，First Load JS 221 kB）。
- 浏览器冒烟：本轮**未执行**（无可用登录会话）。待补清单：三种工具拖拽/单击/Shift/
  Alt/取消；绘制后工具回落；重载后形状仍在；填充/描边增删改与圆角重载后一致；隐藏/
  锁定生效；只读文件全禁用；F9.2/F9.3 回归。
- 下一步：先补浏览器冒烟；再做 resize/rotate 手柄、撤销栈与 z-order 插入（7.25 路线），
  然后是 F7.4 workspace 插件代理。F9 已无排期中的下一片。

### 7.30 本轮（2026-10-23，第二十九批：F9.6 resize/rotate 手柄）

- 动机：F9.5 只能创建形状与改样式，选中后无法改变尺寸或角度。F9.6 让覆盖层的八个
  缩放手柄与四个旋转区变成真实手势：拖动边/角时沿反方向固定点缩放，拖动角外旋转区
  时绕选择中心旋转；Shift 锁比例、Alt 以中心缩放、mod 吸附 45°、Shift 吸附 15°。
  释放经同一条 update-file 写路径落盘，wasm 立即重绘。
- 交付（均含代码注释登记偏差）：
  - `lib/workspace-transform.ts`（917 行，新）：矩阵工具（multiply/translate/scale/
    rotate/inverse、点变换、矩阵 record、SVG 字符串）、`selectionGeometry`（单选
    selrect + center-wrapped transform；多选旋转点并集 + identity）、`frameCorners`、
    `resizeHandlePoints`、`rotationZonePoints`、`resizeGesture`（handler 乘数/固定点、
    局部化、noZeros、Shift/比例锁、Alt 中心）、`rotateGesture`（0..360 归一、45/15
    吸附）、`applyTransformToShape`（apply-transform-generic：flip 点积、hypot
    selrect、calculate-transform、rotation 增量、path/bool 走 content）、
    `transformPathBytes`、`buildTransformChanges`、`applyTransformSet`。
  - `lib/workspace-transform.test.ts`（655 行，新）：矩阵、选择框、手柄布局、缩放、
    旋转、apply-transform、路径字节、变更与模型替换，40 例。
  - `lib/workspace-store.ts`（+30/-1）：`TransformPreview` 与 `transformPreview` slice；
    测试 +4 例（初值、写入、复位、通知），既有 reset 用例监听次数 6→7。
  - `components/workspace-viewport-overlay.tsx`（269 行改动）：`selectionGeometry` 驱动
    的选择框；8 个 `pp-overlay-handle-<handler>` 手柄（8/zoom）与 4 个 `pp-overlay-rotate`
    旋转区（20/zoom）；`onResizeStart`/`onRotateStart` props；轮廓与选择框按 preview
    矩阵绘制；只读、无几何或手势进行中时不渲染手柄。
  - `components/workspace-wasm-canvas.tsx`（+374）：`resize`/`rotate` 交互模式、
    `gestureRef` 桥（overlay 的 pointerdown → canvas）、pointer capture、rAF 合并的
    `configureModifiers` + store 预览、修饰键跟随（pointermove + keydown/keyup）、
    释放一次提交、Escape/pointercancel 复位、只读与 ABI 门控、提交成功后的模型替换
    与索引重建。
  - `styles/workspace.css`（39 行改动）：手柄 `pointer-events: all`、
    `touch-action: none` 与八向 cursor；旋转区透明命中面 + crosshair。
  - `lib/render-wasm/shape-upload.ts`（+24/-1）：`uploadShapeGeometry`（每个形状一次
    `set_object`，循环后一次 `request_render`）；测试 +3 例（共 11）。
  - `lib/workspace-move.ts`（5 行改动）：导出 `sameValue`，供变换 diff 复用。
- 关键语义：
  - 预览：按下即写入 identity 预览（手柄立即隐藏），之后每帧用同一世界矩阵驱动 wasm
    modifier 与覆盖层；缩放矩阵是 `tf·T(o)·S·T(-o)·tf⁻¹`（Alt 时 o 取选择框中心），
    旋转矩阵是 `T(c)·R(θ)·T(-c)`。
  - 提交：释放点重算最后一帧；identity 矩阵、空修改集与单飞冲突都不发请求；每个形状
    一条 mod-obj（只带变化的属性）；成功后 `applyTransformSet` 替换模型、重建索引，
    并以 `end_modifiers + clean_modifiers + set_object` 在同一任务交接给 wasm；失败
    只报错并复位预览。
  - 取消：Escape 与 pointercancel 都复位 modifier 与预览且不动 revn；Escape 仍清空
    选择（CLJS interrupt + deselect-all）。
- 与 CLJS 的有意偏差（AD6）：同一世界矩阵作用于选择集及其子树，不做 frame 内约束/
  布局传播；text 不参与；无吸附参考线/像素网格/grow-type/图片填充边界/文本缩放/双轴
  翻转 UI；侧边手柄画小方块而非长条；手柄 cursor 不随 flip 旋转；手势期间手柄隐藏。
- 验证：`pnpm test` 51 文件 1209 例全过（含新增 `workspace-transform.test.ts` 40 例与
  store/shape-upload 的新用例）；`pnpm typecheck`、`pnpm lint` 干净；
  `pnpm translations` 成功（en 877/877）；`pnpm build` 通过（/workspace 29.9 kB，
  First Load JS 224 kB）。
- 浏览器冒烟：本轮**未执行**（无可用登录会话）。待补清单：八个手柄的边/角缩放与
  反向固定点；Shift 锁比例、Alt 中心；四角旋转与 mod/Shift 吸附；多选整体缩放/旋转；
  只读文件无手柄；重载后几何一致；Escape/pointercancel 不落盘；F9.2–F9.5 回归。
- 下一步：撤销栈；z-order 插入；伴随变更（hide-in-viewer/layout-item/组件同步）；
  浏览器冒烟；最后是 F7.4 workspace 插件代理。

### 7.31 本轮（2026-10-23，第三十批：F9.7 撤销/重做）

- 动机：F9.3–F9.6 的写路径都已落盘，却无法回退（§7.25 已登记「撤销缺失」）。F9.7
  补客户端撤销栈：每次提交自动记录一条可反转的 update-file；Ctrl/Cmd+Z 撤销，
  Ctrl/Cmd+Shift+Z（Windows 另加 Ctrl+Y）重做；主菜单 Undo/Redo 同步可用状态。
- 交付（均含代码注释登记偏差）：
  - `lib/workspace-undo.ts`（256 行，新）：`UNDO_LIMIT = 50`；`UndoState { entries, index }`
    （-1 为空）；`pushUndo`（截断 redo 分支、超限丢最旧）；`undoStep`/`redoStep`；
    `invertChanges`（从提交前模型派生反向：mod-obj 倒序写回旧值、add-obj → del-obj、
    mov-objects 按旧父分组、整体倒序遍历）；`applyUpdateChanges`（mod/add/del/mov 本地
    重放，mov 复用 `applyReparent`，del 递归删子树并脱离父 children）。
  - `lib/workspace-undo.test.ts`（313 行，新，15 例）：游标与截断、50 上限、mod 旧值
    倒序、add→del、mov 分组、del 无逆、本地重放（mod/add/del/根级删除/mov）与 move
    round-trip。
  - `lib/transit.ts`（+18/-1）：`UpdateFileDelObjChange`（type/page-id/id）、union 成员与
    `del-obj` 编码；`transit.test.ts` +1 例。
  - `lib/render-wasm/shape-upload.ts`（+67）：`uploadChangedShapes`——先对受影响父级
    `use_shape` + `set_shape_children`，再对仍存在的 shape `set_object`，最后一次
    `request_render`；测试 +5 例（mod/add/del/mov/缺失形状）。
  - `lib/workspace-store.ts`（+17/-2）：`canUndo`/`canRedo` 与 `setUndoAvailability`
    （值不变时不发通知）；`workspace-store.test.ts` +2 例，reset 用例补两字段并把
    通知数 7→8。
  - `components/workspace-wasm-canvas.tsx`（+129/-1）：`undoRef` 栈与 `historyRef` 命令；
    `sendUpdateFile(changes, recordUndo = true)` 在**请求前**从旧模型反转换（无法反转的
    提交不落盘），成功后 push；`WorkspaceCanvasHandle` 增 `undo`/`redo`；加载 effect
    起点重置栈；`performHistory` 发送 → 本地重放 → wasm 同步 → 移动游标 → 恢复选择/
    清悬停；快捷键与 cleanup（清栈并把菜单置灰）。
  - `components/workspace-main-menu.tsx`（+13/-8）：Undo/Redo 接 canvas handle，按 store
    的 `canUndo`/`canRedo` 禁用，快捷键标签 Cmd/Ctrl+Z 与 Shift+Z。
- 关键语义：
  - 一次提交一条目：移动+重父级、一次绘制、一次样式修改、一次变换各一条；零变更、
    请求失败与单飞冲突不记录；新提交截断 redo 分支；最多 50 条。
  - undo/redo 各发一次 update-file（`recordUndo = false`），成功后本地重放同一 changes，
    再 `uploadChangedShapes` 交给 wasm；失败只报 store error，栈、模型与选择不动。
  - 选择：撤销回到提交前选择，重做回到撤销前的选择（undo 成功时写入 `selectionAfter`）；
    已删除的 id 被过滤；悬停状态清空。
  - 删除的 wasm 同步：render-wasm 没有删除 API，`del-obj` 靠父 `children` 移除后
    `request_render` 停止绘制；根级形状同样从 ZERO_UUID 根的 children 脱离。
- 与 CLJS 的有意偏差（代码注释均登记）：1）栈按页面加载持有，切换页面/重载即清空，
  不是文件级全局栈；2）无 undo transaction/group（F9 写路径都是离散提交）；3）
  `selection-after` 在撤销时记录，而非提交时。
- 验证：`pnpm test` 52 文件 1232 例全过（新增 `workspace-undo.test.ts` 15 例，既有文件
  +8 例）；`pnpm typecheck`、`pnpm lint` 干净；`pnpm build` 通过（/workspace 31.3 kB，
  First Load JS 225 kB）。
- 浏览器冒烟：本轮**未执行**（无可用登录会话）。待补清单：移动/绘制/样式/变换各自
  撤销与重做；多步撤销后新编辑截断 redo；51 步后最旧条目丢弃；撤销删除后形状从画布
  消失、重做恢复；选择恢复；只读文件不产生条目；F9.2–F9.6 回归。
- 下一步：z-order 插入；伴随变更（hide-in-viewer/layout-item/组件同步）；浏览器冒烟；
  最后是 F7.4 workspace 插件代理。

---

### 7.32 本轮（2026-10-23，第三十一批：F9.8 z-order 插入）

- 动机：§7.25 AD8 与 §7.29 AD12.5 都登记了「插入位置省略 index、追加尾部」，
  CLJS 的 bring-forward/front/backward/back 四条命令因此缺失；F9.7 的 mov 反转还
  按旧父批量尾插，撤销会丢失层叠位置。F9.8 补齐 index 全链路与四条命令。
- 交付（均含代码注释登记偏差）：
  - `lib/workspace-order.ts`（96 行，新）：`insertChildren` 逐步镜像
    `app.common.data/insert-at-index`：split-at 钳制 index → 前后两半移除 incoming
    → before + incoming + after（index 0 为底层、尾部为顶层）；
    `buildVerticalOrderChanges` 镜像 `vertical-order-selected` 的快照索引：`:top`
    = count、`:up` = current+2、`:down` = max(0, current-1)、`:bottom` = selection
    内序号；每个 shape 一条 mov-objects，带 index。`workspace-order.test.ts`
    （110 行，新，9 例）。
  - `lib/transit.ts`（+16/-8）：add-obj 与 mov-objects 各加可选 `index`；编码走
    `keywordMap`（undefined 自动丢弃），append 仍不带键；`transit.test.ts` +2 例。
  - `lib/workspace-draw.ts`（+14/-4）：`applyAddShape` 增可选 index（id 已存在则
    不动）；`workspace-draw.test.ts` +1 例。
  - `lib/workspace-move.ts`（+15/-7）：`applyReparent` 增可选 index；同父重排由
    insertChildren 先移除再插入，与 process-change 一致；`workspace-move.test.ts`
    +2 例（跨父插入、同父重排）。
  - `lib/workspace-undo.ts`（+46/-17）：`applyUpdateChanges` 的 add-obj/mov-objects
    传 index；`invertChanges` 的 mov 改为每个 shape 一条，带旧父与旧 index，按旧
    父/索引升序输出（批量尾插会丢层叠）；`workspace-undo.test.ts` +3 例（含同父
    z-order round-trip 与多 shape 堆叠恢复）。
  - `components/workspace-wasm-canvas.tsx`（+67）：`orderRef` 与
    `WorkspaceCanvasHandle.orderSelection`；`performOrder` = 构建 changes →
    `sendUpdateFile`（一条撤销）→ 本地重放 → `uploadChangedShapes`；Ctrl/Cmd+↑/↓
    与 Shift 变体（idle、非表单、只读不响应）；cleanup 清命令引用。
  - `components/workspace-main-menu.tsx`（+38/-5）：Edit 组在 Undo/Redo 后加分隔线
    与四项（Bring forward / Bring to front / Send backward / Send to back），标签
    用 `workspace.shape.menu.*`，快捷键用
    `commandToTooltip("command[+shift]+up/down")`，`!canEdit || !hasSelection` 禁用。
  - `lib/translations/*.ts`（各 +4）：`pnpm translations` 重新生成（en 877→881）。
- 关键语义：
  - index 0 = 父 children 最底层，append = 顶层；`insert-at-index` 先 split 再移除
    待插 id，所以同父重排的 index 按移动前的列表解释（CLJS 的 `:up` 用 current+2
    正是如此）。
  - 四条命令与 CLJS 一致：Top/Bottom 一次跨越全部兄弟，Forward/Backward 只交换一
    格；多选 Bottom 按选择顺序自底向上保留相对次序；已到极限时仍发一条 no-op
    change（CLJS 也不比较位置）。
  - 撤销：mov 反向按每个 shape 的旧 index 恢复，[A,B,C,D] 移走 B、D 后撤销回到
    [A,B,C,D]；同父 z-order 重排也可逆。
  - 绘制仍尾插：CLJS 普通帧的 drop-index 为空（只有 flex/grid 计算），因此这与
    CLJS 一致；add-obj 的 index 通道留给后续布局切片。
- 与 CLJS 的有意偏差（代码注释均登记）：1）父级缺失的 shape 直接跳过（CLJS 会发
  nil parent 的 change 由后端丢弃）；2）z-order 命令不进 undo transaction（F9.7 的
  一请求一条目已覆盖）；3）settings/shortcuts 页面尚未登记 workspace 命令，主菜单
  内联标签为准。
- 验证：`pnpm test` 53 文件 1249 例全过（新增 17 例）；`pnpm typecheck`、`pnpm lint`
  干净；`pnpm build` 通过（/workspace 31.8 kB，First Load JS 226 kB）。
- 浏览器冒烟：本轮**未执行**（无可用登录会话）。待补清单：四条命令的层叠变化与
  wasm 重绘；同父/跨帧撤销与重做；多选 Bottom；只读文件不响应；F9.2–F9.7 回归。
- 下一步：伴随变更（hide-in-viewer/layout-item/组件同步）；浏览器冒烟；最后是 F7.4
  workspace 插件代理。

---

### 7.33 本轮（2026-10-23，第三十二批：F9.3 伴随变更）

- 动机：§7.25 AD5 登记了 generate-relocate 的伴随变更缺失——移动只发 mov-objects 与几何
  mod-obj，帧入帧不隐藏、离开 flex/grid 不清理 layout-item、组件实例进出的
  component-root 不维护。本轮补齐四类伴随变更（关闭 AD5），并让撤销与 transit 支持它们。
- 交付（均含代码注释登记偏差）：
  - `lib/workspace-component.ts`（151 行，新）：`isRootShape`/`isInComponentCopy`/
    `isInstanceRoot`/`isSubinstanceHead`/`getInstanceRoot`/`getChildHeads`/
    `getChildrenIdsWithSelf`/`componentsNestingLoop`；`isInstanceHead` 复用
    `workspace-selection`；walks 带 visited 集防环。
  - `lib/workspace-layout.ts`（190 行，新）：flex/grid/行列/auto/fill/absolute 谓词、
    `changeHSizing`/`changeVSizing`、`layoutItemAttrsToRemove`（9 属性 + 条件 h/v
    sizing）、`LAYOUT_ITEM_TOKEN_KEYS` 与 `unapplyLayoutItemTokens`。
  - `lib/workspace-relocate.ts`（206 行，新）：`OperationList` 按 shape 汇总 set 操作；
    `childrenAfterMove` 复刻 mov 后的子列表；`buildRelocateChanges` 按 generate-relocate
    顺序生成 layout-item/token → hide-in-viewer → component-root → sizing → mov-objects。
  - `lib/workspace-move.ts`：`reparentRoots` 补 copy 父、absolute 同父、layout 帧三条
    清理分支；新增 `isValidMove`（形状存在、目标不在子树、组件嵌套环、双侧非 copy）；
    `applyReparent` 改为全有或全无；删除 `buildReparentChange`（drop 统一走 relocate）。
  - `lib/workspace-undo.ts`：`invertChanges` 对旧模型缺失属性输出 `val: null`；
    `applyUpdateChanges` 把 null 当删除（后端 set-shape-attr 的 dissoc），缺失属性
    no-op。撤销 relocate 提交时 hide-in-viewer/component-root 会真正删除。
  - `lib/transit.ts`：`KEYWORD_VALUE_KEY` 增 `layout-item-h-sizing`/
    `layout-item-v-sizing`，枚举按关键字发送（后端 ::sm/one-of）。
  - `components/workspace-wasm-canvas.tsx`：`commitMove` 生成 relocate 并随同一请求发送；
    本地模型用 `applyUpdateChanges` 应用；relocate 非空时 wasm 走 endModifiers +
    cleanModifiers + uploadChangedShapes（先父 children 再 set_object），空时仍走几何增量。
  - 测试：`workspace-component.test.ts`（155 行，9 例）、`workspace-relocate.test.ts`
    （388 行，15 例）；`workspace-move.test.ts` 净增 6 例（清理分支、isValidMove、全有或
    全无）；`workspace-undo.test.ts` +3（nil 反向、nil 删除、relocate round-trip）；
    `transit.test.ts` +1（枚举与 nil round-trip）。
- 关键语义：
  - hide-in-viewer 只给「帧根、目标非 ZERO、目标本身是帧」的移动置 true；已为 true 不
    重发。
  - layout-item 仅在目标不是 flex/grid 时清理：删除存在的 9 个属性；applied-tokens 只删
    `layout-item-min/max-w/h` 与 `m1..m4`，其余保留；shape 自身是布局且该轴非 fill 时
    保留 h/v sizing（嵌套布局仍受父级约束）。
  - sizing：父级集合 = 目标 + 每个 root 的旧父（去重）；children 用移动后的列表，子属性
    读原始模型。`changeHSizing` 过滤绝对/隐藏子（列 every?、行 some）；`changeVSizing`
    不过滤（列 some、行 every?）；空列表的 every? 为 true——均为 CLJS 原样。
  - 组件：目标在实例内（`getInstanceRoot` 非空）→ 移动子树逐 shape 删 component-root；
    目标在实例外 → `getChildHeads` 补 true（含自身，遇 head 停止）。两分支互斥。
  - `isValidMove` 对齐后端：目标在子树内、components-nesting-loop、旧父或目标为 copy 时
    整体拒绝；roots 先过滤再生成伴随变更，避免后端丢 mov 后留下脏伴随。
  - mov-objects 始终最后，roots 反序，不带 index（尾插）。
- 与 CLJS 的有意偏差（代码注释均登记）：1）swap-slot 未做（touched group 尚未编码）；
  2）空组清理/mask/detach/deroot/reroot 未发——detach 在 CLJS 不可达，deroot/reroot
  与两条 component-root 规则等价；3）constraints、grid cell、blocked、variant、
  resize-parents 仍留给后续切片；4）每个 shape 一条 mod-obj 代替 update-shapes 聚合
  （操作互不重叠）；5）isValidMove 预过滤与 applyReparent 全有或全无是有意收紧。
- 已知限制：drop 仍无 index，布局内的直接子级拖放按尾插解释（CLJS 会传 drop-index）；
  布局重排因此可能改变层叠，待 drop-index 切片。
- 验证：`pnpm test` 55 文件 1283 例全过（本轮 +34）；`pnpm typecheck`、`pnpm lint`
  干净；`pnpm build` 通过（/workspace 33.1 kB，First Load JS 228 kB）。
- 浏览器冒烟：本轮**未执行**（无可用登录会话）。待补清单：帧拖入帧后 viewer 隐藏；
  拖出 flex 后 layout-item 属性与 token 消失；flex 父/子 sizing 翻 fix；组件实例内外
  拖动后的 component-root 与图层结构；撤销/重做上述四类；只读文件不响应；F9.2–F9.8 回归。
- 下一步：drop-index（布局内插入与重排）；浏览器冒烟；最后是 F7.4 workspace 插件代理。

### 7.34 本轮（2026-10-23，第三十三批：drop-index）

- 动机：§7.33 留下一条已知限制：drop 仍无 index，布局内的直接子级拖放按尾插解
  释，重排会改变层叠结构。本轮接入 CLJS 的 drop-index（flex 布局的插入槽），让拖入
  与绘制都按指针位置插入，并让同父重排走 mov-objects 的 index 分支。
- 交付（均含代码注释登记偏差）：
  - `lib/workspace-drop.ts`（119 行，新）：`dropIndexForFrame(objects, frameId,
    point)`，仅 flex；按子形状主轴中心切分单行流，正常方向映射 `listIndex + 1`、
    末端映射 0，反向（`row-reverse`/`column-reverse`）映射 `listIndex`、末端映射
    children 数；隐藏与 absolute 子形状不参与流，但仍占列表槽位。
  - `lib/workspace-relocate.ts`：`buildRelocateChanges` 增第 5 参 `dropIndex`
    （默认 null）；`childrenAfterMove` 对同父用 `insertChildren` 得到重排后的子列表
    （sizing 计算因此看到真实顺序）；mov-objects 在 index 非空时带 `index`。
  - `lib/workspace-move.ts`：`applyReparent` 的无 index 分支改按 helpers.cljc 的
    `append-at-the-end`（已存在则保持原位），修掉同父无 index 时父列表重复 id 的
    旧隐患，与后端一致。
  - `components/workspace-wasm-canvas.tsx`：`commitMove` 以释放点调用
    `dropIndexForFrame` 并随 relocate 发送；`commitDraw` 增按下点参数，flex 父时把
    同一 index 写进 add-obj 与本地 `applyAddShape`（对应 CLJS box/curve/line 的
    initial 点取 index）。
  - 测试：`workspace-drop.test.ts`（172 行，7 例：正常/反向/行列、中心边界、
    hidden/absolute、selrect 回退、缺失与无几何）；`workspace-relocate.test.ts` +1
    （mov 带 index）；`workspace-move.test.ts` +1（同父无 index 保持原位）。
- 关键语义：
  - 主轴：`row`/`row-reverse` 用 x，`column`/`column-reverse` 用 y；中心优先取
    selrect，缺失时用 x/y + width/height。
  - 槽位：按中心升序取第一个 `center >= pointer` 的流子形状；正好落在中心归前半
    （与 CLJS seek 先命中 start-half 一致）。无命中时正常方向回 0（列表头），反向回
    children 数（列表尾）。
  - 空流（无子、全隐藏/absolute、全无几何）与非 flex 返回 null，调用方保留尾插。
  - index 按 `parent.shapes` 完整列表计数，因为 insert-at-index 操作该列表；CLJS
    的 enumerate 基于去 hidden 后的列表。
- 与 CLJS 的有意偏差（代码注释均登记）：1）只做单行主轴，wrap 多行、gap 半区、
  帧旋转/翻转（CLJS 用 transform-inverse 转点）与 grid 的 drop-cell 未做；2）绘制
  与拖动的 index 都取世界轴，旋转帧按轴对齐近似；3）多选 roots 仍按选择顺序，
  CLJS 的 order-by-indexed-shapes 未引入。
- 已知限制：grid 同父重排仍无 cell/index，退化为保持原位（不再重复 id）；旋转帧内
  的插入槽可能偏移；浏览器插入指示线尚未绘制（CLJS 有 drop overlay）。
- 验证：`pnpm test` 56 文件 1292 例全过（本轮 +9）；`pnpm typecheck`、`pnpm lint`
  干净；`pnpm build` 通过（/workspace 33.4 kB，First Load JS 228 kB）。
- 浏览器冒烟：本轮**未执行**（无可用登录会话）。待补清单：flex row/column 与反向
  方向拖入子形状到不同槽位；同父直接子级拖放重排（层叠与视觉一致）；绘制 rect/
  ellipse/frame 到 flex 不同槽位；非 flex/空布局仍尾插；撤销/重做插入与重排；
  只读文件不响应；F9.2–F9.8 与 §7.33 伴随变更回归。
- 下一步：浏览器冒烟；grid drop-cell 与插入指示线（如需）；最后是 F7.4 workspace
  插件代理。

---

### 7.35 本轮（2026-10-26，第三十四批：属性面板样式不生效）

- 问题：样式面板改不透明度或点隐藏后，面板与 store 立即变化，画布像素不动。
- 定位（运行时取证，非推断）：Playwright 打开文件、画矩形、改不透明度 40、点隐藏，
  同时记录控制台与画布截图 sha1。面板值 40、按钮文案变「显示」，画布 hash 完全
  不变，无 `role="alert"`。控制台给出真因：
  `render-wasm: $APP["$app$render_wasm$api$set_shape_opacity$$"] is not a function`
  （hidden 与 children 的两条同理）。
- 根因：`$APP` 是 shadow-cljs 的选择性导出对象。本构建里
  `set_shape_children`、`set_shape_fills`、`set_shape_strokes`、
  `set_shape_opacity`、`set_shape_hidden`、`set_shape_corners` 只有顶层 var
  （`public/js/shared.js` 里是 `var $app$render_wasm$api$xxx$$=function(...)`），
  没有 `$APP.<key>=` 导出赋值；`set_object`、`use_shape`、`request_render`、
  `decode_str`、`uuid_parse` 有。`interop.call` 因此抛错，调用方 catch 成
  `console.warn`，文件与本地模型都已接受改动，只有 wasm 侧没收到。
- 修复（`lib/render-wasm/shape-upload.ts` 三条路径统一走 `set_object`）：
  - `applyShapeStyle(app, shape, attrs)`：整条已合并的 shape 重传。`set_object`
    的 base props 含 opacity/hidden/r1..r4，host attrs 含 fills/strokes，一次 FFI
    覆盖全部样式字段；不再需要逐项 setter。
  - `uploadNewShape(app, shape, parentShape)`：新 shape 一条，父记录一条（父的
    children 列表随记录写入），再用 request_render 收尾。根父在模型里没有记录时
    跳过第二条。
  - `uploadChangedShapes`：父节点改为整条 `set_object(after[parentId])`，并把
    已在父集合里的 id 从 shapes 集合移除，避免重复写。
  - `interop.ts` 删除六个未导出的 KEY，注释改为记录实测结论；`useShape` 也一并
    删除（改后无消费者）。`cljsValue` 与其测试随细粒度 setter 一起移除。
  - `workspace-wasm-canvas.tsx`：`updateShapeAttrs` 把 `nextShape` 传给
    `applyShapeStyle`；`commitDraw` 传 `next[parentId]` 而非 children 数组。
  - 测试：`shape-upload.test.ts` 改为只 stub `set_object`/`request_render`，断言
    调用序列与 payload（新 shape、父 children、样式整条重传、blocked-only 不写）。
- 验证：`pnpm test` 56 文件 1293 例全过；`pnpm typecheck`、`pnpm lint` 干净；
  `pnpm build` 通过（/workspace 33.3 kB）。浏览器复测：改不透明度 40 后 +120ms
  画布 hash 已变（`6165bb3c5238 → 7741f6d1444d`），点隐藏再变
  （`→ e03623124235`），无 alert、无 wasm 报错；新画的矩形也可见。
- 已知限制（既有，未随本轮扩大）：画布没有 Delete 快捷键；撤销「在根下新增」时
  父为页面根，不在 objects 模型里，`uploadChangedShapes` 无法写根 children，被删
  形状可能残留在画布上。两件都属 F9.5/F9.7 的后续补齐项。
- 与 CLJS 的有意偏差：CLJS 的增量路径 `set-wasm-attr!` 逐 key 调细粒度 setter，
  本实现改为整条记录重传。代价是每次样式提交多序列化一个 shape；当前面板在
  blur/Enter 提交，不是连续拖动，开销可接受。好处是不依赖未导出的 FFI。

### 7.36 本轮（2026-10-26，第三十五批：F9.9 尺寸/位置与阴影模糊）

- 目标：右栏样式面板从「不透明度/填充/描边/圆角」扩到「尺寸/位置/旋转 + 阴影 +
  模糊」。F9.9 分三批，本批为第一批（单形状）；布局/约束第二批，多选批量第三批。
- 新增 `lib/workspace-geometry.ts`（17 例）：`geometryOf` 给出面板读数
  （x/y 取 points 包围盒左上，宽高取 selrect，rotation 取存储值），
  `geometryEditable` 用 `isTransformableShape` 与 selrect 双重门禁，
  `buildGeometryChange` 按「绕 selrect 中心旋转 → 以 points[0] 为定点做世界轴缩放 →
  平移落到目标 x/y」合成一个世界矩阵，再走 `transformShapePatch` 与
  `buildStyleChange`，目标与现状相同则返回 null。
- `lib/workspace-style.ts` 增阴影/模糊纯函数（该文件测试 32 例）：
  `shadowsOf`/`addShadow`（前插，默认 drop-shadow、黑 0.2、4/4、blur 4、spread 0）、
  `removeShadow`、`withShadowNumber/Style/Hidden/Color/Opacity`、
  `shadowsPatch`（空列表 → null）、`blurOf`/`addBlur`/`withBlurValue`/`withBlurHidden`。
  值都夹在 `schema:shadow` 与 `schema:blur` 范围内，颜色只改嵌套 `color`/`opacity`
  并保留 refs。
- 写路径语义：`set` 的 val 为 null 等于删除属性（后端
  `ctn/set-shape-attr` 的 dissoc）。删最后一个阴影、删模糊都发 null；
  `workspace-wasm-canvas.tsx` 的 `updateShapeAttrs` 本地合并同步改成「null/undefined
  即 delete」，否则模型里会留 null 键。
- `applyShapeStyle` 的白名单补 `shadow`/`blur`（含 null）：不补的话阴影与模糊只进
  模型不进画布。新增 2 例断言 `drop-shadow` 以关键字出线、nil 删除仍重传整条记录
  （`shape-upload.test.ts` 19 例）。
- `lib/transit.ts` 的 `KEYWORD_VALUE_KEY` 加 `style`：阴影的 `:style` 是枚举，
  留字符串会被后端 `::sm/one-of` 拒。
- 画布句柄增 `updateShapeGeometry(id, target)`：门禁 → 构 change（null 直接成功）
  → `sendUpdateFile` → 重读模型后 `applyUpdateChanges` → 更新 objects/index/store →
  `uploadShapeGeometry`（整条 set_object）。
- 面板：`run` 泛化为接受 action，新增 `commitMeasureDraft` 走几何句柄；新增
  尺寸块（W/H/X/Y/Rotation 两列网格，rotation −359..359，单位 °）、阴影段
  （标题 + 加号；每行 style 下拉、隐藏勾选、删除，其下颜色/不透明度/偏移/模糊/
  扩展 6 格）与模糊段（无值时给加号；有值时值 + 隐藏 + 删除）。
- 配套：`styles/workspace.css` 增 `.pp-workspace-style-grid`、`--shadow`、
  `-shadow-head`、`-select`、`-check`、`row--blur` 与 disabled 态；
  `pnpm translations` 重新抽取（901 键，en/zh_cn/zh_hant 同步）。
- 与 CLJS 的有意偏差：measures 无比例锁、帧预设与布局禁用；阴影一行一条并带
  样式下拉（CLJS 是折叠行）；模糊只有 layer blur（background-blur 属新渲染开关）；
  多选仍只显示提示文案。尺寸块对 text/svg-raw/blocked 类型隐藏，因为本切片不重算
  position-data。存储 rotation 归一在 [0,360)，输入框仍取 −359..359。
- 验证：`pnpm test` 57 文件 1325 例全过；`pnpm typecheck` 退出 0；`pnpm lint`
  无告警；`pnpm build` 通过（/workspace 35.5 kB，First Load JS 230 kB）。
  本轮未做浏览器复测。
- 已知限制：布局/约束/网格/导出段仍未实现；阴影逐条编辑，无「全部移除」按钮；
  文本与 svg-raw 的几何只读；多选批量编辑在第三批。
- 下一步：第二批做布局与约束段（含 flex 子项的定位/尺寸禁用规则），第三批做
  多选批量编辑。

### 7.37 本轮（2026-10-26，第三十六批：F9.9 布局/约束段与多选批量编辑）

- 目标：F9.9 的第二、三批。样式面板补「布局」「布局项」「约束」三段，并把多选的
  「N selected」提示换成批量编辑面板。
- 新增 `lib/workspace-layout-attrs.ts`（27 例）：枚举表与属性清单照
  `common/.../types/shape/layout.cljc` 的 `layout-attrs` / `layout-child-attrs` 抄；
  `layoutValues` 按 `initial-flex-layout` / `initial-grid-layout` 补默认值，缺键的
  记录也读出编辑器会创建的值。`layoutPatch` 建 flex/grid 初始值，
  `removeLayoutPatch` 把全部键发 null。`gapPatch` / `paddingPatch` / `marginPatch`
  每次发完整 map，`trackPatch` / `tracksPatch` 管 grid 轨道。约束面：
  `constraintsOf` 按 `default-constraints-h/v` 取值（父为 frame → left/top，否则
  scale），`inFrameForConstraints` 用 parent-id ≠ ZERO_UUID 判断，
  `fixedScrollVisible` 只给 first-level 子级返回真。`measureLocks` 复刻
  `menus/measures.cljs` 的三条禁用规则。
- 新增 `lib/workspace-multi.ts`（13 例）：`sharedValue` / `sharedFlag` 给 mixed
  判定；`flagUpdates`、`opacityUpdates`、`radiusUpdates`（只对 rect/frame）、
  `shadowAddUpdates` / `shadowClearUpdates`、`blurAddUpdates` / `blurClearUpdates`、
  `constraintUpdates`、`sizingUpdates` 各返一个 `{id, attrs}` 列表。每个形状拿自己
  的补丁与自己的新 uuid，阴影/模糊的 id 不会在形状之间串。
- 新增 `components/workspace-style-field.tsx`：把面板原有的 `DraftField`、数值与
  颜色读取函数、草稿钩子抽出，另加 `SelectField`。`useDraftFields` 保留「同一文本
  只发一次」（Enter 失焦会再触发一次 blur）与 send 落定后丢草稿的行为；新段与多选
  面板共用同一套提交语义。
- 新增 `components/workspace-layout-options.tsx`（800 行，三段）：
  - 布局（只对 frame）：无 layout 时两个按钮建 flex/grid；有 layout 时给类型下拉
    （切换即按初始值重建）、方向、align items、wrap（flex）或 justify items
    （grid）、align content、justify content、gap 类型与值、padding 类型与值；
    grid 再给行/列轨道列表（类型下拉 + 数值或 Auto + 增删）。
  - 布局项（父级有布局时）：h/v sizing、align-self、absolute、margin 与 min/max
    宽高；min/max 清空即发 null 删除（schema 里可选）。
  - 约束（parent 不是根板时）：h/v 两个下拉用 `workspace.options.constraints.*`
    目录标签；first-level 子级多一个 fixed-scroll 勾选。
- 新增 `components/workspace-multi-options.tsx`（377 行）：N selected 标题、
  隐藏/锁定、不透明度、圆角、阴影加/清、模糊加/清、约束、布局项 sizing。混合值用
  两套表达：输入框留空并以 `settings.multiple` 作 placeholder，下拉插一个禁用的
  mixed 选项。
- 画布句柄增 `updateShapesAttrs(updates)`：一次 `sendUpdateFile` 带 N 个 mod-obj，
  本地用 `applyUpdateChanges` 镜像（null 即删键），重建索引与 store，再对属性会被
  渲染器读取的子集调一次 `uploadChangedShapes`。`updateShapeAttrs` 语义不变。
- `lib/render-wasm/shape-upload.ts`：样式白名单提为导出函数 `attrsWriteStyle`，
  前缀表加 `layout`（覆盖 `layout-item-*`）与 `constraints-`，`fixed-scroll` 单列。
  不补的话布局与约束只进模型不进画布。测试 21 例（+2）。
- 面板：单形状时按条件插入三段（布局 = frame；布局项 = 父级有布局；约束 = 父级
  不是根板），measures 的 x/y 与 W/H 改用 `measureLocks` 禁用。
- 与 CLJS 的有意偏差：
  - wire 的 `set` 整体替换值，CLJS 的 `update-layout` 用 `d/patch-object` 深合并。
    所以这里每个 map 都发完整键（padding 必带 p1..p4，gap 必带两值），否则
    `schema:layout-padding` 的必填键会拒。
  - `remove-layout` 连 grid 键一起清。CLJS 的 `layout-keys` 只列 flex 键（上游
    遗漏），删掉 grid 布局会留下 `layout-grid-*`。
  - 枚举标题硬编码英文，与 `layout_container.cljs` 的做法一致（上游多数用图标
    title，po 里没有这些键）。
  - 不移植 reflow，也没有 grid cells 编辑与「edit grid」模式。
  - 多选批量只覆盖单形状面板已有的属性；fills、strokes 与逐条阴影/模糊仍走单选。
- 已知限制（本轮明确记录）：
  - 布局属性会落库并随 `set_object` 进 wasm，但客户端不重算子级位置。视觉重排要
    等父级下一次 modifier（拖动子级、缩放父级），因为 `reflow_flex_layout` /
    `reflow_grid_layout` 只在 modifier 管线里跑，`set_object` 不重排。
  - 约束同理：属性存进去，resize 不套用（`lib/workspace-transform.ts` 明确只变换
    选区，不传播约束与布局）。
  - 网格布局的 `layout-grid-cells` 没有编辑入口，轨道只改 `layout-grid-rows` /
    `layout-grid-columns`。
- 验证：`pnpm test` 59 文件 1367 例全过；`pnpm typecheck` 退出 0；`pnpm lint`
  无告警；`pnpm build` 通过（/workspace 40.5 kB，First Load JS 236 kB）；
  `pnpm translations` 重新抽取（928 键，en 全量，zh_cn 796、zh_hant 912，其余
  回落英文）。本轮未做浏览器复测。
- 下一步：F9.9 余下的是 grid cells 与布局 reflow 的移植（要做可视化重排才需要），
  以及 resize 的约束传播。

### 7.38 本轮（2026-10-26，第三十七批：F9.10 resize/rotate 的子级传播与约束）

- 目标：补 7.37 登记的第一条已知限制。此前的 resize/rotate 只给「选区 + 整棵子树」
  同一个世界矩阵，`constraints-h/v` 存了但永远不生效。
- 新增 `lib/workspace-constraints.ts`（27 例，含 1 例 cycle 防御）：
  - `constraintAxisMap` 是 `constraint-modifier` 的单轴版，用父级 selrect 的前后差
    把约束折成 `x' = scale*x + offset`：left/top 保起始偏移，right/bottom 保结束
    偏移，leftright/topbottom 两侧都保（子级跟着父级一起长），center 保中心偏移，
    scale 直接跟随父级自身的映射（`offset = afterStart - scale*beforeStart`，父级
    起点移动时也对齐）。
  - `constraintChildMatrix` 合并两轴；未知约束值返回 null，调用方退回手势矩阵。
    「约束不改变子级」返回单位矩阵，子级真的不动，不会退化成跟随手势矩阵。
  - `gestureEntries(objects, roots, matrix, rotationDelta, accepts?)` 产出一次手势
    的全部 `{id, matrix, rotation}`：选区按手势矩阵，容器的直接子级按约束矩阵，更
    深的层级沿用最近祖先的矩阵；有 rotationDelta 时整棵子树刚性旋转并带上角度增量。
    `accepts` 与手势的变换集合过滤同一批形状（text 子级仍保持几何，见 7.30 AD6）。
- 默认值照 `default-constraints-h/v`：父级是 frame 的第一层子级 left/top，其余
  scale。布局 frame 的流式子级按 `calc-child-modifiers` 强制 left/top（不移植
  reflow，所以只能保住偏移）；`layout-item-absolute` 与 hidden 的子级按自己的约束。
- `lib/workspace-transform.ts`：新增 `TransformEntry`、`transformEntries`、
  `buildTransformEntryChanges`、`applyTransformEntries`，按 id 去重且首个条目生效；
  删掉只能传单一矩阵的 `buildTransformChanges` / `applyTransformSet`。
- `lib/workspace-geometry.ts`：把面板 x/y/W/H/旋转的矩阵计算抽成
  `geometryTransform`，`buildGeometryChange` 改为在它上面取补丁，语义不变。
- 画布：手势状态里 `ids`（扩张后的集合）改为 `roots`（按下时的选区）。预览与提交
  都走 `gestureEntries`，所以拖动中看到的子级位置就是落下后的位置；
  `updateShapeGeometry` 复用同一入口，面板改帧尺寸/角度也会带动子级。一次
  `sendUpdateFile` 带全部 mod-obj，撤销自动覆盖子级。
- 与 CLJS 的有意偏差：
  - 只有轴对齐容器（rotation 0、无 flip）按约束铺开，旋转或翻转的形状把手势矩阵
    交给子级。CLJS 在父级坐标系里对子级四边形运算，而 shell 只存六元变换，表达
    不了「旋转子级做非等比缩放」的错切。
  - 约束逐层生效：旋转根的孙子级仍按自己那个轴对齐父级的约束算。
  - 约束作用在子级 selrect 上，因此子级自身带旋转时沿世界轴缩放（与 7.36 面板
    尺寸字段同一种取舍）。
- 已知限制（本轮明确记录）：
  - 布局 frame 仍不 reflow（见 7.37），所以布局子级只保偏移，不会被布局重新排版。
    更正（7.39）：这条只对 shell 自算路径成立；wasm 的 `propagate_modifiers`
    一直会 reflow，本轮已改走那条路径。
  - 没有 modifier 链与 `ignore-constraints`：shell 从不单独变换容器本身。
- 验证：`pnpm vitest run` 60 文件 1395 例全过；`pnpm typecheck` 退出 0；
  `pnpm lint` 无告警；`pnpm build` 通过（/workspace 41.2 kB，First Load JS 237 kB）。
  本轮未做浏览器复测。
- 下一步：布局 reflow 与 grid cells 的移植（视觉重排需要）；之后补浏览器冒烟
  （7.25 路线），最后是 F7.4 workspace 插件代理。

### 7.39 本轮（2026-10-26，第三十八批：F9.11 布局 reflow，约束与重排统一走 wasm）

- 调研结论（先查后写）：布局重排与约束的唯一算法在渲染器。
  `render-wasm/src/shapes/modifiers.rs` 的 `propagate_modifiers` 把 identity 矩阵当作
  reflow 标记；`propagate_children` 按形状类型选约束（布局 frame 的流式子级强制
  left/top、绝对定位子级用自己的、普通 frame 用 left/top、group 用 scale），
  `constraints.rs` 算缩放与位移，`reflow_flex_layout` / `reflow_grid_layout` 负责
  重排，layout reflow 按深度降序执行。CLJS 的 `update-layout-positions` 只是发
  `(ctm/reflow-modifiers)` 再把返回矩阵写回。F9.10 的
  `lib/workspace-constraints.ts` 因此是与 wasm 重复的实现，本轮降级为「wasm 缺
  `_propagate_modifiers` 时的兜底」。
- 新增 `lib/render-wasm/propagate.ts`（13 例）：`_propagate_modifiers` 的 ABI 封装。
  输入每条 44 字节（uuid 4×u32 + 矩阵 6×f32 + kind u32），kind 1 = 继续下传，
  0 = 已由渲染器铺开的结果；输出 u32 条数 + 每条 10×u32（uuid + 矩阵）。单个
  BUFFERU8 槽位由调用消费，读完 `_free_bytes()`；`u32ToUuid` 与 `uuidToU32` 互补。
- 新增 `lib/workspace-reflow.ts`（14 例）：`attrsAskReflow` 只认 `layout` 与
  `layout-*`（约束属性不触发，它在 resize 路径上）；`reflowTargetIds` 过滤根板、
  已删除形状并按首次出现去重；`reflowEntries` 发单位矩阵；`reflowChanges` /
  `applyReflow` 把返回矩阵折成 mod-obj 与本地 apply（未移动的形状不产生变更）。
- `lib/workspace-undo.ts`：新增 `mergeUndo`（6 例）。reflow 是属性编辑之后的第二个
  update-file，一次编辑必须一步撤销：redo 追加、undo 前置，selection 沿用第一条。
- `lib/workspace-constraints.ts`：新增 `acceptedSubtreeEntries`（5 例），把渲染器
  返回的条目过滤成本 shell 能变换的形状（text 与 blocked 按 AD6 剔除），被剔除的
  容器连带剔除子树；渲染器按哈希序返回，所以从被剔除的 id 向下走。
- 画布接线：
  - `sendUpdateFile(changes, recordUndo | "merge", undoBase?)`：merge 折叠进上一条；
    undoBase 让 reflow 的逆补丁基于「编辑前」的模型，撤销后子级位置与旧布局一致。
  - `gestureSubtreeEntries`：resize（含面板尺寸字段）发 `propagateModifiers` 并
    预览它返回的矩阵；rotate 仍走本地刚性传播（CLJS 旋转算法本就不用子级约束）；
    wasm 缺入口时整体退回 F9.10 路径。
  - `commitReflow`：属性编辑成功后用 identity 请求重排，把返回矩阵作为第二次
    update-file（合并撤销）落地，再 apply 到模型并用 `uploadShapeGeometry` 推回
    wasm。`updateShapeAttrs` / `updateShapesAttrs` 两个写路径都接上。
- 与 CLJS 的有意偏差：
  - 没有 `snap-pixel-grid` 开关，`pixel_precision` 固定 0（不吸附）。
  - 布局内新增/删除/重排形状不额外触发 reflow：drop-index 已把形状放在布局要的位置。
  - reflow 失败只告警：属性已经进文件，不改回，也不把失败算到那次编辑上。
- 验证：`pnpm vitest run` 62 文件 1433 例全过；`pnpm typecheck` 退出 0；
  `pnpm lint` 无告警；`pnpm build` 通过（/workspace 42.2 kB，First Load JS 238 kB）。
  未做浏览器复测（需要登录会话）。
- 下一步：grid cells 的编辑入口（面板尚未暴露 cells）；之后补浏览器冒烟
  （7.25 路线），最后是 F7.4 workspace 插件代理。

### 7.40 本轮（2026-10-27，第三十九批：F9.12 grid cells 编辑入口）

- 调研结论（先查后写）：cell map 只能由前端维护。
  - `render-wasm/src/shapes/modifiers/grid_layout.rs` 的 `create_cell_data` 只摆放
    出现在 `grid_data.cells` 里的孩子，其余 `continue`；cell 的 `column_end` /
    `row_end` 越出 tracks 时整格被跳过。所以没有 cells 的 grid 什么都不摆。
  - backend 的 mod-obj 直接落盘（`common/src/app/common/files/changes.cljc`
    `process-operations` 只做 `validate-shape`），不会补跑 `assign-cells`；
    `assign-cells` 只在 libs 同步的 `patch-layout-props` 里跑。
  - `schema:grid-cell` 要求 uuid 键、uuid `:id`/`:shapes`、keyword
    `:position`/`:align-self`/`:justify-self`（`common/src/app/common/types/shape/layout.cljc`）。
  - CLJS 菜单在 `frontend/src/app/main/ui/workspace/sidebar/options/menus/grid_cell.cljs`：
    auto/manual/area 单选、坐标、两个 self 对齐；编辑写父 frame 的
    `layout-grid-cells`（`dwsl/update-grid-cells`）。wire 键名见
    `frontend/src/app/render_wasm/api.cljs` 的 `set-grid-layout-cells`。
- 新增 `frontend-nextjs/lib/workspace-grid-cells.ts`（42 例）：
  - 读：`gridCellsOf`（cells-seq，按行序，坏记录回落到 1×1 auto）、
    `gridCellValues`（面板值；span>1 或 area 读作 manual）。
  - 写：`cellWire` / `cellsMap`（kebab-case 记录键）、`normalizeCells`
    （分区不变式：越界的格子丢掉、越界的 span 裁剪、缺的格子补齐）、
    `removeTrackAt`（删线：该线上的格子消失，其后的前移，跨线 span 减一）。
  - 放置：`placeShape`（矩形替换覆盖区，复用起点格子的 id 与 self 对齐）、
    `autoShape`（格子回到 auto 并释放 span）、`assignCells`（清掉离开布局/
    绝对定位/重复的孩子，把孤儿按阅读序放进空闲 auto 格子，不够就按
    `layout-grid-dir` 加一条 track）、`assignGrid` / `flowChildIds`。
  - 面板入口：`gridTrackEdit`、`gridPlacementEdit`、`gridSelfEdit`、
    `gridStatePatch`（track 长度变化或显式要求时才发 track 列表）。
  - 与 CLJS 的有意偏差：不重排已在 auto 格子的孩子（只补孤儿，挪一个不会
    打乱其余）；用矩形替换 `resize-cell-area`（不移植
    `common/geom/shapes/grid_areas.cljc`）；只支持末尾追加 track；不移植
    area 模式与画布内的格子编辑（`grid_layout_editor.cljs`）。
- `lib/transit.ts`：`layout-grid-cells` 不走通用递归。新增
  `encodeGridCellsValue` / `encodeGridCellEntry`，把 map 键、`id`、`shapes`
  写成 `~u`，把两个 self 对齐与 position 写成 keyword。通用递归会发
  「字符串键 + 字符串 uuid + 字符串枚举」，backend 的 `validate-shape` 会
  拒掉整次提交。追加 3 例验证 uuid 键/链接、keyword 枚举、area-name 直传与
  回读。
- 面板接线：
  - `components/workspace-layout-options.tsx`：`LayoutSectionProps` 增
    `objects`；切到 grid（`startLayout`）时立刻 `assignGrid` 并随 patch 发
    tracks；加/删 track 改走 `gridTrackEdit` + `commitGrid(..., true)`，让
    cells 始终是 tracks 的合法分区。
  - 新增 `GridCellOptions`（Grid cell 段）：Mode（auto/manual）、四个坐标
    （DraftField，提交时置 manual）、Align self / Justify self，底部显示
    `Cell r, c (rs x cs)` 或 `Not in a cell`。
  - `components/workspace-style-panel.tsx`：新增 `sendParent`（cell 写在父
    frame 上）与 `showGridCell = isGridCellParent(parent) && !绝对定位`；
    `WorkspaceStylePanel` 先收窄 `state.objects` 再下传。
  - 触发链复用 F9.11：`updateShapeAttrs`→`set_object`（前缀 `layout` 命中
    `WASM_ATTR_PREFIXES`）→`commitReflow` 以 `"merge"` 合并撤销，一次撤销
    回退属性与子级位置。
- 测试发现并修掉的缺陷：`assignWith` 原先从 `context.current` 取 tracks，
  删 track 时 `gridTrackEdit` 返回的仍是旧 rows（面板会发出长度不变的
  patch，删线不生效）。改为接收调用方传入的 track 列表，按 `assigned` 的
  长度补齐；`gridPlacementEdit` 的 manual 分支同步改用 `growTracks`。
- 验证：`npx vitest run` 63 文件 1478 例全过；`npx tsc --noEmit` 退出 0；
  `npx next lint` 无告警；`npx next build` 通过（/workspace 44.9 kB，
  First Load JS 241 kB）。未做浏览器复测（需要登录会话）。
- 下一步：按 7.25 路线补浏览器冒烟（含 grid 面板：切 grid、加删 track、
  改坐标与 self 对齐，确认 wasm 重排与一次撤销）；最后是 F7.4 workspace
  插件代理。

---

### 7.41 本轮（2026-10-27，第四十批：F9.12 浏览器冒烟）

- 做法：沿用 7.25/7.34 的 headless Chrome + CDP 路线（不引 playwright）。
  临时脚本 `.git/f912-smoke.mjs`（不入库），链 Next dev :3450 → nginx :9001
  的静态资源 → backend :6060，用测试账号登录后一次性新建文件跑完整条链路，
  28 条断言，截图 `.git/f912-smoke.png`。
- 冒烟清单（28/28 通过）：
  1. 登录。受控输入只能用「真实点击聚焦 + `Input.insertText`」：直接写
     `el.value` 会被 React 回写清空，原型 setter + `input` 事件也到不了
     `onChange`；`setSelectionRange` 在 `type=email` / `type=number` 上抛
     `InvalidStateError`，改选区失败时置空即可。
  2. `/dashboard/files` 缺 `project-id` 时整页返回 null，从 sidebar 的
     `drafts-link` 进。
  3. 画 Board + 两个 Rectangle。frame 行默认折叠，要点开 chevron 才见子级；
     画完子级后列表又回到折叠，需再展开。
  4. 切 grid：1 行 2 列；加一列 → 3 列；删末列 → 回 2 列（cells 随 tracks
     重建，两个孩子仍在各自格子里）。
  5. 子级面板出现 Grid cell：`Cell 1, 1 (1x1)`，Mode / Align self /
     Justify self 三个 select 就位。
  6. Mode=manual 保持 1,1；Row=2 后文案变 `Cell 2, 1 (1x1)`，
     `selection-outline` 的 points 从 `300,140 …` 变 `300,380 …`，wasm 重排
     确实落地。
  7. 一次 Ctrl+Z：文案回 `Cell 1, 1`，points 逐字回到撤销前的值（`merge`
     撤销把属性和子级位置一起回退）。
  8. 再改 Row=2、Justify self=end；刷新同一 URL 后 Layout=grid、
     `Cell 2, 1 (1x1)`、Justify self=end：backend 真的收下了 cells 与
     keyword 枚举。
  9. 控制台无 render-wasm / transit / RPC / validate 错误。
- 冒烟挖出的缺陷（F9.9 起一直存在）：布局与约束的枚举值以字符串发送。
  `lib/transit.ts` 的 `KEYWORD_VALUE_KEY` 只覆盖 `layout-item-*-sizing`，
  `layout`、`layout-grid-dir`、`layout-gap-type`、`layout-padding-type`、
  `layout-align-items/content`、`layout-justify-items/content`、
  `layout-item-margin-type`、`layout-item-align-self`、`constraints-h/v`
  全是裸字符串。backend 的 `validate-shape`（`schema:layout-attrs` /
  `schema:layout-child-attrs` 是 `::sm/one-of` key 集合）整批拒掉，
  `update-file` 返 500，面板只显示「出现了问题」。此前只有 vitest（mock
  RPC）覆盖，所以没暴露。修法：把这些键并入 `KEYWORD_VALUE_KEY`（grid
  track 的枚举在 `type` 键上，已被覆盖）；`lib/transit.test.ts` 追加
  「布局 / layout-item / 约束枚举写成 keyword」一例，含回读比对。
- 验证：`npx vitest run` 63 文件 1479 例全过；`npx tsc --noEmit` 退出 0；
  `npx next lint` 无告警；冒烟 28/28 通过，脚本退出 0。
- 一次性文件：每次冒烟在 Drafts 里新建 `New File N`（本次
  `ad9d5693-49bf-81be-8008-da095335ffa6`），未删，方便人工复核。
- 下一步：F7.4 workspace 插件代理。

---

### 7.42 本轮（2026-10-27，第四十一批：F9.13 页面管理、侧栏国际化与折叠）

- 两条诉求：workspace 左侧增加 page 管理并把 Layers/Assets/Tokens 页签国际化；
  左侧功能区支持点击折叠。
- 页签一直英文的根因：`workspace-layers-panel.tsx` 的 `TABS` 是模块作用域常量，
  `tr()` 在模块导入时求值一次，locale 切换后不会重算；Tokens 更是上游 CLJS
  本就不翻译的字面量。做法：tabs 移到组件内每次渲染求值，新的
  `workspace.sidebar.tokens` 补进 en/zh_CN/zh_Hant 三个 po（`Tokens` / `令牌` /
  `權杖`），再跑 `node scripts/extract-translations.mjs` 重新生成目录
  （en 935 键全覆盖；zh_cn 803、zh_hant 919，缺键按既有规则回退英文）。
- 页面 CRUD 没有独立 RPC：全部走 `update-file` 的 `:add-page` / `:mod-page` /
  `:del-page`（backend `process-change`，新增页由 `ctp/make-empty-page` 造
  「Root Frame」）。为此：
  - `lib/transit.ts` 增三种变更类型与编码（uuid id、name 明文）；
    `lib/transit.test.ts` 补两例（note：writer 会缓存重复键值，断言只对首个
    变更检查 `"~:type","~:add-page"`，后两个只查值）。
  - 新建 `lib/workspace-pages.ts`：`pageInfos` / `uniquePageName`（"Page N"
    首个空位）/ `normalizePageName` / `validPageName` / `emptyPage`（克隆当前页
    root 并清空 children）/ `withPageAdded|Renamed|Deleted` 与三个 change
    builder；配套 11 例测试。
  - `components/workspace-wasm-canvas.tsx` 的 handle 增 `createPage` /
    `renamePage` / `deletePage`：复用 `sendUpdateFile` 的 in-flight 闸门与 revn
    守卫，`recordUndo = false`。写入成功后 `invalidateDecodedWorkspaceFile`
    丢掉 `lib/render-wasm/workspace-data` 的 decoded 缓存，否则切页/重挂载会
    拿到提交前的旧 shapes。
  - 删除当前页时，store 在同一次写入里把 pageId 落到剩余第一页，避免出现
    「pageId 指向已删页」的中间渲染（`workspace-undo` 对页面变更显式抛错，
    页面操作不进撤销栈）。
- 新建 `components/workspace-pages-panel.tsx`：标题栏折叠（`aria-expanded`）、
  `workspace.sidebar.sitemap` 标题、加号（`workspace.sidebar.sitemap.add-page`，
  仅 canEdit）、页面行（当前页 `aria-current="page"`）、双击行内改名（Enter
  提交、Esc 取消、blur 提交、空白/同名静默丢弃）、垃圾桶 + 行内确认
  （`modals.delete-page.title/body`、`labels.delete/cancel`），仅剩一页时隐藏
  删除。行上带 `data-page-id`，冒烟与调试用。
- 折叠分两层，都按 CLJS 语义：
  - 整栏折叠（`dw/toggle-layout-flag :collapse-left-sidebar`）：`workspace-shell`
    的 `leftCollapsed` 卸掉左列，shell 改 `grid-template-areas:
    "viewport right-sidebar"`，浮出 `.pp-workspace-collapsed-button`（top 48px，
    右向 chevron），点击复原；折叠按钮放在 tabs 行首（`ChevronIcon` 旋转
    180°），对应 CLJS 的 `collapse-button*`。
  - Pages 区标题折叠：面板内 `collapsed`，收起后只留标题行。
- 切页走 `?page-id=`：`selectPage` 用 `URLSearchParams(window.location.search)`
  改参数后 `router.replace(..., { scroll: false })`；`app/workspace/page.tsx`
  的既有 effect 在文件已加载时只重设 `pageId`，不重新下载。
- 加载 effect 的依赖从整个 `file` 收紧为「当前页 objects + background +
  canEdit/revn/vern」：改名或改别的页不再触发整页重载，viewport、选择与撤销栈
  得以保留；切页仍然因 `pageId` 变化而重载。
- 图标 `TrashIcon` 取自 `frontend/resources/images/icons/delete.svg`；
  `styles/workspace.css` 增折叠网格、浮动按钮、tabs 折叠按钮与 Pages 区样式
  （列表最高 160px 内滚，删除按钮 hover 显形）。
- 偏离（已登记在代码注释）：不做拖动排序、分隔页、右键菜单与键盘翻页；删除
  确认是行内而非 modal；折叠状态不持久化（CLJS 用 persisted-state）；新建后不
  自动进入改名（CLJS 会）；页面变更不进撤销栈；生成名固定英文 "Page N"。
- 浏览器冒烟（`.git/f913-smoke.mjs`，不入库，25/25 通过）：登录 → 新建文件 →
  页签文案（账号语言 zh-CN，实测「图层/素材/令牌」，证明已跟随语言）→ 新建页
  并自动打开（URL 跟随）→ 双击改名 Home 并确认 `mod-page` 请求 200 → 刷新后
  两页与 Home 选中态保留 → 切回 Page 1 → Pages 标题折叠/展开 → 整栏折叠（左栏
  消失、浮动按钮出现、canvas 宽度 788→1106 即 +318）→ 展开回 318px → 打开 Home
  后删除（确认文案与词条一致，pageId 落到 Page 1、URL 跟随）→ 刷新后只剩一页；
  无 update-file 失败、无 render-wasm/transit/RPC 控制台错误。截图
  `.git/f913-collapsed.png`、`.git/f913-smoke.png`。
- 验证：`npx vitest run` 64 文件 1493 例全过；`npx tsc --noEmit` 退出 0；
  `npx next lint` 无告警；冒烟脚本退出 0。
- 一次性文件：本次 `ad9d5693-49bf-81be-8008-da0df15c683a`，未删。
- 下一步：F7.4 workspace 插件代理。

### 7.43 本轮（2026-10-27，第四十二批：workspace 与参考端 1:1 还原对齐）

- 诉求：以参考端 CLJS Penpot（:9001）实测几何为基准，把 frontend-nextjs
  （:3450）workspace 界面逐块对齐到像素级一致（左栏、工具条、画布、右栏）。
- 方法：自建 CDP 探针（headless Chrome + WebSocket，`.git/*-probe.mjs`，不入
  库）对两端同文件同页测量 DOM 几何与截图，逐块对照修正。
- 左栏（a3–a5）：页签胶囊 294x36（padding 2、gap 2、三等分 95.3x32，选中
  quaternary 底 + accent 字色）；页面区/图层标题/搜索对齐；图层树行高 36px、
  缩进与图标对齐。
- 左栏头部（b2）：DRAFTS 行补齐（项目名 + 文件行 + 用户头像行）。
- 工具条（b3）：7 组按钮 + 分隔线 + plugins + 手柄，全部对齐参考几何。
- 画布（b4）：亮色标尺（白字）、画布底色 #E8E9EA、去掉黑边。
- 右栏（b5）：presence 双头像（重叠 4px）、缩放胶囊 48x28、comments/history/
  share/play 按钮组 28x28；设计/原型/检查 tabs（294x36）；设计面板复刻
  page.cljs options：画布背景与像素网格两段（swatch 16x16 + 透明度棋盘格 +
  color input 无 # 前缀），滚动条 thin + 10px gutter 保证内容宽 284。
- i18n：extract-translations.mjs 支持 labelKey 字段扫描；workspace.sidebar.
  tokens 作为 runtimeKey 保留在目录（组件按 CLJS 惯例硬编码 "Tokens" 字面量）。
- 验证：右栏探针三轮迭代后 14 项几何全部命中参考值（elementSet 284x64、
  colorInput 250 宽、opacityInput 1361.3/39.7、avatar2 x=1140、zoomText 76%、
  tab 95.3x32）；两端全屏截图像素采样 14/14 颜色一致（画布底 #E8E9EA、工具条
  选中蓝 #194DE6、右栏 tertiary #F3F4F6）；`npx vitest run` 64 文件 1493 例全
  过；`npx tsc --noEmit` 干净；`npx next lint` 无告警；console 冒烟无错误。
- 截图：`.git/a5-ref.png`（参考端）与 `.git/b5-cur.png`（重写端），不入库。
- 下一步：F7.4 workspace 插件代理（见 7.44）。

### 7.44 本轮（2026-10-28，第四十三批：F7.4 workspace 插件代理）

- 诉求：解除 F7.4 对 F9 的阻塞，把 `app.plugins.api` 的 workspace 表面接到
  重写端的模块 store 与画布写路径（此前插件只能读 theme/flags）。
- 新增 `lib/plugin-validation.ts`：`notValid`/`validNumber` 从 context 下沉，
  让代理模块在不成环的前提下校验（version 1 记控制台、version 2 抛错）。
- 新增 `lib/workspace-bridge.ts`：画布命令注册表（创建/attrs/几何/对齐/分布/
  撤销块/视口/页面），读取回退 bridge → store → `pages-index`。
- 新增 `lib/workspace-navigation.ts`：`openPage` 的页面切换 seam；shell 注册
  `?page-id=` 的 `router.replace`，未挂载时回退为写 store。
- 新增 `lib/plugin-shape.ts`：shape 代理按 CLJS 语义每次现查活动页模型
  （`$id`/`$page`/`$file`、type 映射 board/rectangle/ellipse、points 包围盒、
  parent/board 相对坐标、fills/strokes 活元素、resize/rotate），写入经
  `updateShapeAttrs`/`updateShapeGeometry`，权限与活动页双重门禁。
- 新增 `lib/plugin-workspace.ts`：file/page/viewport/history 代理与 selection
  成员；`createPage` 先铸 id 再异步提交（立即返回代理），
  `undoBlockBegin/Finish` 配对成一次撤销事务。
- 重写 `lib/plugin-context.ts`：workspace 成员全部接代理；新增 `createBoard/
  Rectangle/Ellipse`、`createPage`、`openPage`、`alignHorizontal/Vertical`、
  `distributeHorizontal/Vertical`；`finish/filechange/pagechange/
  selectionchange/shapechange/contentsave/themechange` 由一次 store 订阅按
  CLJS 变更判定 + 10 ms debounce 派发，`contentsave` 由画布提交成功后触发。
- 画布（`components/workspace-wasm-canvas.tsx`）：新增 `createShape`、
  `alignObjects`、`distributeObjects`、`beginUndoBlock/endUndoBlock`（首条 push、
  其后 merge，10 s 安全超时）、`viewport/setZoom/setCenter/zoomReset/
  zoomIntoView`、`createPage(id?)`；提交成功后 `notifyPluginContentSaved()`；
  handle 改为 `useMemo` 并注册到桥接（卸载置 null）。
- 登记偏差：shape 删除/克隆/结构方法、文本/SVG/路径、媒体上传、
  generateMarkup/Style、字体/库/当前用户、评论/令牌/版本/导出、flow 与 ruler
  guide 写入、布局与组件方法仍以命名错误失败，等对应切片。
- 验证：新增 `lib/plugin-shape.test.ts`（22 例）与
  `lib/plugin-workspace.test.ts`（28 例），扩展 `lib/plugin-context.test.ts`；
  `npx vitest run` 70 文件 1632 例全过；`npx tsc --noEmit --incremental false`
  干净；`npx next lint` 无告警。
- 提交：`b8476498cb :sparkles: Add the plugin workspace API proxies`。
- 下一步：F8 WebSocket 协作客户端（`/ws/notifications`）。

### 7.45 本轮（2026-10-28，第四十四批：文本/图片/路径工具）

- 诉求：让顶栏此前禁用的 text / image / path 三个槽位真正可用（第 2 项）。
- 路径（自由手绘）：新增 `lib/workspace-path.ts`（RDP 简化 tolerance 0.3、
  points→content、calc-selrect、setup-path 建型）与 `PathData.fromSegments`
  （28 字节/段、小端）；画布新增 `curve` 手势（按下取样、移动去噪、抬起
  一次 add-obj，保持工具且不选中新形状），覆盖层画折线预览，store 增
  `curvePreview`；free-draw 组默认工具改为 `curve`（补
  `workspace.toolbar.curve` 三语言词条）；笔工具 `path` 仍禁用。
- 文本：新增 `lib/workspace-text.ts`（default-text-attrs/fills、change-text
  内容树、纯文本读取、盒子测量）；`isDrawTool` 纳入 text，`createDrawShape`
  按 grow-type 建型（click 4×17 auto-width、拖拽 fixed）；画布在创建后
  打开 textarea 行内编辑器，失焦/Esc 提交内容与测量盒，空文本 del-obj；
  move 工具下双击已有文本会带着原内容重开编辑器（对应参考端
  `on-double-click` -> `start-edition-mode`）。
- 图片：新增 `lib/workspace-image.ts`（chunked/一次上传、image fill、
  居中 rect、proportion 锁定、data-uri 解码）与
  `lib/render-wasm/image-store.ts`（`_alloc_bytes` + 36 字节头 + `_store_image`）；
  顶栏 image 槽改为隐藏 file input（多选、accept 图片类型），经 shell 调
  画布 `insertImageFiles`；打开文件时为既有 image fill 拉取媒体并注册像素。
- 登记偏差：手绘只发直线 line-to（平滑留给笔工具）；文本测量用 0.55em
  字符推进近似（未调 wasm calc-text-bounds），编辑器只编辑纯文本，改稿
  后按测量盒重算尺寸（fixed 文本不保留原框宽）；SVG 作为图片被拒绝
  （svg-upload 留待后续切片）；stroke-image 不在加载时补水；线条/箭头、
  笔工具、布尔仍禁用。
- 验证：新增 `lib/workspace-path.test.ts`、`lib/workspace-text.test.ts`、
  `lib/workspace-image.test.ts`，扩展 `lib/workspace.test.ts`；
  `npx vitest run` 73 文件 1685 例全过；`npx tsc --noEmit --incremental false`
  干净；`npx next lint` 无告警。
- 下一步：F8 WebSocket 协作客户端（`/ws/notifications`）。

---

## 8. 开发环境备注（本机）

| 工具 | 状态 | 备注 |
| --- | --- | --- |
| Node | v24.21.0 | 与 `.nvmrc`（v24.21.0）一致 |
| pnpm | 12.6.0 | 可用；`frontend-nextjs` 用独立工作区，`storeDir: ../.pnpm-store` |
| 网络 | 可达 | 本轮 `pnpm install` 正常下载 `next@15.5.27` 等（早期修订的 40kB/s 限制不再适用） |
| Clojure CLI / JVM | 未确认 | S2（OpenAPI 快照）需要；解锁见下 |
| Rust | rustc/cargo 1.98.0；registry 走 `sparse+https://rsproxy.cn/index/`（crates.io 直连被 TLS 拦，`static.crates.io` 通） | axum 0.8.9 等关键依赖已在本地缓存；换机器先跑 `backend-rust/HANDOFF.md` §4 自检 |
| docker | 旧机器 **没有** `docker` 命令（`command not found`）；新机器由用户开启 devenv | C1–C4 采集依赖 devenv |
| PowerShell | 5.1 | 5.1 直接调 `apply_patch` 会吞掉参数里的换行与引号（报 "last line must be '*** End Patch'"）。可用做法：把补丁写进临时文件（`WriteAllText` + 单引号 here-string，LF、无 BOM），再用一个 node 小脚本 `spawnSync(codex.exe, ["--codex-run-as-apply-patch", patch])` 传参 |

- 行尾/编码：`.editorconfig` 要求 LF + UTF-8 + 末尾换行；本轮所有新文件遵循。
- `/assets` 反代：`fs` 存储下后端只回空 204 + `x-accel-redirect`，dev 要设
  `PENPOT_ASSETS_ORIGIN=http://localhost:9001`（compose 里的 frontend nginx）才看得到头像与缩略图。
- 本机 docker 端口：backend `:6060`、frontend nginx `:9001`、postgres `:5433`、mailcatch `:1080`；
  外壳 dev server 默认跑在 `:3450`（早期几轮因端口被占自动落到 `:3451`）。
- `rewrite.md` 已入库（`git ls-files rewrite.md` 可见），随每轮的 `:books:` 文档提交更新。
- S2 解锁：装好 Clojure CLI 后用 `enable-backend-openapi-doc` flag 起后端抓
  `GET /api/main/doc/openapi.json`（`/api/openapi` 与 `/api/_doc` 只是重定向），或用 devenv 容器；
  S1/S4 不依赖运行时，S3/S5 需要活的 PG / 已登录会话。

---

（本计划以 archify 架构图为事实来源；如仓库结构变化，先更新架构图再回填本文。）
