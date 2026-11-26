# backend-rust 上下文快照（换机器续接用）

> 目的：在另一台机器开 devenv 后，新会话**只读这一份 + `PLAN.md`** 就能接着干，不依赖上一个会话的记忆。

## 0. 一句话任务

用 **Rust + axum** 在 `backend-rust/` 里逐步承接 `backend/`（Clojure/JVM）的能力，**实现但不接入部署**：
可以写实现和测试，但不接 nginx、不加灰度开关、不改 `backend/` 一行、不改 `docker/` 与 `scripts/ci` 现有 target。

## 1. 仓库状态快照

| 项 | 值 |
| --- | --- |
| HEAD（快照时） | `02da8b1c9a` `:wrench: Add dev:rust entrypoint to frontend-nextjs` |
| 工作区 | M0–M7、M9–M17 已提交；M18 登录纵切在工作区（未提交）；`.g2-tmp/` 未跟踪 |
| 阶段 F/G | F 已收口；G0–G5 已完成，见 `rewrite.md` §7.92–§7.96 |
| 阶段 B（M0–M7） | **M0 ✅**；**M1 `transit` 离线部分 ✅**：103 条金样本、round-trip 1000 例、畸形输入、`TODO-ONLINE.md`；**M2 ✅（2026-11-24）**：`errors` 全分支 + verbose 应答 + `config` 18 键与源码表对齐；**M3 ✅（2026-11-24）**：`rpc` 三组路由、默认鉴权、参数/应答管线，29 条 oneshot + 3 条 `rpc.clj` 契约测试；**M4 ✅（2026-11-24）**：`session` 的 HKDF、RFC 3394 AES-KW、A256KW/A256GCM JWE、claims/verify、cookie，50 条 crate 测试 + OpenSSL 交叉向量；**M5 ✅（2026-11-24）**：`storage` 的 metadata、去重状态机、FS/S3、GC 纯逻辑与执行器，45 条 + 1 ignored，PG 仓储与 GC 见 M12/M13；**M6 🔧（2026-11-25）**：`worker` 的 cron、状态机、dispatcher、runner、五个 handler 与 Redis 队列，68 条默认测试 + 5 条 Redis live；PG 仓储已落地、混合集群待 devenv；**M7 ✅（2026-11-24）**：`ws` 的 msgbus、协议多态、心跳、axum 路由与 Redis 适配器，33 条默认测试 + 7 条 Redis live |
| 阶段 B（M9–M18） | **M9 ✅（2026-11-25）**：`rpc` 的 `TokenResolver` 接 cookie/Bearer 会话令牌与 `Token` 访问令牌，16 条 auth 单测 + 10 条 oneshot，存储走 trait；**M10 ✅（2026-11-25）**：`db` 的池/命名/错误/事务助手与 `pg` 的会话、访问令牌存储，鉴权 trait 改 async；**M11 ✅（2026-11-25）**：worker 的 `PgTaskRepository` 与 `DispatchBatch` 事务边界，pg 4 条单测 + 1 条 live `#[ignore]`；**M12 ✅（2026-11-25）**：storage 的 `PgStorageRepository`，pg 4 条 storage 单测 + 1 条 live `#[ignore]`；**M13 ✅（2026-11-25）**：storage 的 `StorageGc` 三阶段执行器与 `PgStorageGcRepository`，storage 7 条单测 + 1 条 live `#[ignore]`；**M14 ✅（2026-11-25）**：`PgTasksGc` 与 `PgSessionGc`，pg 2 条单测 + 2 条 live `#[ignore]`；**M15 ✅（2026-11-26）**：`crates/httpclient` 的 SSRF 校验与 `ReqwestTransport`，`PgWebhookRunner` 写 `webhook_delivery` 并在三次失败后停用，httpclient 12 条 + pg 7 条单测 + 2 条 live `#[ignore]`；**M16 ✅（2026-11-26）**：`PgObjectsGc` 按 11 个 procedure 清理软删域对象并做 profile/team/project/file 级联与存储对象 touch，pg 6 条单测 + 1 条 live `#[ignore]`；**M17 ✅（2026-11-26）**：`crates/mailer` 的 SMTP/MIME 投递、8 个 SMTP 配置键、TLS/STARTTLS 与 AUTH，37 条测试 + 1 条 live `#[ignore]`；**M18 ✅（2026-11-26）**：`password` 的 buddy `argon2id` 校验、`login-with-password`/`get-profile`、`http_session_v2` 写入与 JWE cookie、`server` 可运行二进制，rpc 4 条 + password 6 条 + pg 1 条 live；M8 不交付；C1/C2 真实向量与应答语料待 devenv |
| `rewrite.md` | §7.96 为 G5 收口记录，§7.100 为 backend-rust M3，§7.101 为 M4，§7.102 为 M5，§7.103 为 M6，§7.104 为 M7，§7.105 为 M7 Redis 适配器，§7.106 为 M6 Redis 队列，§7.107 为 M9 鉴权接线，§7.108 为 M10 `db`/`pg`，§7.109 为 M11 worker PG 仓储，§7.110 为 M12 storage PG 仓储，§7.111 为 M13 storage GC 执行器，§7.112 为 M14 `tasks-gc`/`session-gc` 服务，§7.113 为 M15 `run-webhook`，§7.114 为 M16 `objects-gc` 服务，§7.115 为 M17 `sendmail`，§7.116 为 M18 登录纵切；里程碑状态见本文与 `PLAN.md` |

