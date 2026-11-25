# backend-rust（Rust + axum）

Penpot 的 Rust 后端，用绞杀者模式逐步承接 `backend/`（Clojure/JVM）的职责。

## 当前状态

**M0 工作区基线、M1 `transit`（离线部分）、M2 `errors` + `config`、M3 `rpc` 骨架、
M4 `session`、M5 `storage`（离线部分）、M6 `worker`（Redis 队列已验、PG 待验）、
M7 `ws` 完成（2026-11-25）。**

- 工作区：`Cargo.toml`（resolver 3、成员 `crates/*`）、`Cargo.lock`、`rust-toolchain.toml`（stable）、
  `.gitignore`（`target/`、`fixtures/online/`）与本地 `Makefile` 已就位。
- M1 已有：`crates/transit` 的 reader/writer/cache/value、transit-js 金样本语料、畸形输入与
  proptest round-trip；金样本 103 条，缓存长度按 UTF-16 code unit 计数；URI 写
  `["~#uri", …]` 以对齐 Penpot 的 handler。
  `serde_json` 打开 `float_roundtrip`，保证写出的浮点数能逐字节读回。
- T1.6 已落成 `crates/transit/TODO-ONLINE.md`：10 项待真实应答确认的形态与 4 项离线定案。
  真实语料（C2）需要 devenv；采到后只回填金样本，不改当前代码路径。
- M2 已有：`crates/errors` 逐分支对齐 `backend/src/app/http/errors.clj`（401/403/405/400/409/413/
  429/404/500/503/504），`Cause` 同时覆盖受控错误、PostgreSQL、IO 与包装异常；`HttpError`
  实现 axum `IntoResponse`，map body 用 verbose transit 并标 `application/transit+json`。
  `crates/config` 解码 18 个 `PENPOT_*` 键、应用 `enable-`/`disable-` 与两条派生 flag；
  未识别键进 `Config::unknown`，再由 `pending` / `unrecognized` 区分「schema 已定义、尚未接」与
  真未知；schema 中尚未接的键进 `PENDING_KEYS`，两边增删都会让测试失败。
- M3 已有：`crates/rpc` 的三组路由（`/api/main/methods`、`/api/rpc/command`、`/api/management/methods`）
  与 4 条 308 重定向；`Registry` + `AuthPolicy`（默认要求登录）、薄参数 schema、query/transit body
  合并、compact/verbose transit 应答、`nil`→204、SSE 固定帧、`x-shared-key`/`x-client` 检查、
  CORS（allowlist + 预检 204）、`inet/parse-request` 的 IP 优先级。本地 `cargo run -p rpc`
  起 `127.0.0.1:6061` 的 DB-free 服务。29 条 `oneshot` 测试加 3 条 `rpc.clj` 源码契约测试。
  sqlx 事务、multipart 与长连接 SSE 分别留给 M5/M7；multipart 还缺本地缓存的 `multer` 依赖。
- M4 已有：`crates/session` 的 `TokenKey`（HKDF-HMAC-BLAKE2b-512，salt `"tokens"`，空 `info`，32B）、
  `TokenCodec`（RFC 7516 compact，A256KW + A256GCM，`{alg,enc,kid,ver}` 头，IV 12B、tag 16B）、
  `SessionClaims`/`Claims`（保留未知 claim，`exp` 严格早于才过期，`exp` 先于 `iss`）与
  `CookiePolicy`/`SessionCookie`（7/30 天与 6 小时默认、CORS→SameSite=None、Strict/Lax、Secure、
  `Comment="Renewal at: …"`、清除写 `Max-Age=0`）。50 条通过 + 1 条 ignored；RFC 3394 三条标准向量，
  另有 `fixtures/gen-jwe-vector.mjs` 用 Node/OpenSSL 生成第二实现向量，编码端逐字节匹配。
  `tests/buddy_vector.rs` 是 C1 钩子（`#[ignore]`，等真实 token）。
