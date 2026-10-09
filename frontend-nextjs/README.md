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
│   ├── layout.tsx        根布局 + 全局样式 + ThemeManager + ModalProvider
│   ├── page.tsx          引导页（重定向到 /auth/login）
│   ├── auth/layout.tsx   auth 路由组容器（logo/插图/条款页脚，对应 app.main.ui.auth）
│   ├── auth/login/       login-with-password + get-profile
│   ├── auth/register/    prepare-register-profile → register-profile
│   │   ├── validate/     OIDC 注册回填（register-profile）
│   │   └── success/      「检查你的邮箱」页
│   ├── auth/recovery/    recover-profile（改密）
│   │   └── request/      request-profile-recovery（发信）
│   ├── auth/verify-token/ verify-token 多分支派发（邮箱验证/改邮箱/邀请）
│   ├── settings/layout.tsx AuthGuard + 侧边栏 + 「你的账户」页头
│   ├── settings/profile/ update-profile、头像上传/删除、改邮箱与删号弹窗
│   ├── settings/password/ update-profile-password（含后端错误映射）
│   ├── settings/notifications/ update-profile-notifications（三组单选）
│   ├── settings/options/ 语言与主题 select + `:render-switch` 的 webgl 开关
│   ├── settings/feedback/ send-user-feedback（受 `:user-feedback` 开关控制）
│   ├── settings/shortcuts/ 占位（依赖 dashboard/workspace 的快捷键注册表）
│   ├── dashboard/layout.tsx AuthGuard + DashboardProvider + 侧边栏 + 内容槽
│   ├── dashboard/recent/  projects-section*（项目行：网格/列表、拖拽移动、inline 重命名）
│   ├── dashboard/files/   files-section*（F5.2 完整网格：多选/菜单/重命名/移动/删除）
│   ├── dashboard/libraries/ libraries-page*（F5.3 共享库摘要卡）
│   ├── dashboard/search/  search-page*（F5.3 三态占位 + 只读结果网格）
│   ├── dashboard/deleted/ deleted-section*（F5.3 回收站：SSE 批量恢复/彻底删除 + 进度）
│   ├── dashboard/fonts/   fonts-page*（F5.4 上传队列 + 已安装字体表）
│   ├── dashboard/fonts/providers/ font-providers-page*（F5.4，与 CLJS 相同只有页头占位）
│   ├── dashboard/members/ team-members-page*（F5.5 成员表：角色/移出/三种离开流程）
│   ├── dashboard/invitations/ invitation-section*（F5.5 排序表 + 勾选 + 复制链接 + 重发）
│   ├── dashboard/webhooks/ webhooks-page*（F5.5 列表/空态 hero + 新建/编辑弹窗）
│   ├── dashboard/settings/ team-settings-page*（F5.5 团队照片/资料块/计数）
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
│   ├── settings.ts       设置页无头逻辑（主题/语言、参数映射、错误分类、侧边栏清单）
│   ├── dashboard.ts      dashboard 无头逻辑（team 解析、派生选择、timeAgo、回收站/共享库
│   │                     派生、SSE 批量恢复与彻底删除、其余命令封装）
│   ├── dashboard-context.tsx DashboardProvider（团队/项目/近期文件/字体/成员/邀请/webhook/统计，对应 dd/initialize 链）
│   ├── progress.ts       批量操作进度状态机（对应 dcm/initialize-progress 一族）
│   ├── fonts.ts          自定义字体无头逻辑（mtype/字重解析、上传队列合并、@font-face 注册、字体命令封装）
│   ├── team.ts           团队管理无头逻辑（角色判定、邀请排序、webhook 摘要、hero 存储、团队命令封装）
│   ├── uploads.ts        分块上传会话（create-upload-session → 双并发 upload-chunk）
│   ├── check-updates.ts    check-for-updates 无头逻辑（版本比较、CHANGES.md 解析、highlights）
│   ├── avatars.ts        canvas 首字母头像（仅客户端，对应 app.util.profile）
│   ├── dom.ts            useDocumentTitle、triggerDownload（页面标题副作用与浏览器下载）
│   └── types.ts          api-types 生成类型的桥接与别名
├── components/           视图组件（form/tr/notifications/modal/theme/settings-sidebar/dashboard-*/fonts-page/file-menu/project-menu/inline-edition/layout-toggle/check-updates/delete-shared-dialog/deleted-tabs/progress-notification/team-header/team-invite/team-hero/team-form-modal/team-options-menu/team-leave-flows/leave-and-reassign-modal/webhook-modal/member-avatar…）
├── styles/               tokens.css（ds 令牌）+ forms.css + auth.css + settings.css + dashboard.css
├── scripts/              extract-translations.mjs（词条抽取生成器）
├── public/               fonts/（worksans、vazirmatn、robotomono）+ images/
├── packages/api-types/   生成的 RPC 类型（占位）
├── types/transit-js.d.ts transit-js 的类型垫片
├── vitest.config.ts      无头逻辑单测（lib/**）
├── next.config.mjs       开发期反代 /api 到 backend、/assets 到 assets 源
└── pnpm-workspace.yaml   独立工作区（与 frontend/ 隔离，共享 ../.pnpm-store）
```

## 路由映射

CLJS 用查询串路由（`?screen=<name>`）并保留一段 `#/...` 兼容期；Next.js 外壳改用
干净的路径段。完整名称见 `lib/routes.ts`，与 `frontend/src/app/main/ui/routes.cljs`
一一对应。把 `?screen=<name>` / `#/<path>` 兼容重定向到这些路径是任务 F1.3。

| 路由组 | 路径示例 | CLJS 参考 | 状态 |
| --- | --- | --- | --- |
| auth | `/auth/login`、`/auth/register`、`/auth/recovery`、`/auth/verify-token` | `app.main.ui.auth` | 已迁移（SSO/OIDC 按钮除外） |
| settings | `/settings/profile`、`/settings/password`、`/settings/notifications`、`/settings/options`、`/settings/feedback` | `app.main.ui.settings` | 已迁移（shortcuts 为占位，subscription/integrations 未建路由） |
| dashboard | `/dashboard/recent`、`/dashboard/files`、`/dashboard/libraries`、`/dashboard/search`、`/dashboard/deleted`、`/dashboard/fonts`、`/dashboard/fonts/providers`、`/dashboard/members`、`/dashboard/invitations`、`/dashboard/webhooks`、`/dashboard/settings`（十一路由全部迁移） | `app.main.ui.dashboard` | F5 进行中（F5.1–F5.5 已迁移） |
| viewer | `/view` | `app.main.ui.viewer` | 占位 |
| workspace | `/workspace` | `app.main.ui.workspace` | 占位（最后迁移） |

## 表单、词条与通知（F3 引入、F4 扩展的公共设施）

这三块是后续每个路由组都要用的公共件：

- **词条**：`pnpm translations` 跑 `scripts/extract-translations.mjs`，扫描外壳里的
  `tr("key")`、`<Tr k="key">` 调用点和 `labelKey: "key"` 数据字段，从
  `frontend/translations/en.po` 抽出用到的条目生成 `lib/translations/en.ts`。缺失的
  key 直接让脚本失败，避免页面上出现裸 key。两类扫描不到的 key 要手工登记：后端在
  `:details` 里回传的动态 key（弱密码原因）进 `runtimeKeys`；新引入的「key 存在数据
  字段里」的视图要扩展 `trFieldRe`，否则 `tr()` 会把 key 原样渲染出来（F4 的
  `settingsNav` 就是这么踩到的）。
- **表单**：`lib/forms.ts`（无头）按 CLJS 表单声明的 malli schema 复刻校验规则与报错
  文案，取文案的规则来自 `common/src/app/common/schema/messages.cljc`；
  `components/form.tsx` 是对应的视图层，F4 补齐了 `select`/`radio`/`textarea`。与
  `fm/submit-button*` 一致：表单不合法时提交按钮禁用，`onSubmit` 只会拿到干净数据。
  注意 `oneOf` 的成员校验先于长度校验，和 malli 的报错优先级一致。
- **通知**：`components/notifications.tsx` 复刻 `app.main.data.notifications` 的语义 ——
  单条通知槽、success/info/warning 7 秒自动消失、error 常驻、路由变化即隐藏。
- **弹窗**（F4）：`components/modal.tsx` 提供 `ModalProvider`/`useModal`/`ModalShell`，
  对应 `app.main.data.modal` 的单槽 modal；`ConfirmDialog` 是 `{:type :confirm}` 分支。
  Provider 挂在根布局，所以任何页面打开的弹窗都渲染在同一处。
- **主题**（F4）：`components/theme.tsx` 复刻 `app.util.theme` 的 `activate-theme` ——
  监听 profile 变化，把 `resolveTheme(profile.theme, 系统偏好)` 的结果写成 `<html>`
  的 class（暗色是 `default`，正是 `styles/tokens.css` 里语义色令牌的作用域）。

`@penpot/ui`（ds 的 input/button/menu/modal）仍未接线：该包是 React +
react-aria-components + SCSS modules，`exports` 指向未构建的 `dist/`。F4 的
settings 与 dashboard（F5.1）视图都沿用外壳临时样式（`styles/settings.css`、
`styles/dashboard.css`），menu/dropdown 用轻量自绘；`@penpot/ui` 的接线随后续
F5 切片（完整网格的右键菜单、team 切换菜单）按需评估。

## RPC 传输层

`lib/rpc.ts` 是 `frontend/src/app/main/repo.cljs` 中 `send!`/`cmd!` 的忠实移植：

- 端点：`<public-uri>/api/main/methods/<command>`
- 方法：`get-*` 命令用 GET（幂等，自动重试），其余用 POST
- 头部：`accept: application/transit+json,...`、`x-session-id`
- 凭据：`credentials: "include"`（cookie `auth-token`）
- 重试：仅 GET，最多 3 次，指数退避（1s/2s/4s），针对 `:network`/`:bad-gateway`/
  `:service-unavailable`/`:offline`
- 错误：按 `handle-response` 的 `:type` 分类抛出 `RpcError`

`cmdUpload`（F4）对应 repo.cljs 的 `multipart-upload`：Blob 字段转成 FormData 分片，
请求**不设** `content-type`（boundary 交给浏览器生成），响应仍按 Transit 解码。头像
上传 `update-profile-photo` 是第一个用例；F5.4 起支持 `[Blob, filename]` 元组，分片以
命名文件部件发送（对应 CLJS 的 `(list chunk "chunk-N")`）。`lib/uploads.ts`（F5.4）
移植 `app.main.data.uploads` 的分块会话：`create-upload-session` → 双并发
`upload-chunk` → 返回 session id，交给调用方的第三步（字体走 `create-font-variant`）。

`cmdSse`（F5.3）对应 repo.cljs 的 `::sse/*` 分支：POST 一个 transit body，但消费
`text/event-stream`。块解析器 `parseSseBlocks` 是纯函数（多 `data:` 行拼接、注释行
丢弃、keep-alive 跳过），`progress` 块走 `onMessage` 回调，`end` 块解出返回值，
`error` 块抛 `RpcError`；响应不是 SSE 时回落到普通 transit 解码。CLJS 用
`eventsource-parser`，外壳不引第三方包。回收站的批量恢复/彻底删除是第一个用例。

**尚未实现**（对应 repo.cljs 的分支，列为后续任务）：
`login-with-oidc`（`api/auth/oidc`）、`export`（`api/export`）。Transit 读侧 handler
（uuid/instant/bigint/duration/uri/ordered-map/pointer）已在 F1.1 移植；file-data
写侧 handler 随 viewer/workspace（F6/F9）一起补。

## 运行

前置：一个可访问的 Penpot 后端（默认 `http://localhost:6060`），可用 devenv 或
根目录的 compose 启动。

```bash
cd frontend-nextjs
pnpm install
pnpm dev          # http://localhost:3450
pnpm test         # lib/** 的无头逻辑单测（vitest）
pnpm translations # 重新生成 lib/translations/en.ts
pnpm build        # 生产构建；别在 dev server 运行时执行，原因见下
```

开发期 `next.config.mjs` 把 `/api/*` 反代到后端、`/assets/*` 反代到
`PENPOT_ASSETS_ORIGIN`，浏览器只面对单一源，既避免 CORS，也保住 cookie 的 SameSite。
生产环境沿用既有 nginx 反代，同样的相对 URL 不变即可工作。

**头像/缩略图是坏图？** 存储后端为 `fs` 时（compose 默认
`PENPOT_OBJECTS_STORAGE_BACKEND: fs`），后端对 `/assets/*` 返回**空 204 +
`x-accel-redirect`** 响应头（`backend/src/app/http/assets.clj` 的
`serve-object-from-fs`），真正吐文件的是 nginx 那个 `internal` 的
`/internal/assets` location（`docker/images/files/nginx.conf.template`）。Next
rewrite 不认识这个头，所以 dev 下要把 `PENPOT_ASSETS_ORIGIN` 指向正在跑的 penpot
frontend nginx（compose 里是 `http://localhost:9001`）：

```powershell
$env:PENPOT_ASSETS_ORIGIN = "http://localhost:9001"; pnpm dev
```

`next dev` 与 `next build` 共用同一个 `.next`：构建会把开发态 chunk 换成带哈希的生产
文件，正在跑的 dev server 随即对 `main-app.js` 返回 404，页面卡在「Loading...」不再
hydrate —— `SessionProvider` 的 `useEffect` 根本没机会执行，`get-profile` 也就永远不
会发出。要跑 `pnpm build` 先停掉 dev；已经踩到的话删掉 `.next` 再重启 dev 即可恢复。

WebSocket（`/ws/notifications`）不经 Next rewrite（rewrite 不转发 HTTP upgrade），
协作长连接直接连 `lib/config.ts` 里配置的后端源。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NEXT_PUBLIC_PENPOT_PUBLIC_URI` | 空（同源相对） | RPC 基址，对应 `cf/public-uri` |
| `NEXT_PUBLIC_PENPOT_BACKEND_ORIGIN` | `http://localhost:6060` | WS/直连后端源 |
| `PENPOT_BACKEND_ORIGIN` | `http://localhost:6060` | 服务端 rewrite 反代 `/api` 的目标 |
| `PENPOT_ASSETS_ORIGIN` | 同 `PENPOT_BACKEND_ORIGIN` | 服务端 rewrite 反代 `/assets` 的目标；`fs` 存储下要指向能处理 `x-accel-redirect` 的 nginx |
| `NEXT_PUBLIC_PENPOT_FLAGS` | 空 | 特性开关，对应 `cf/flags`；语法同 `penpotFlags`（`enable-x` / `disable-x`），在 `common/src/app/common/flags.cljc` 的默认集之上叠加 |
| `NEXT_PUBLIC_PENPOT_TERMS_OF_SERVICE_URI` | 空 | 注册页条款链接，对应 `cf/terms-of-service-uri` |
| `NEXT_PUBLIC_PENPOT_PRIVACY_POLICY_URI` | 空 | 注册页隐私链接，对应 `cf/privacy-policy-uri` |
| `NEXT_PUBLIC_PENPOT_VERSION` | 空（隐藏版本行与 check-for-updates 入口） | dashboard profile 菜单「关于 Penpot」显示的版本号，对应 `(:base cf/version)`；编译期内联，须在 dev/build 启动时设置 |

## 下一步

见根目录 `rewrite.md` 的「阶段 F：frontend-nextjs」。F5 dashboard 已切片推进，F5.1
（外壳 + 数据基座 + `/dashboard/recent` + 侧边栏 + profile-section 菜单）、F5.2
（完整网格 `grid.cljs`：多选、右键/…菜单、重命名/复制/移动/删除、layout 切换、inline
编辑、check-for-updates，与 `/dashboard/files`）、F5.3（`/dashboard/libraries` 摘要卡、
`/dashboard/search` 三态占位、`/dashboard/deleted` 回收站：SSE 批量恢复/彻底删除 +
进度组件 + 项目级菜单 + Recent/Deleted 页签）、F5.4（`/dashboard/fonts`：上传队列 +
已安装字体表——TTF/OTF/WOFF 元数据解析与高度告警、分块上传、@font-face 注册表、
重命名/删除/下载；`/dashboard/fonts/providers` 页头占位；补回 F5.3 推迟的 typography
样本字体加载）与 F5.5（团队管理：`/dashboard/members` 成员表与三种离开流程、
`/dashboard/invitations` 排序表与重发/删除、`/dashboard/webhooks` 列表与新建/编辑、
`/dashboard/settings` 团队照片与计数；recent 页 team-hero；change-owner 与 team-form
弹窗；侧边栏团队名旁的「…」团队管理菜单——成员/邀请/webhook/设置/重命名/离开/
删除）已完成。缩略图暂只展示既有 media（media-worker 生成随 F9），binfile 导入/导出
与 templates 分区留到 F5.6，进度组件的 `:error` 分支同批。下一步 F5.6：templates
分区、binfile 导入/导出与 dashboard 快捷键注册表（补齐 settings/shortcuts 占位）。
`@penpot/ui` 接线继续推迟（menu/modal 由外壳组件承担）。organization/team 切换留到
F5.7（其团队管理菜单已随 F5.5 收尾落地，余组织列与切换器）。