## 2. 已拍板决策（不要重议，除非用户改口）

| # | 决策 |
| --- | --- |
| 1 | 门禁改为「**实现但不接入部署**」 |
| 2 | Web 框架 **axum**（本地缓存版本 0.8.9） |
| 3 | crate 命名**不加任何前缀**：`transit / errors / config / session / db / storage / worker / ws / rpc` |
| 4 | `transit` 值模型 = **自建 enum**（不用 `serde_json::Value` 打标；必须能区分 `Keyword`↔`String`、vector↔array） |
| 5 | JWE 兼容性向量：由用户开 devenv 后采集（§4 清单 C1）；采到前 `session` 标「结构自洽、兼容性待验」 |

保守默认（可被否决）：DB 层用 `sqlx` 运行时查询而非 `query!` 宏；M3 `rpc` 骨架保持 DB-free；
一个里程碑一个 commit、只 commit 不 push、须过 `scripts/check-commit`；**未获明确要求不 commit**。

## 3. 执行顺序与总量（详见 `PLAN.md` §4–§5）

```
M0 workspace → M1 transit（关键路径）→ M2 errors+config ∥ M3 rpc(axum)
                                        → M4 session → M5 storage → M6 worker → M7 ws
M8 rpc 只读命令承接 = 本阶段不交付（前置：C3 DDL + C4 OpenAPI + 补齐 ::sm/result + devenv）
```

约 50 人日。`transit` 排第一的理由：RPC 请求体、应答体、`task.props`、session payload **全是 transit**。

## 4. 新机器开工清单

**A. 先自检（30 秒）**

```bash
rustc --version && cargo --version
ls ~/.cargo/registry/cache/*/ | grep -E '^(axum|tokio|sqlx|aes-kw|aes-gcm|hmac|hkdf|blake2|redis|proptest|indexmap)-' | sort
node -e "require('<repo>/frontend-nextjs/node_modules/transit-js')"   # transit 预言机（跑过 pnpm install 即可用）
psql -h localhost -p 5432 -U penpot -d penpot -c 'select 1'           # C1–C4 前置（本机 WSL relay）
psql -h localhost -p 5433 -U penpot -d penpot -c 'select 1'           # 旧机器 compose 端口
```

连接额度：`DbOptions::default()` 复刻 Hikari（min = max = 60）。`server` 起来后
`127.0.0.1:5432` 会占掉 60 条连接，PostgreSQL 默认 `max_connections=100`；此时再跑
live 测试会得到 `PoolTimedOut`。M18 的 `auth_live` 是先停 `server` 再跑的。