- M5 已有：`crates/storage` 的 11 bucket 闭包 metadata（verbose transit / plain JSON 双读双写，
  旧 `reference`/`upload-id`/`chunk-index` 归一化）、BLAKE2b-256 内容 hash、`pending → valid`
  写入状态机、dedup 命中/修复/未命中/跳过、软删除与过期读取、`ObjectStore` trait 的 FS 与 S3
  实现、GC 三态阈值与三条 `FOR UPDATE SKIP LOCKED` SQL 常量。FS 先写临时文件再原子替换；
  S3 走 `aws-config` 默认凭证链，读新旧两组 `PENPOT_*_S3_*` 环境变量，presigned GET 支持
  `max_age` 与 `content-disposition`。45 条通过 + 1 条 ignored（真实 S3 桶）。
  `sqlx` 仓储与 GC 执行器、真实桶/PG 验证留到有 devenv 时补。
- M6 已有：`crates/worker` 的 Quartz cron 解析（六段加可选 year，覆盖 `L`/`W`/`#`/名称/
  范围/步长）、六态 task 状态机、Transit JSONB props、5 分钟丢失重排、24 小时 orphan
  失败、`FOR UPDATE SKIP LOCKED` 认领、`tenant:queue` 分组与 Redis payload 编解码；
  runner 覆盖 scheduled 时间复核、重试指数增长、未知 handler 完成语义；注册 sendmail、
  objects-gc、tasks-gc、session-gc、run-webhook 五个 handler。`RedisTaskQueue` 使用独立
  RPUSH 连接与 BLPOP 连接池。68 条默认测试 + 5 条 Redis live；`sqlx` 与 Clojure↔Rust
  混合集群验证留到有 PG/devenv 时补。
- M7 已有：`crates/ws` 的 msgbus 前缀与本地订阅计数、`RedisBus`/`InMemoryBus`、
  `subscribe-file`/`subscribe-team`/`unsubscribe-file`/`pointer-update`/`broadcast`/
  `keepalive` 多态、presence 与心跳；`/ws/notifications?session-id=<uuid>` 的鉴权、
  RFC 6455 upgrade、Transit 文本帧与 8802 超时关闭。`RedisBusClient` 使用发布/订阅
  双连接，首订阅开通道、末退订关通道，断线重连后重订阅。33 条默认 crate 测试 +
  7 条 Redis live 用例；浏览器联调与混合集群对拍见 `crates/ws/tests/DESIGN.md`。
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
    ├── transit/          ✅ Transit+JSON reader/writer + Penpot 标签 + 缓存语义（含 verbose）
    ├── errors/           ✅ ex-data(:type/:code/:hint) → HTTP status/body（axum IntoResponse）
    ├── config/           ✅ PENPOT_* env + flags（enable-/disable-）
    ├── session/          ✅ JWE a256kw+a256gcm + HKDF-BLAKE2b-512 + claims/verify + cookie
    ├── db/               sqlx 池、kebab→snake 命名、事务包装（运行时查询）
    ├── storage/          ✅ storage_object 闭包 metadata、bucket、去重、GC、fs/s3（S3 真实桶待验）
    ├── worker/           ✅ Quartz cron、task 状态机、dispatcher、runner、Redis 队列
    ├── ws/               ✅ msgbus、消息多态、axum WebSocket、Redis 适配器
    └── rpc/              ✅ axum 服务：路由 + 中间件管道 + 命令 Registry（DB-free 骨架）
```

依赖方向：`rpc → {transit, errors, config, session, db, storage, worker, ws}`，下层互不引用。

顺序（`PLAN.md` §5）：`M0 workspace → M1 transit（关键路径）→ M2 errors+config ∥ M3 rpc(axum) → M4 session
→ M5 storage → M6 worker → M7 ws`。M0–M7 已落地；M6 的 PG 仓储仍待 live PostgreSQL。
`transit` 先做，因为 RPC 请求体、应答体、
`task.props`、session payload 全是 transit。

## 本地验证（不接 CI）

```bash
cd backend-rust
make build          # cargo build --workspace
make test           # cargo test --workspace
make lint           # cargo clippy --workspace --all-targets -- -D warnings
make check-offline  # cargo build/test --workspace --offline
```

Windows 没有 `make` 时直接跑括号里的 cargo 命令。M0 验收等价于
`cargo fmt --all --check`、上面的 `clippy`、`cargo test --workspace` 与
`cargo build --workspace --offline` 全部退出 0。

M5 起依赖 `aws-sdk-s3 1.123` / `aws-config 1.8`，二者声明 Rust 1.91，因此 workspace
`rust-version` 同步为 1.91。当前本机 rustc 1.98 已验证。

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
