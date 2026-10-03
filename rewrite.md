# Penpot 技术改造计划（渐进式路线）

> 本次修订（2026-10-02）依据 `archify` 生成的架构图与当前仓库真实结构（Penpot v2.17.0）重排：
> 新前端落到 `frontend-nextjs/`，新后端落到 `backend-rust/`；**前端优先**，在对应前端功能迁移
> 完成前**不改造后台**。

| 项目 | 值 |
| --- | --- |
| 文档状态 | 规划已对齐当前仓库；阶段 F 进行中（F0–F4 完成，F5 dashboard 进行中：F5.1 外壳与数据基座完成） |
| 基线版本 | Penpot v2.17.0（archify revision `84c794c5b8`） |
| 架构依据 | `.archify/architecture-penpot-20261002-123416/penpot-architecture.html`（validate/deliver/check/browser-check 四门禁全过） |
| 当前阶段 | 阶段 F（frontend-nextjs）进行中；阶段 B（backend-rust）受门禁未开始 |
| 策略 | 绞杀者模式（Strangler Fig），新旧并行、逐模块替换 |
| 硬性门禁 | `frontend-nextjs` 完成对应功能迁移前，不改 `backend/`、不实现 `backend-rust` |
| 最后更新 | 2026-10-02 |

> **状态更正**：本文件早期修订声称阶段一已产出 `tools/`、`api/`、`apps/`、`packages/`、根
> `Cargo.toml` 等交付物。核对当前 checkout（`git status` 干净，仅 `.archify/` 未跟踪）后确认这些
> 产物**均不在本仓库**，且基线应为 v2.17.0 而非 v1.20.0。本版据此把相关状态重置为「未落地」，
> 改用 `frontend-nextjs/` + `backend-rust/` 目录方案，并以架构图为事实来源。

---

## 0. 任务追踪总表

图例：✅ 完成　🔧 进行中　⬜ 未开始　⛔ 阻塞（附解锁条件）　🔒 受门禁（前端未完成前不启动）

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
| F4 | settings 路由组（`/settings/*`） | ✅ | `app/settings/{layout,profile,password,notifications,options,feedback,shortcuts}`（shortcuts 为占位）；命令 `update-profile`、`update-profile-password`、`update-profile-notifications`、`update-profile-props`、`update-profile-photo`、`delete-profile-photo`、`request-email-change`、`delete-profile`、`send-user-feedback`；随附公共件 `cmdUpload`（multipart）、ModalProvider/ConfirmDialog、ThemeManager（profile → `<html>` class）、canvas 头像、forms 的 select/radio/textarea + `oneOf`；修两处缺陷：词条抽取漏扫 `labelKey` 数据字段（169→174 条）、dev 下 `/assets` 反代拿不到 `x-accel-redirect` 的文件（拆出 `PENPOT_ASSETS_ORIGIN`）；vitest 137 例 + headless Chrome/CDP 33 项端到端断言；subscription/integrations/release-notes/shortcuts 未做（见 7.6） |
| F5 | dashboard 路由组（`/dashboard/*`） | 🔧 | 11 个路由、约 7000 行 CLJS UI + 1600 行 data 层，切成 F5.1–F5.7 七片，见下与第 4 节 |
| F6 | viewer（`/view`） | ⬜ | 集成 `render-wasm`（已是 Rust→WASM，可直接复用） |
| F7 | 插件运行时 | ⬜ | 复用 SES 沙箱与 Plugin API（`frontend/src/app/plugins*`、`plugins/`） |
| F8 | WebSocket 协作客户端 | ⬜ | 连 `/ws/notifications`（直连后端源，见 README） |
| F9 | workspace 编辑器 | ⬜ | 最高风险，最后迁移：画布 + WASM + Web Worker + 协作光标 |

### 阶段 B：backend-rust（Rust + axum，受门禁）

| 编号 | 任务 | 状态 | 说明 |
| --- | --- | --- | --- |
| B0 | `backend-rust/` 目录 + 规划 README | ✅ | 仅占位与 crate 规划，无实现代码 |
| B1 | `render-native` 渲染/导出服务 | 🔒 | 复用 `render-wasm` 平台无关核心；axum HTTP |
| B2 | `storage` 对象存储服务 | 🔒 | S3/本地/MinIO，对齐 `backend/src/app/storage` |
| B3 | `worker` 异步任务 runner | 🔒 | Postgres `task` 表 + Redis 交接（见架构图异步视图） |
| B4 | `ws-gateway` 协作网关 | 🔒 | tokio-tungstenite；会话仍需查 `http_session` |
| B5 | `rpc` 命令承接 | 🔒 | 最后、风险最高；需先有契约与响应类型 |