旧机器实测：rustc/cargo 1.98.0；registry 走 `sparse+https://rsproxy.cn/index/`（crates.io 直连被 TLS 拦、
`static.crates.io` 通）；`axum 0.8.9 / tokio 1.53.1 / sqlx 0.9.0 / redis 0.27.6 / tokio-tungstenite 0.28.0 /
aes-kw 0.3.1 / aes-gcm 0.11.1 / hkdf 0.13 / hmac 0.13 / blake2 0.11 / uuid 1.26.1 / chrono 0.4.45 /
indexmap 2.14.2 / tracing 0.1.44 / thiserror 2.0.21 / proptest 1.11 / aws-sdk-s3 1.123 / reqwest 0.13.5 /
base64 0.23.1 / mime / url / hex` 为旧机清单。当前机器实测 M0–M7 实际声明的依赖均可离线构建。
`redis 0.27.6` 已联网拉取一次并锁进 `Cargo.lock`。依赖只选已验证版本并**提交 `Cargo.lock`**。

**B. 已完成切片 = M0 + M1 的 T1.1–T1.6（离线部分）+ M2 + M3 + M4 + M5 + M6 + M7 + M9 + M10 + M11 + M12 + M13 + M14 + M15 + M16 + M17 + M18**

- M18：`crates/password`（buddy 六段 `argon2id`）、`crates/rpc/src/commands/auth.rs`
  （`login-with-password`/`get-profile`）、`crates/pg/src/profile.rs`
  （profile 读取 + `http_session_v2` 写入）、`commands/dashboard.rs` +
  `pg/src/dashboard.rs`（`get-teams`/`get-projects`）、`crates/server`（可运行
  二进制）。起服务要 `PENPOT_SECRET_KEY` 与 `PENPOT_DATABASE_URI`；
  `cargo run -p rpc` 仍是 DB-free 示例。本机已验证 Next `:3450` → Rust `:6061`
  的登录、cookie、`get-profile` 与 `/dashboard/recent` 首次渲染。

- M0：workspace（`members = ["crates/*"]`、`[workspace.dependencies]` 锁版）、`rust-toolchain.toml`（用 `stable`，
  别把 channel 钉死到具体小版本）、`.gitignore`（`target/`、`fixtures/online/`）、`backend-rust/Makefile`
  （`build/test/fmt/lint/check-offline/capture`，**不接 `scripts/ci`**）
- M1：`crates/transit` reader/writer + `fixtures/gen-transit-corpus.mjs`（用 transit-js 当预言机产样本）
  + 逐字节对拍 + `proptest` round-trip；缓存长度按 UTF-16 code unit 计数；URI 写
  `["~#uri", …]`；待确认项集中在 `crates/transit/TODO-ONLINE.md`
- M2：`crates/errors` 的 `ErrorType`/`ErrorCode`/`Cause`/`HttpError`，分支逐条对齐
  `backend/src/app/http/errors.clj`；`IntoResponse` 用 verbose transit；`crates/config` 的
  `PENPOT_*` 键表/类型解码/flag 派生/`unknown` → `pending` / `unrecognized`；flag、
  `schema:config`、PG hint 三张源码表各有 diff 测试。
- M3：`crates/rpc` 的 `context / registry / params / response / router` 与本地 `main`。三组路由、
  4 条 308 重定向、GET/HEAD 的 `get-` 检查早于命令查找、默认 `AuthPolicy` 要求登录、三条鉴权错误、
  query/transit body 合并、薄参数 schema、`nil`→204、compact/verbose transit、SSE 固定帧、
  `x-shared-key`/`x-client`、CORS（allowlist + 预检 204）、IP 优先级（含 socket peer）。
  29 条 `oneshot` + 3 条 `tests/clj_contract.rs`；完整 workspace 门禁 142 例通过。multipart 因缺 `multer` 未接，
  真实会话/事务/长连接 SSE 分别留 M4/M5/M7。
