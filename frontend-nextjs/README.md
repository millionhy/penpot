# frontend-nextjs

Penpot 的 Next.js 前端外壳，采用绞杀者模式（Strangler Fig）逐步替换 `frontend/`
（ClojureScript + Potok + Rumext/React）。

## 核心原则

1. **复用现有后端，不改后端**：本外壳通过 Transit RPC 调用既有 Clojure 后端的
   `/api/main/methods/*`，与 CLJS 前端说同一套协议。在对应页面完成迁移并达到功能
   对等之前，**不新增 `backend-rust` 实现代码、不改动 `backend/`**。
2. **逐路由迁移**：一次搬一个路由组（auth → settings → dashboard → view → workspace），
   新旧前端可并行运行。
3. **契约先行**：跨栈调用的类型最终由 `packages/api-types` 从后端 RPC 清单生成，
   不靠手抄源码。

## 与架构图的对应

依据 `.archify/architecture-penpot-20261002-123416/penpot-architecture.html`：
本目录替换图中的 `frontend`（ClojureScript · Potok）节点，保留其对 `backend`
（Transit RPC `/api/main/methods`、WS 广播）、`wasm`（render-wasm）、`plugins`
（SES 沙箱）的既有连线。`render-wasm` 已是 Rust→WASM，可被 Next.js 直接复用，
无需改动。

## 目录结构

```
frontend-nextjs/
├── app/                  Next.js App Router 路由树（对应 CLJS 路由）
│   ├── layout.tsx        根布局 + 全局样式
│   ├── page.tsx          引导页（重定向到 /auth/login）
│   ├── auth/login/       P0 端到端样板：login-with-password + get-profile
│   ├── auth/register/    占位（待迁移）
│   ├── auth/recovery/    占位（待迁移）
│   ├── settings/profile/ 占位（待迁移）
│   ├── dashboard/recent/ 占位（待迁移）
│   ├── view/             占位（Viewer，后续集成 WASM 渲染）
│   └── workspace/        占位（编辑器，最后迁移）
├── lib/
│   ├── rpc.ts            Transit RPC 传输层（对应 app.main.repo 的 send!/cmd!）
│   ├── transit.ts        Transit 编解码（transit-js）
│   ├── errors.ts         类型化错误（对应 handle-response 的 :type 分类）
│   ├── config.ts         运行时配置（对应 app.config 的 public-uri 等）
│   ├── routes.ts         路由注册表（对应 app.main.ui.routes 的 routes 集合）
│   └── types.ts          P0 手写类型切片（后续由 api-types 生成替换）
├── components/           外壳内部共享组件
├── packages/api-types/   生成的 RPC 类型（占位）
├── types/transit-js.d.ts transit-js 的类型垫片
├── next.config.mjs       开发期把 /api、/assets 反代到 backend:6060
└── pnpm-workspace.yaml   独立工作区（与 frontend/ 隔离，共享 ../.pnpm-store）
```

## 路由映射

CLJS 用查询串路由（`?screen=<name>`）并保留一段 `#/...` 兼容期；Next.js 外壳改用
干净的路径段。完整名称见 `lib/routes.ts`，与 `frontend/src/app/main/ui/routes.cljs`
一一对应。把 `?screen=<name>` / `#/<path>` 兼容重定向到这些路径是任务 F1.3。

| 路由组 | 路径示例 | CLJS 参考 | 状态 |
| --- | --- | --- | --- |
| auth | `/auth/login` | `app.main.ui.auth` | 登录页已打通（样板） |
| settings | `/settings/profile` | `app.main.ui.settings` | 占位 |
| dashboard | `/dashboard/recent` | `app.main.ui.dashboard` | 占位 |
| viewer | `/view` | `app.main.ui.viewer` | 占位 |
| workspace | `/workspace` | `app.main.ui.workspace` | 占位（最后迁移） |

## RPC 传输层

`lib/rpc.ts` 是 `frontend/src/app/main/repo.cljs` 中 `send!`/`cmd!` 的忠实移植：

- 端点：`<public-uri>/api/main/methods/<command>`
- 方法：`get-*` 命令用 GET（幂等，自动重试），其余用 POST
- 头部：`accept: application/transit+json,...`、`x-session-id`
- 凭据：`credentials: "include"`（cookie `auth-token`）
- 重试：仅 GET，最多 3 次，指数退避（1s/2s/4s），针对 `:network`/`:bad-gateway`/
  `:service-unavailable`/`:offline`
- 错误：按 `handle-response` 的 `:type` 分类抛出 `RpcError`

**尚未实现**（对应 repo.cljs 的分支，列为后续任务）：SSE 流式命令（`::sse/*`）、
`multipart` 上传、`login-with-oidc`（`api/auth/oidc`）、`export`（`api/export`）。
Transit 自定义 handler（uuid/instant/关键字命名空间，见 `common/src/app/common/transit.cljc`）
也需在任务 F1.1 中完整移植。

## 运行

前置：一个可访问的 Penpot 后端（默认 `http://localhost:6060`），可用 devenv 启动。

```bash
cd frontend-nextjs
pnpm install
pnpm dev          # http://localhost:3450
```

开发期 `next.config.mjs` 把 `/api/*`、`/assets/*` 反代到后端，浏览器只面对单一源，
既避免 CORS，也保住 cookie 的 SameSite。生产环境沿用既有 nginx 反代，同样的相对
URL 不变即可工作。

WebSocket（`/ws/notifications`）不经 Next rewrite（rewrite 不转发 HTTP upgrade），
协作长连接直接连 `lib/config.ts` 里配置的后端源。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NEXT_PUBLIC_PENPOT_PUBLIC_URI` | 空（同源相对） | RPC 基址，对应 `cf/public-uri` |
| `NEXT_PUBLIC_PENPOT_BACKEND_ORIGIN` | `http://localhost:6060` | WS/直连后端源 |
| `PENPOT_BACKEND_ORIGIN` | `http://localhost:6060` | 服务端 rewrite 反代目标 |
| `NEXT_PUBLIC_PENPOT_FLAGS` | 空 | 特性开关，对应 `cf/flags` |

## 下一步

见根目录 `rewrite.md` 的「阶段 F：frontend-nextjs」。最近一步：`pnpm install`
后跑通 `pnpm typecheck` 与 `pnpm build`，并用 `get-profile` 验证登录页端到端。