### 支撑任务（契约，只读后端，可与阶段 F 并行）

| 编号 | 任务 | 状态 | 说明 |
| --- | --- | --- | --- |
| S1 | RPC 命令清单提取 | ✅ | `packages/api-types/scripts/scan-rpc-inventory.mjs` 静态扫描 `backend/src`（只读）→ `rpc-inventory.json`：189 条命令（29 公开、183 有 params schema、50 有 result schema），含 ns/文件/行号/auth/added |
| S2 | OpenAPI 快照 | ⛔ | 需 JVM + Clojure 依赖或运行中的后端；解锁见 §8 |
| S3 | DB Schema 快照 | ⬜ | 从迁移重放 DDL；B2/B3 的 sqlx 类型输入 |

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

1. **前端优先，后端受门禁**：先把 `frontend-nextjs` 的路由组逐个迁移到功能对等；在此之前不改
   `backend/`、不实现 `backend-rust`。
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
├── backend/           (Clojure, 保留；前端完成前不动)
├── backend-rust/      (新 Rust+axum 后端) —— 本轮仅占位 README ✅，实现受门禁 🔒
│   └── crates/        render-native / storage / worker / ws-gateway / rpc
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
- **F4 settings（本轮已完成）**：profile/password/notifications/options/feedback 已移植，shortcuts 为占位，
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
  - **F5.2 完整网格**：`grid.cljs`（缩略图由 media worker 客户端渲染，所以留到这一片）、多选、
    右键菜单、重命名/复制/移动/删除/设为封面、`layout-toggle`、`inline-edition`、
    `check-updates`、`/dashboard/files`。
  - **F5.3** `/dashboard/libraries`、`/dashboard/deleted`（含 SSE 批量恢复/删除进度）、
    `/dashboard/search`。
  - **F5.4** `/dashboard/fonts`、`/dashboard/fonts/providers`。
  - **F5.5 团队管理**：`/dashboard/settings`、`/dashboard/members`、`/dashboard/invitations`、
    `/dashboard/webhooks`（加 change-owner、team-form）。
  - **F5.6** templates 分区、binfile 导入、dashboard 快捷键注册表（补齐 settings/shortcuts）。
  - **F5.7** organization/team switch、subscription/nitrate、comments、插件注册、WebSocket
    `subscribe-team` 实时刷新（依赖 F8）。
- **F6 viewer**：`/view` + `frame-preview` + `render-sprite`；集成 render-wasm 渲染画布（复用
  `app.render_wasm.api` 的加载方式）。
- **F7 插件**：复用 SES 运行时与 Plugin API（`app.plugins`），保持 `plugins → mcp`（WS :4402）连线。
- **F8 WebSocket 协作客户端**：连 `/ws/notifications`（直连后端源），订阅文件变更广播。
- **F9 workspace**：最后迁移、最高风险。画布 + WASM + Web Worker（缩略图/索引/导入）+ 协作光标 +
  全部绘制/布尔/交互/token 子流程。建议在 F3–F8 验证成功后再启动。

每个路由组的完成标准（DoD）：

1. 页面在 `frontend-nextjs` 下可渲染并通过 `pnpm typecheck` / `pnpm build`；
2. 经 `lib/rpc.ts` 打通该页所需命令（参数/响应类型来自 api-types，或明确标注为手写切片）；
3. 与旧 CLJS 页面功能对等（关键交互清单逐项核对）；
4. Playwright 覆盖新路径；
5. 不改动 `backend/`（如需新服务端行为，登记到阶段 B，不在 F 内做）。

### 阶段 B：backend-rust（Rust + axum，🔒 受门禁）

**门禁**：仅当对应能力的前端消费方已落在 `frontend-nextjs` 且需要新服务端行为时启动；在此之前
`backend-rust/` 只有规划 README。顺序（性能关键路径优先，核心业务最后）：

- B1 `render-native`：从 `render-wasm` 复用平台无关核心，axum 提供渲染/导出（PNG/SVG/PDF），替代
  Puppeteer 路径。
- B2 `storage`：`rust-s3` + `tokio::fs`，Trait 抽象 S3/本地/MinIO，兼容既有存储 API；输入为 S3 的
  `storage_object` / `file_media_object` schema。
