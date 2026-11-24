# backend-rust 上下文快照（换机器续接用）

> 目的：在另一台机器开 devenv 后，新会话**只读这一份 + `PLAN.md`** 就能接着干，不依赖上一个会话的记忆。

## 0. 一句话任务

用 **Rust + axum** 在 `backend-rust/` 里逐步承接 `backend/`（Clojure/JVM）的能力，**实现但不接入部署**：
可以写实现和测试，但不接 nginx、不加灰度开关、不改 `backend/` 一行、不改 `docker/` 与 `scripts/ci` 现有 target。

## 1. 仓库状态快照

| 项 | 值 |
| --- | --- |
| HEAD（快照时） | `3eaa566b7f` `:construction: Bootstrap the backend-rust workspace` |
| 工作区 | M0 已提交。M1 + M2 + M3 改动仍在工作区：transit 的 UTF-16 长度/`~#uri`/verbose writer/语料、`crates/config`、`crates/errors`、`crates/rpc`、`Cargo.lock` 与文档。`.g2-tmp/` 未跟踪 |
| 阶段 F/G | F 已收口；G0–G5 已完成，见 `rewrite.md` §7.92–§7.96 |
| 阶段 B | **M0 ✅**；**M1 `transit` 离线部分 ✅**：103 条金样本、round-trip 1000 例、畸形输入、`TODO-ONLINE.md`；**M2 ✅（2026-11-24）**：`errors` 全分支 + verbose 应答 + `config` 18 键与源码表对齐；**M3 ✅（2026-11-24）**：`rpc` 三组路由、默认鉴权、参数/应答管线，29 条 oneshot + 3 条 `rpc.clj` 契约测试；C2 真实应答语料待 devenv |
| `rewrite.md` | §7.96 为 G5 收口记录，§7.100 为 backend-rust M3；里程碑状态见本文与 `PLAN.md` |

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
psql -h localhost -p 5433 -U penpot -d penpot -c 'select 1'           # C1–C4 前置
```

旧机器实测：rustc/cargo 1.98.0；registry 走 `sparse+https://rsproxy.cn/index/`（crates.io 直连被 TLS 拦、
`static.crates.io` 通）；`axum 0.8.9 / tokio 1.53.1 / sqlx 0.9.0 / redis 0.27.6 / tokio-tungstenite 0.28.0 /
aes-kw 0.3.1 / aes-gcm 0.11.1 / hkdf 0.13 / hmac 0.13 / blake2 0.11 / uuid 1.26.1 / chrono 0.4.45 /
indexmap 2.14.2 / tracing 0.1.44 / thiserror 2.0.21 / proptest 1.11 / aws-sdk-s3 1.123 / reqwest 0.13.5 /
base64 0.23.1 / mime / url / hex` **均已在本地缓存**，M0–M7 可离线构建。依赖只选已验证版本并**提交 `Cargo.lock`**。

**B. 已完成切片 = M0 + M1 的 T1.1–T1.6（离线部分）+ M2 + M3（不需要后端）**

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
- verify：`exp` 已过 → `:validation/:invalid-token :reason :token-expired`；`iss` 不符 → `:invalid-issuer`
- 会话表是 **`http_session_v2`**（`0155-drop-http-session-table.sql` 已删旧表）——旧文档写 `http_session` 是过期措辞

**worker / storage（后续里程碑）**

- `task.props` 是 **jsonb + transit**（`db/tjson`），**不是 Fressian** → worker 只需 transit
- dispatcher `FOR UPDATE SKIP LOCKED` + `tenant:queue` RPUSH + 丢失重排；runner BLPOP + parallelism + `::retry`；17 任务 / 10 条 Quartz 6 段 cron
- `storage_object`：统一闭包 metadata schema、11 canonical bucket、hash 去重、`status/deletion_attempts`、`:fs`/`:s3` + 遗留别名 `:assets-fs`/`:assets-s3`
- **file data blob = Fressian v4/v5（`app.common.fressian`，JVM 专有，无 Rust 实现）→ 本阶段不碰**；
  因此 `add-file-transient-changes`、binfile、files 写路径、thumbnails、nitrate 全列入 M8 永久排除

**体量参考**：`backend/src` 171 文件 / 46,151 行；`common/src` 156 CLJC / 55,433 行；RPC 189 命令
（160 需鉴权 / 29 公开；183 有 params schema，**仅 50 有 result schema**）；168 个 SQL 迁移文件。

## 6. 关键路径索引

| 内容 | 路径 |
| --- | --- |
| 执行计划（里程碑 M0–M8、契约、风险、红线） | `backend-rust/PLAN.md` |
| 服务规划与门禁说明 | `backend-rust/README.md` |
| 总计划（阶段 F/B、里程碑、执行记录） | `rewrite.md`（本轮记录 §7.26） |
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

已定（M0）：`Cargo.lock` 入库；`rust-toolchain.toml` 用 `stable`；`rewrite.md` 保留 B/M 双编号。
