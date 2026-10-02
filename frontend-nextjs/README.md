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
│   ├── auth/layout.tsx   auth 路由组容器（logo/插图/条款页脚，对应 app.main.ui.auth）
│   ├── auth/login/       login-with-password + get-profile
│   ├── auth/register/    prepare-register-profile → register-profile
│   │   ├── validate/     OIDC 注册回填（register-profile）
│   │   └── success/      「检查你的邮箱」页
│   ├── auth/recovery/    recover-profile（改密）
│   │   └── request/      request-profile-recovery（发信）
│   ├── auth/verify-token/ verify-token 多分支派发（邮箱验证/改邮箱/邀请）
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
│   ├── legacy-routes.ts  ?screen= / #/ 旧链接解析（F1.3）
│   ├── session.tsx       会话引导（get-profile，zero-uuid = 匿名）
│   ├── i18n.ts           tr/format/richSegments（对应 app.util.i18n）
│   ├── translations/en.ts 生成的英文词条子集
│   ├── forms.ts          表单状态与校验（对应 app.util.forms 的 malli 规则）
│   ├── auth.ts           auth 命令封装 + 错误映射 + verify-token 派发
│   ├── auth-flow.ts      登录/注册后的跳转（对应 logged-in、login-from-register）
│   ├── storage.ts        localStorage/sessionStorage（对应 app.util.storage 键布局）
│   └── types.ts          api-types 生成类型的桥接与别名
├── components/           视图组件（form/tr/notifications/query-params/invalid-token…）
├── styles/               tokens.css（ds 令牌）+ forms.css + auth.css
├── scripts/              extract-translations.mjs（词条抽取生成器）
├── public/               fonts/（worksans、vazirmatn、robotomono）+ images/
├── packages/api-types/   生成的 RPC 类型（占位）
├── types/transit-js.d.ts transit-js 的类型垫片
├── vitest.config.ts      无头逻辑单测（lib/**）
├── next.config.mjs       开发期把 /api、/assets 反代到 backend:6060
└── pnpm-workspace.yaml   独立工作区（与 frontend/ 隔离，共享 ../.pnpm-store）
```

## 路由映射

CLJS 用查询串路由（`?screen=<name>`）并保留一段 `#/...` 兼容期；Next.js 外壳改用
干净的路径段。完整名称见 `lib/routes.ts`，与 `frontend/src/app/main/ui/routes.cljs`
一一对应。把 `?screen=<name>` / `#/<path>` 兼容重定向到这些路径是任务 F1.3。

| 路由组 | 路径示例 | CLJS 参考 | 状态 |
| --- | --- | --- | --- |
| auth | `/auth/login`、`/auth/register`、`/auth/recovery`、`/auth/verify-token` | `app.main.ui.auth` | 已迁移（SSO/OIDC 按钮除外） |
| settings | `/settings/profile` | `app.main.ui.settings` | 占位 |
| dashboard | `/dashboard/recent` | `app.main.ui.dashboard` | 占位 |
| viewer | `/view` | `app.main.ui.viewer` | 占位 |
| workspace | `/workspace` | `app.main.ui.workspace` | 占位（最后迁移） |

## 表单、词条与通知（F3 引入的基础设施）

这三块是后续每个路由组都要用的公共件，随 auth 一起落地：

- **词条**：`pnpm translations` 跑 `scripts/extract-translations.mjs`，扫描外壳里的
  `tr("key")` 与 `<Tr k="key">` 调用点，从 `frontend/translations/en.po` 抽出用到的
  条目生成 `lib/translations/en.ts`。缺失的 key 直接让脚本失败，避免页面上出现裸 key。
  后端在 `:details` 里回传的动态 key（弱密码原因）登记在脚本的 `runtimeKeys`。
- **表单**：`lib/forms.ts`（无头）按 CLJS 表单声明的 malli schema 复刻校验规则与报错
  文案，取文案的规则来自 `common/src/app/common/schema/messages.cljc`；
  `components/form.tsx` 是对应的视图层。与 `fm/submit-button*` 一致：表单不合法时提交
  按钮禁用，`onSubmit` 只会拿到干净数据。
- **通知**：`components/notifications.tsx` 复刻 `app.main.data.notifications` 的语义 ——
  单条通知槽、success/info/warning 7 秒自动消失、error 常驻、路由变化即隐藏。

`@penpot/ui`（ds 的 input/button/menu/modal）尚未接线：该包是 React +
react-aria-components + SCSS modules，`exports` 指向未构建的 `dist/`。接线随 F4/F5
第一个真正需要它的页面一起做，届时 `styles/forms.css` 里的临时字段样式可退场。

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
Transit 读侧 handler（uuid/instant/bigint/duration/uri/ordered-map/pointer）已在 F1.1
移植；file-data 写侧 handler 随 viewer/workspace（F6/F9）一起补。

## 运行

前置：一个可访问的 Penpot 后端（默认 `http://localhost:6060`），可用 devenv 启动。

```bash
cd frontend-nextjs
pnpm install
pnpm dev          # http://localhost:3450
pnpm test         # lib/** 的无头逻辑单测（vitest）
pnpm translations # 重新生成 lib/translations/en.ts
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
| `NEXT_PUBLIC_PENPOT_FLAGS` | 空 | 特性开关，对应 `cf/flags`；语法同 `penpotFlags`（`enable-x` / `disable-x`），在 `common/src/app/common/flags.cljc` 的默认集之上叠加 |
| `NEXT_PUBLIC_PENPOT_TERMS_OF_SERVICE_URI` | 空 | 注册页条款链接，对应 `cf/terms-of-service-uri` |
| `NEXT_PUBLIC_PENPOT_PRIVACY_POLICY_URI` | 空 | 注册页隐私链接，对应 `cf/privacy-policy-uri` |

## 下一步

见根目录 `rewrite.md` 的「阶段 F：frontend-nextjs」。下一步是 F4：settings 路由组
（profile/password/feedback/options/notifications/shortcuts），并在那里接入
`@penpot/ui` 的 menu/modal 与 profile 驱动的主题切换。