- B3 `worker`：异步任务 runner，Postgres `task` 表认领 + Redis 交接；迁移导入/批量/邮件（`lettre`）/webhook。
- B4 `ws-gateway`：长连接保持/心跳/重连/路由，桥接 Clojure 端；会话校验仍查 `http_session`
  （Access+Refresh 双令牌如需，随此评估）。
- B5 `rpc`：逐步承接 `/api/main/methods` 命令，最后且风险最高，需先有 S2 OpenAPI 与响应类型。

---

## 5. 里程碑（前端优先）

```
阶段 F  ██████████████████████░░░░░░░░░░░░░░░░░░░░░░░░  (F0–F4 已完成，F5 进行中 → F6..F9)
        F0 脚手架 | F1 契约/会话 | F2 设计系统 | F3 auth | F4 settings | F5 dashboard
        | F6 viewer | F7 plugins | F8 ws | F9 workspace
阶段 B  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  🔒 门禁：F 对应收口后逐服务启动
        B1 render-native | B2 storage | B3 worker | B4 ws-gateway | B5 rpc
支撑    ▒▒▒▒▒▒▒▒  S1 RPC 清单 → F1.2 ; S2 OpenAPI ⛔ ; S3 DB schema → B2/B3
图例： █ 进行中/完成　▒ 可并行　░ 受门禁未开始
```

---

## 6. 风险矩阵（精简）

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| 两套前端体验割裂 | 中 | 中 | 复用 `@penpot/ui` + 移植 ds 令牌，统一设计系统（F2） |
| Transit 复杂值往返不一致 | 中 | 严重 | F1.1 完整移植 handler；对 file/change 做往返测试 |
| 响应类型覆盖不足 | 高 | 中 | S1/F1.2 生成 api-types；缺 `::sm/result` 的命令先标手写类型 |
| 会话吊销在两栈不一致 | 中 | 严重 | 前端只复用 cookie 会话；后端侧统一由网关代查 `http_session`（B4） |
| workspace 迁移复杂度 | 高 | 严重 | 放到 F9 最后，前置 F3–F8 验证；必要时长期保留 CLJS workspace |
| Rust 与 WASM 渲染差异 | 中 | 中 | B1 像素级对比 + CI 金丝雀 |
| 契约工具需 JVM/GitHub | 中 | 中 | S2 解锁条件见 §8；S1/S3 走静态扫描不依赖运行时 |

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

未开始（🔒 受门禁）。

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

---

## 8. 开发环境备注（本机）

| 工具 | 状态 | 备注 |
| --- | --- | --- |
| Node | v24.21.0 | 与 `.nvmrc`（v24.21.0）一致 |
| pnpm | 12.6.0 | 可用；`frontend-nextjs` 用独立工作区，`storeDir: ../.pnpm-store` |
| 网络 | 可达 | 本轮 `pnpm install` 正常下载 `next@15.5.27` 等（早期修订的 40kB/s 限制不再适用） |
| Clojure CLI / JVM | 未确认 | S2（OpenAPI 快照）需要；解锁见下 |
| PowerShell | 5.1 | 5.1 直接调 `apply_patch` 会吞掉参数里的换行与引号（报 "last line must be '*** End Patch'"）。可用做法：把补丁写进临时文件（`WriteAllText` + 单引号 here-string，LF、无 BOM），再用一个 node 小脚本 `spawnSync(codex.exe, ["--codex-run-as-apply-patch", patch])` 传参 |

- 行尾/编码：`.editorconfig` 要求 LF + UTF-8 + 末尾换行；本轮所有新文件遵循。
- `/assets` 反代：`fs` 存储下后端只回空 204 + `x-accel-redirect`，dev 要设
  `PENPOT_ASSETS_ORIGIN=http://localhost:9001`（compose 里的 frontend nginx）才看得到头像与缩略图。
- 本机 docker 端口：backend `:6060`、frontend nginx `:9001`、postgres `:5433`、mailcatch `:1080`；
  外壳 dev server 跑在 `:3451`（`pnpm dev` 默认 `:3450`）。
- `rewrite.md` 被 `.gitignore` 的 `/*.md` 规则忽略（根级 md 不入库），可自由编辑。
- S2 解锁：装好 Clojure CLI 后用 `enable-backend-openapi-doc` flag 起后端抓 `GET /api/rpc/openapi.json`，
  或用 devenv 容器；S1/S3 走静态扫描，不依赖运行时。

---

（本计划以 archify 架构图为事实来源；如仓库结构变化，先更新架构图再回填本文。）