- M4：`crates/session` 的 `key / aes_kw / jwe / claims / cookie / error`。
  HKDF 用 `SimpleHkdf<Blake2b512>`（BLAKE2b 非 eager hash），输出与 OpenSSL
  `hkdfSync("blake2b512", …)` 一致；RFC 3394 三条标准向量通过；JWE 五段严格校验、AAD 为
  protected 段、IV 12B、tag 16B；`Token::verify` 先 `exp` 后 `iss` 且 `exp == now` 有效；
  cookie 走 Java 的 RFC 1123（日不补零）。`fixtures/gen-jwe-vector.mjs` 产 Node/OpenSSL 向量，
  Rust 编码端逐字节匹配、解码端解出 claims；`tests/buddy_vector.rs` 是 C1 钩子（`#[ignore]`）。
  50 条 crate 测试；workspace 全量 192 条通过 + 1 ignored。真实 buddy 向量仍待 C1。
- M5：`crates/storage` 的 `content / error / fs / gc / metadata / object / path / repository /
  s3 / service / store`。11 bucket 闭包 metadata 与双编码、BLAKE2b-256、先 `pending` 后 `valid`
  的写入顺序、dedup hit/repair/miss/skip、软删除与过期读取、FS 原子替换、S3 环境变量与 presign、
  GC 三态阈值与 SQL 常量。crate 45 条通过 + 1 ignored；workspace 237 条通过 + 2 ignored。
  真实 S3 桶用 `PENPOT_TEST_S3_BUCKET` + AWS 凭证解锁；`sqlx` 仓储与 GC 执行器见 M12/M13，
  live PG 仍未验。
- M6：`crates/worker` 的 `cron / dispatcher / error / handler / queue / repository / runner /
  task / tasks`。Quartz 六段加可选 year、六态 task 状态机、Transit JSONB props、5 分钟丢失重排、
  24 小时 orphan 失败、按优先级认领、`tenant:queue` 分组与 Transit payload；runner 复核
  scheduled 时间、按 `retry_num` 指数退避，未知 handler 按 Clojure 行为完成。五个 offline
  handler 全部经 trait 注入。`RedisTaskQueue` 用 RPUSH 发布连接与 BLPOP 连接池支持并行
  runner。crate 68 条默认测试 + 5 条 Redis live；workspace 338 条通过 + 14 ignored。
  `sqlx` 与混合集群验证仍留到 live PG/devenv。
- M7：`crates/ws` 的 `bus / error / heartbeat / protocol / redis / server`。`prefix_topic` 为
  `<tenant>.<topic>`；`InMemoryBus` 复刻首订阅/末退订与幂等清理；协议覆盖
  subscribe-file/subscribe-team/unsubscribe-file/pointer-update/broadcast/keepalive，
  team 组织 topic、presence、发送者字段与回环过滤；服务端校验 session-id、鉴权、
  RFC 6455 accept、Transit 文本帧与 5 秒心跳（3 个未答 ping 后 8802 关闭）。
  `RedisBusClient` 用发布/订阅双连接，首订阅开通道、末退订关通道，断线按退避重连并
  重订阅。crate 33 条默认测试 + 7 条 Redis live；workspace 337 条通过 + 9 ignored。
  浏览器联调、混合集群对拍与强制断线自动化仍待补，设计见 `crates/ws/tests/DESIGN.md`。
- M9：`crates/rpc/src/auth.rs` 的 `TokenResolver`。凭据顺序照 `wrap-auth`：cookie 先于
  `Authorization`，空 cookie 视为没有；`Bearer` 解析会话令牌（kid/ver=1、iss
  `authentication`、按 `:sid` 查 `http_session_v2`、idle 7 天），`Token` 解析访问令牌
  （iss `access-token`、按 `:tid` 查 `access_token`）。解码失败降级为未认证，存储错误
  上抛 500。`SessionStore`/`AccessTokenStore` 是 trait，`rpc` 不依赖 sqlx。
  `session::decode_header` 补上 `decode-header` 语义。16 条 auth 单测 + 10 条 oneshot；
  workspace 366 条通过 + 14 ignored。PG 存储、cookie 续期写回与 `::actoken/type` 未做。
