# backend-rust（Rust + axum）

Penpot 的 Rust 后端，用绞杀者模式逐步承接 `backend/`（Clojure/JVM）的职责。

## 当前状态

**计划已批准，实现尚未开始**（本目录还没有 `Cargo.toml` 与代码）。

- 执行计划：`PLAN.md`（里程碑 M0–M8、已核对的契约事实、风险、红线）
- 上下文快照（换机器续接）：`HANDOFF.md`

## 门禁口径（2026-10-16 起）

> **实现但不接入部署。**

可以做：写实现、写单测/属性测试、本地 `cargo run` 起来自测。

不做：接 nginx/反代、加命令级灰度开关、改 `docker/`、改根 `package.json` / `pnpm-workspace.yaml`、
改 `scripts/ci` 现有 target、承接任何线上流量。任何切换都另立决策。

`backend/`（Clojure）在本阶段仍是**只读参照**，不改一行；需要后端配合（例如给命令补
`::sm/result`）时先登记、单独批准。

## crate 划分（无 `pp-` 前缀）

一个 Cargo 工作区，`crates/<短名>`；`render-wasm` 保持独立、不并入：

```
backend-rust/
├── Cargo.toml            [workspace] + [workspace.dependencies] 锁版本
├── Makefile              本地 build/test/fmt/lint/check-offline/capture（不接 CI）
├── fixtures/             transit 金样本（transit-js 预言机生成）；online/ 不入库
└── crates/
    ├── transit/          Transit+JSON reader/writer + Penpot 标签 + 缓存语义
    ├── errors/           ex-data(:type/:code/:hint) → HTTP status/body
    ├── config/           PENPOT_* env + flags（enable-/disable-）
    ├── session/          JWE a256kw+a256gcm + HKDF-BLAKE2b-512 + claims/verify
    ├── db/               sqlx 池、kebab→snake 命名、事务包装（运行时查询）
    ├── storage/          storage_object 闭包 metadata、bucket、去重、GC、fs/s3
    ├── worker/           cron、task 状态机、dispatcher 认领、runner 循环
    ├── ws/               msgbus topic/订阅计数、消息多态、axum WebSocket
    └── rpc/              axum 服务：路由 + 中间件管道 + 命令 Registry
```

依赖方向：`rpc → {transit, errors, config, session, db, storage, worker, ws}`，下层互不引用。

顺序（`PLAN.md` §5）：`M0 workspace → M1 transit（关键路径）→ M2 errors+config ∥ M3 rpc(axum) → M4 session
→ M5 storage → M6 worker → M7 ws`。`transit` 先做，因为 RPC 请求体、应答体、`task.props`、session payload
全是 transit。

## 不在范围内

- `render-native`（原规划 B1）：`render-wasm` 目前没有 headless-native API（`cfg(target_arch="wasm32")` +
  GL `gpu_state`），要先抽平台无关 core，且需要 file-data 解码 → 暂缓。
- **file data blob**：`file.data` / `file_data.data` 是 **Fressian v4/v5**（`app.common.fressian`，JVM 专有，
  Rust 无实现）。本阶段不读不写，也不引入 `fressian`/`lz4`/`zstd` 依赖。
  因此 `add-file-transient-changes`、binfile 导入导出、files 写路径、thumbnails 生成、nitrate
  一律列为永久排除。

## 认证说明

Penpot **不用 JWT 明文令牌**：会话令牌是 JWE（`A256KW` + `A256GCM`），payload 为 transit 编码，密钥由
HKDF(HMAC-BLAKE2b-512, salt="tokens", 32B) 从 `PENPOT_SECRET_KEY` 派生；且「密码学有效」不等于「已认证」
——登出/吊销/`is_blocked` 都在 **`http_session_v2`** 表里（旧 `http_session` 已由迁移 `0155` 删除）。
任何 Rust 服务要么查同一张表，要么由统一网关代查一次并转发身份头。

## 契约事实与出处

线格式、端点、错误映射、中间件顺序、worker/storage 语义等**已核对事实**集中在
`PLAN.md` §2，每条都标了来源文件；换机器后的自检与采集清单在 `HANDOFF.md` §4。
