# Penpot 技术改造计划（渐进式路线）

> 本次修订（2026-10-02）依据 `archify` 生成的架构图与当前仓库真实结构（Penpot v2.17.0）重排：
> 新前端落到 `frontend-nextjs/`，新后端落到 `backend-rust/`；**前端优先**，在对应前端功能迁移
> 完成前**不改造后台**。

| 项目 | 值 |
| --- | --- |
| 文档状态 | 规划已对齐当前仓库；阶段 F 进行中（F0/F1.1/F1.3/F1.4 已完成） |
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
| F1.2 | `packages/api-types` 生成器 | ⬜ | 输入已就绪：`packages/api-types/rpc-inventory.json`（S1 产物，189 条命令）；下一步实现 malli schema → TS 类型生成（只读后端） |
| F1.3 | URL 兼容层 | ✅ | `lib/legacy-routes.ts` + `components/url-compat.tsx`：`?screen=<name>` 与 legacy `#/<path>`（含 `:file-id` 路径参数）客户端 replace 到 App Router 路径，14 项解析器单测通过 |
| F1.4 | 会话与引导 | ✅ | `lib/session.tsx`（SessionProvider：get-profile 引导，zero-uuid=匿名）+ `components/auth-guard.tsx`；dashboard/settings 布局与 workspace/view 页加守卫；根路径复刻空 token 分支；登录页接入 `session.refresh` |
| F2 | 设计系统基线 | ⬜ | 复用 `@penpot/ui`（现有 menu/modal）+ 把 `frontend/src/app/main/ui/ds/*.scss` 令牌移植为 CSS 变量 |
| F3 | auth 路由组（`/auth/*`） | ⬜ | login（样板已通）→ register/recovery/verify-token |
| F4 | settings 路由组（`/settings/*`） | ⬜ | profile/password/feedback/options/notifications/shortcuts/… |
| F5 | dashboard 路由组（`/dashboard/*`） | ⬜ | recent/files/libraries/fonts/members/invitations/webhooks/search/deleted |
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
- **F4 settings**：profile/password/feedback/options/notifications/shortcuts（+ subscription/integrations
  视 flag）。命令：`update-profile-password`、`update-profile` 等。
- **F5 dashboard**：recent/files/libraries/fonts/font-providers/members/invitations/webhooks/search/
  deleted/settings。命令：`get-teams`、`get-projects`、`get-project-files`、`get-team-members` 等。
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
阶段 F  ██████████████████████████████████████████████  (F0 已完成 → F1..F9)
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

### 7.3 阶段 B

未开始（🔒 受门禁）。

---

## 8. 开发环境备注（本机）

| 工具 | 状态 | 备注 |
| --- | --- | --- |
| Node | v24.21.0 | 与 `.nvmrc`（v24.21.0）一致 |
| pnpm | 12.6.0 | 可用；`frontend-nextjs` 用独立工作区，`storeDir: ../.pnpm-store` |
| 网络 | 可达 | 本轮 `pnpm install` 正常下载 `next@15.5.27` 等（早期修订的 40kB/s 限制不再适用） |
| Clojure CLI / JVM | 未确认 | S2（OpenAPI 快照）需要；解锁见下 |
| PowerShell | 5.1 | 写文件用 .NET `WriteAllText` + 单引号 here-string（LF、无 BOM），规避 `apply_patch` 对 `"` 的破坏 |

- 行尾/编码：`.editorconfig` 要求 LF + UTF-8 + 末尾换行；本轮所有新文件遵循。
- `rewrite.md` 被 `.gitignore` 的 `/*.md` 规则忽略（根级 md 不入库），可自由编辑。
- S2 解锁：装好 Clojure CLI 后用 `enable-backend-openapi-doc` flag 起后端抓 `GET /api/rpc/openapi.json`，
  或用 devenv 容器；S1/S3 走静态扫描，不依赖运行时。

---

（本计划以 archify 架构图为事实来源；如仓库结构变化，先更新架构图再回填本文。）