- M10：`crates/db` 的 `DbOptions`（Hikari 默认 + 300s 两条会话超时）、懒连接池、
  `read_only` 会话、`table_name`/`snake_case` 与 `DbError → Cause`；`crates/pg` 的
  `PgSessionStore`（`http_session_v2`，跳过空 profile）与 `PgAccessTokenStore`
  （`access_token`，过滤过期行）。鉴权 trait 全部改 async。`sqlx` 固定 `=0.9.0`，
  只开 `runtime-tokio`/`postgres`/`uuid`。db 11 条单测 + doc test；pg 2 条 live
  `#[ignore]`；workspace 378 条通过 + 18 ignored。live PG 实跑与示例二进制接线未做。
- M11：`crates/pg/src/task.rs` 的 `PgTaskRepository`。`worker::DispatchBatch`
  让 dispatcher 的丢失重排、orphan 清理、`FOR UPDATE SKIP LOCKED` 认领与
  `mark_scheduled` 共用一个事务；空批次 commit，Redis 失败回滚。行映射把 `props::text`
  交给 verbose Transit，时间戳统一毫秒；`get`/`mark_running`/`save` 对齐
  `app.worker.runner`，`insert` 对齐 `sql:insert-new-task`（`$3::text::jsonb`）。
  pg 4 条单测 + 1 条 live `#[ignore]` 往返；worker 2 条 batch commit 测试；
  workspace 384 条通过 + 19 ignored。live PG 与混合集群未验。
- M12：`crates/pg/src/storage.rs` 的 `PgStorageRepository`。`get_valid` 只认
  `status='valid'` 且 `deleted_at IS NULL`；`find_dedup` 用 `UNION ALL` 同时匹配
  legacy `~:hash`/`~:bucket` 与 plain `hash`/`bucket`；`insert` 写 `deleted_at`
  （对应模型的 `expired_at`）、`touched_at`、`status`、`created_at`；
  `promote`/`set_touched`/`soft_delete` 对齐 `app.storage` 的三条更新。metadata 默认
  verbose Transit，可切 plain JSON；读取走 `metadata::text` 解码，时间戳统一毫秒。
  pg 4 条 storage 单测 + 1 条 live `#[ignore]` 往返。
- M13：`crates/storage/src/gc_runner.rs` 的 `StorageGc`。pending、touched、deleted
  三个循环默认 100/10/25 行；`GcTransaction` 把选择、更新、删除与提交放在同一事务，
  `GcReport` 记录 reclaim/freeze/delete/defer/abandon 与 blob 失败。touched 按 bucket
  查六个引用表，poison 行延后一天；deleted 在事务内批量删 blob，失败
  `deletion_attempts+1` 并延后一天，第 7 次放弃。`crates/pg/src/storage_gc.rs` 的
  `PgStorageGcRepository` 提供三组 `FOR UPDATE SKIP LOCKED` 与所有更新语句。
  storage 7 条 `gc_runner` 单测 + pg 1 条 live `#[ignore]`（pending 行与 blob 回收）。
- M14：`crates/pg/src/task_services.rs` 的 `PgTasksGc` 与 `PgSessionGc`。
  `tasks-gc` 在事务内执行 `worker::SQL_TASKS_GC`，`rollback?` 为真时执行后回滚；
  默认最小年龄 7 天。`session-gc` 用 idle/absolute 两条阈值删除 `http_session_v2`，
  absolute 小于 idle 时在连库前拒绝。pg 2 条单测 + 2 条 live `#[ignore]`。
