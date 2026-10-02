# backend-rust（占位，受门禁约束）

Penpot 的 Rust + axum 后端，采用绞杀者模式逐步承接 `backend/`（Clojure/JVM）的
职责。**当前仅为目录占位与规划，尚无任何实现代码。**

## 硬性门禁

> 在 `frontend-nextjs` 完成对应功能迁移之前，不改造后台。

具体含义：

- 本轮只做前端（`frontend-nextjs`）。在前端各路由组迁移并验证对等之前，
  **不在本目录新增实现代码、不改动 `backend/`**。
- 前端迁移期间，`frontend-nextjs` 直接复用既有 Clojure 后端（Transit RPC
  `/api/main/methods/*`、WS `/ws/notifications`），后端保持不动。
- 只有当某个能力的前端消费方已落在 `frontend-nextjs` 上、且需要新的服务端行为时，
  才在 `backend-rust` 里以独立服务的形式增量引入，并由网关/反代与 Clojure 后端并存。

## 规划的服务（axum）

依据架构图 `.archify/architecture-penpot-20261002-123416/penpot-architecture.html`
中的 `backend` 及其下游连线，按「性能关键路径优先、核心业务最后」的顺序拆分为
独立 crate（一个 Cargo 工作区）：

```
backend-rust/
├── Cargo.toml            工作区（render-wasm 保持独立，不并入）
└── crates/
    ├── render-native/    axum 渲染/导出服务（复用 render-wasm 的平台无关核心）
    ├── storage/          对象存储服务（S3/本地/MinIO），对齐 backend/src/app/storage
    ├── worker/           异步任务 runner（Postgres task 表 + Redis 交接）
    ├── ws-gateway/       WebSocket 协作网关（tokio-tungstenite），桥接 Clojure 端
    └── rpc/              逐步承接 /api/main/methods 命令（最后，风险最高）
```

排序理由（与架构图的异步任务/导出/协同视图一致）：

1. **render-native / storage / worker**：CPU/IO 密集、边界清晰、与核心业务弱耦合，
   是最低风险的 Rust 切入点；`render-wasm` 已提供现成的 Rust 渲染核心。
2. **ws-gateway**：长连接与心跳/重连，增强而非重写；会话校验仍需查 `http_session`。
3. **rpc**：核心业务命令，最后迁移，且需先有契约（OpenAPI / RPC 清单）与响应类型。

## 认证说明

Penpot **不用 JWT**：会话令牌是 JWE（`A256KW` + `A256GCM`），载荷为 transit+json，
密钥由 HKDF-HMAC-BLAKE2b-512 派生；且「密码学有效」不等于「已认证」——登出/吊销/
`is_blocked` 都在 `http_session` 表里。任何 Rust 服务要么查同一张表，要么由统一网关
代查一次并转发身份头。详见 `rewrite.md` 的安全小节。

## 状态

未开始（受门禁约束）。规划与任务分解见根目录 `rewrite.md` 的「阶段 B：backend-rust」。