- M15：`crates/httpclient` 的 `SsrfPolicy`（http/https、全部地址逐一检查、白名单与追加
  CIDR）与 `ReqwestTransport`（禁重定向、无系统代理、4s 超时、校验地址固定）。
  `crates/pg/src/webhook.rs` 的 `PgWebhookRunner` 生成 JSON/transit/form body，200/204
  成功，其余 `unexpected-status:<code>`，每次投递写 `webhook_delivery`，三次失败停用。
  httpclient 12 条 + pg 7 条单测，2 条 live `#[ignore]`。
- M16：`crates/pg/src/objects_gc.rs` 的 `PgObjectsGc`。按 `deletion-proc-vars`
  的 11 个 procedure 顺序逐段提交事务，每段先关 deletion protection，再分块循环到
  0；`chunk-size` 默认 100，`skip-delay` 把软删时间戳推到 3650 天后。上传会话先删
  chunk 映射并 touch 存储对象；profile 只级联 owned teams，team/project/file 按
  Clojure `delete-object` 软删子行。touch 用墙钟 `now()`，软删用运行时间戳；
  `file_data.metadata->>'storage-ref-id'` 非法时报错。pg 6 条单测 + 1 条 live
  `#[ignore]`（会清空库内所有待清软删行，需一次性数据库）。
- M17：`crates/mailer` 的 `SmtpMailer`、`SmtpClient`、`Email`/`SmtpConfig`。
  `smtp` 关闭时不连网，`log-emails` 只写有界摘要；8 个 SMTP 键进入 `config`。
  Transit 邮件先校验 ASCII 地址与头部（拒绝 CR/LF 注入），Bcc 只做 envelope
  收件人；MIME 支持 mixed/alternative、文本附件、随机边界与 25 MiB 上限。
  SMTP 支持隐式 TLS 和必须成功的 STARTTLS、AUTH PLAIN/LOGIN、点填充、
  4 KiB 单行/64 KiB 总回复上限与 30s 超时。mailer 37 条测试 + 1 条 live
  `#[ignore]`（`PENPOT_TEST_SMTP_*` 指向一次性收件箱）。

**C. devenv 起来后采集（一次采完，回填 `fixtures/`）**

| ID | 采什么 | 用途 |
| --- | --- | --- |
| C1 | 登录取 cookie `auth-token` + 该实例 `PENPOT_SECRET_KEY` + 对应 `http_session_v2` 行 | M4 JWE 兼容性定案 |
| C2 | 真实应答语料：`get-profile`、`get-teams`、`get-project-files`、`get-file`、一条 204、一条 multipart | M1 T1.6 定案 CLJ 写侧形态（`~u` vs `["~#uuid",…]`、`~m` vs `["~#inst",…]`） |
| C3 | `scripts/db-schema` → `api/schema/schema.sql` + `tables.json` | M5/M6 表列真名与类型（S3） |
| C4 | 带 `enable-backend-openapi-doc` 抓 `GET /api/main/doc/openapi.json` | M8 契约输入（S2） |

**硬规则**：真 token / secret / DB 凭据**不进 git**；`fixtures/online/` 走 `.gitignore` + `make capture` 本机重生成；
采集用一次性账号，用完软删，不动既有资料；不 `drop-devenv`、不 `docker compose down -v`、不删共享 volume。

## 5. 契约事实速查（完整版 + 出处见 `PLAN.md` §2）

**Transit+JSON**（本地 transit-js 实测）

- map = 紧凑数组带 `^ ` 头，重复 referent 走 `^N` 缓存：`["^ ","~:a",1,"~:b",["^ ","~:c","x"]]`
- 标量 tag：`~:kw`、`~u<uuid>`、`~m<millis>`、`~n<bigint>`、`~$`（歧义串）、`~b<base64>`
- **vector 与 array 不对称**：后端所有 vector 应答写 `["~#list",[...]]`；裸 JSON 数组是 array。读者两者都要接，写者按 CLJ 语义
- 后端 handler 表在 `common/src/app/common/transit.cljc`：`ordered-map`/`ordered-set`/`m`/`uri`（读写）、
  `duration`/`file`/`path`（JVM）、`n`/`u`（CLJS 只读）、`penpot/pointer`（rep `[id meta]`）
- 数据侧另有：`~#shape`/`~#point`/`~#matrix`/`~#rect`/`~#penpot/fills`/`~#penpot/path-data`（`~b`，28 字节小端段）/
  `~#penpot/objects-map/v2`（值是**嵌套 transit 字符串**，必须独立 reader 以免破坏外层缓存）/`~#with-meta`
- 参考实现：`frontend-nextjs/lib/transit.ts` + `lib/transit.test.ts`（含两条专门打缓存语义的用例）

**HTTP/RPC**（`backend/src/app/rpc.clj`、`http/errors.clj`）

- 路由三组：`/api/main/methods/:name`、别名 `/api/rpc/command/:name`、`/api/management/methods/:name`（shared-key）
- **GET 只允许 `get-` 前缀**，否则 `restriction/method-not-allowed`；该检查早于命令查找，
  所以 `GET` 未知的非 `get-` 名字也是 405。未知的 `get-` 命令 → `:not-found`
- 身份优先级：`::session/profile-id` → `::actoken/profile-id` → `auth key-id`（有 key-id 无身份 = 匿名 `uuid/zero`）
- `nil` → **204**；`::http/status`/`::http/headers` 挂在 meta；stream 缺 content-type 补 `application/octet-stream`；SSE 独立分支
- 中间件**必须同序**：`authentication → params-validation → nitrate-sso → audit → rlimit → metrics → climit → retry → cond → db-transaction`
- 错误 body = `ex-data`（`:type/:code/:hint/…`）；状态映射 401/403/405/400/409/413/**429 `:rate-limit`**/404/500/503（两条 nitrate）

**会话令牌**（`app/tokens.clj`、`app/setup/keys.clj`、`app/http/session.clj`）

- claims `{:iss "authentication" :aud "penpot" :sid :iat :uid :sso-provider-id? :sso-session-id? :exp?}`，header `{:kid 1 :ver 1}`
- payload = transit 编码 → `jwe/encrypt` `:alg :a256kw :enc :a256gcm`
- key = `HKDF(alg :hkdf, digest :blake2b-512, key=secret-key, salt="tokens", size=32)`
- HKDF 的 `info` 为空；BLAKE2b-512 的 BlockSize 是 128、Output 是 64。Rust 侧用 `SimpleHkdf`
  （`SimpleHmac`），输出已与 OpenSSL `hkdfSync("blake2b512", …)` 对齐
- verify：`exp` 已过 → `:validation/:invalid-token :reason :token-expired`；`iss` 不符 → `:invalid-issuer`
- `exp == now` 仍有效（Clojure 用严格 `is-before?`）；`exp` 检查先于 `iss`；缺 `exp` 不判过期
- cookie：idle 7 天、absolute 30 天、renewal 6 小时；`Expires = modified-at + idle`；
  `Comment = "Renewal at: <RFC1123>"`；`SameSite` 是 `cors → None`、否则 `strict → Strict`、否则 `Lax`；
  清除只写 `Path=/` + `Max-Age=0`。RFC1123 的日号 CLJ 不补零（`Sun, 5 Nov …`），CLJS 补零
- 会话表是 **`http_session_v2`**（`0155-drop-http-session-table.sql` 已删旧表）——旧文档写 `http_session` 是过期措辞

**worker / storage**

- `task.props` 是 **jsonb + transit**（`db/tjson`），**不是 Fressian** → worker 只需 transit
- dispatcher `FOR UPDATE SKIP LOCKED` + `tenant:queue` RPUSH + 丢失重排；runner BLPOP + parallelism + `::retry`；17 任务 / 10 条 Quartz 6 段 cron
- `storage_object`：统一闭包 metadata schema、11 canonical bucket、hash 去重、`status/deletion_attempts`、`:fs`/`:s3` + 遗留别名 `:assets-fs`/`:assets-s3`；Rust 侧已落 `crates/storage` 的仓储、三阶段 GC 执行器、`crates/pg` 的适配器与 `objects-gc` 服务（真实桶/live PG 待验；运行接线仍未做）
- **file data blob = Fressian v4/v5（`app.common.fressian`，JVM 专有，无 Rust 实现）→ 本阶段不碰**；
  因此 `add-file-transient-changes`、binfile、files 写路径、thumbnails、nitrate 全列入 M8 永久排除

**ws / msgbus**

- 路由 `/ws/notifications`，query 必须带合法 `session-id`；无 profile → 401，非 upgrade → 400。
- 客户端类型 `subscribe-file`/`subscribe-team`/`unsubscribe-file`/`pointer-update`/`broadcast`/
  `keepalive`；服务端事件 `join-file`/`leave-file`/`presence`/`disconnect`/`error`。
- 订阅 `profile-id` 与 `uuid/zero`（profile 通道），team 加组织 topic，file 单独 topic；
  本 session 的消息不回流。缓冲 profile 16、scope 64、输出/输入 64；入站上限
  1 MiB/消息、256 KiB/帧。
- 心跳 5 秒，payload 是 8 字节大端序号；最多 3 个未答 ping，关闭码 8802。

**体量参考**：`backend/src` 171 文件 / 46,151 行；`common/src` 156 CLJC / 55,433 行；RPC 189 命令
（160 需鉴权 / 29 公开；183 有 params schema，**仅 50 有 result schema**）；168 个 SQL 迁移文件。

## 6. 关键路径索引

| 内容 | 路径 |
| --- | --- |
| 执行计划（里程碑 M0–M8、契约、风险、红线） | `backend-rust/PLAN.md` |
| 服务规划与门禁说明 | `backend-rust/README.md` |
| 总计划（阶段 F/B、里程碑、执行记录） | `rewrite.md`（本轮记录 §7.112） |
| Transit 后端事实来源 | `common/src/app/common/transit.cljc` |
| Transit 参考移植 + 用例 | `frontend-nextjs/lib/transit.ts`、`frontend-nextjs/lib/transit.test.ts` |
| RPC 分发/错误/中间件 | `backend/src/app/rpc.clj`、`backend/src/app/http/errors.clj` |
| 会话/JWE | `backend/src/app/http/session.clj`、`backend/src/app/tokens.clj`、`backend/src/app/setup/keys.clj` |
| worker | `backend/src/app/worker.clj`、`backend/src/app/worker/{dispatcher,runner,cron,executor}.clj`、`backend/src/app/main.clj`（registry + cron 表） |
| storage | `backend/src/app/storage.clj`、`backend/src/app/storage/*.clj`（含 `schema.clj` 的 bucket/metadata 闭包） |
| WS/msgbus | `backend/src/app/http/websocket.clj`、`backend/src/app/msgbus.clj` |
| 命令清单（S1） | `frontend-nextjs/packages/api-types/rpc-inventory.json` |

## 7. 未决 / 需要用户点头的事

1. C1/C2 采集是否允许用一次性新账号登录（历轮做法如此），以及是否允许
   `enable-backend-openapi-doc` 起后端。
2. M3 的 multipart 需要 axum 的 `multipart` feature 与 `multer` crate；本地缓存没有，
   需要一次联网拉依赖的批准，或推迟到 C2 采集同批处理。
3. M7 的 Redis live 用例已落地；浏览器两标签页、Clojure/Rust 混合集群与强制断线重连
   的自动化仍未验。设计见 `crates/ws/tests/DESIGN.md`。
4. M6 的 Redis `TaskQueue` 已落地并验过 FIFO、超时、并行 pop 与 push 不阻塞；PG 仓储和
   Clojure/Rust 混合集群仍缺 live PostgreSQL。

已定（M0）：`Cargo.lock` 入库；`rust-toolchain.toml` 用 `stable`；`rewrite.md` 保留 B/M 双编号。

M5 起 workspace `rust-version = "1.91"`：`aws-sdk-s3 1.123` 与 `aws-config 1.8` 的声明下限。
