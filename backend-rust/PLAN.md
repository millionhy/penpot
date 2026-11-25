# backend-rust 开发计划（**已批准** · 实现但不接入部署）

本文件是阶段 B 的执行计划。2026-10-16 决策已定（见 §8）；M0–M7 代码主干、M9 鉴权接线与
M10 `db`/`pg` 基础已落地（2026-11-25），M6 的 PG 仓储与 M8 仍不交付。换机器后的上下文快照见
`backend-rust/HANDOFF.md`。

## 0. 约束（已确认）

| 约束 | 含义 |
| --- | --- |
| **实现但不接入部署**（门禁新口径） | `backend-rust` 可以写实现与测试；但不接 nginx/反代、不加灰度开关、不改 `docker/`、不改根 `package.json`/`pnpm-workspace.yaml`、不改 `scripts/ci` 现有 target。服务只能本地 `cargo run`；任何流量切换另立决策 |
| Web 框架 = **axum** | HTTP/WS 服务一律 axum + tokio；不引入 actix/rocket |
| crate 名**不加任何前缀** | 目录 `crates/<短名>`（无 `pp-`、无 `penpot-`） |
| 不改 `backend/` / `common/` | 只读参照。若需要后端补 `::sm/result` 之类，先登记、单独批准 |
| 提交 | 默认**不 commit**（等你明确要求）；要求时一个里程碑一个 commit（`backend-rust: <scope> …`）、只 commit 不 push、过 `scripts/check-commit` |

---

## 1. 环境与可行性（旧机器实测，非推测）

> ⚠️ 本节是**分机器**的事实。换新机器后先跑 §10 的「换机器自检」再开工；docker/JVM/PG 在新机器上可用，
> 因此下表标为受阻的四项采集（§10 C1–C4）应在新机器补齐。

| 项 | 实测结果 | 对计划的影响 |
| --- | --- | --- |
| rustc / cargo | 1.98.0（`~/.cargo/bin`） | 可用 |
| registry | `.cargo/config.toml` 把 crates-io 换到 `sparse+https://rsproxy.cn/index/`；crates.io 直连 TLS 被拦，`static.crates.io` 通 | 依赖必须优先选用**本地已缓存版本**，并锁进 `Cargo.lock` |
| 已缓存关键依赖 | axum 0.8.9、tokio 1.53.1、tower-http 0.6.11、sqlx 0.9.0/0.8.6、redis 0.27.6、tokio-tungstenite 0.28.0、uuid 1.26.1、chrono 0.4.45、indexmap 2.14.2、tracing 0.1.44、thiserror 2.0.21、proptest 1.11、aws-sdk-s3 1.123、reqwest 0.13.5、mime、url、hex、base64 0.23.1；密码学以 digest-0.10 一代为准：aes 0.8.4、aes-gcm 0.10.3、hkdf 0.12.4、blake2 0.10.6、hmac 0.12.1、httpdate 1.0.3、zeroize 1.8 | M0–M7 实际声明的依赖均可离线构建。`redis 0.27.6` 已联网拉取一次并锁进 `Cargo.lock`，M7 的 `RedisBusClient` 可离线编译。`aes-kw 0.3.1` 需要未缓存的 `aes 0.9`/`cipher 0.5`，故 AES-KW 自带实现 |
| docker | **不存在**（`docker: command not found`） | devenv 起不来 |
| PostgreSQL | `localhost:5433` 拒绝连接 | S3（DDL 快照）、任何 sqlx/`query!` 编译期校验受阻 |
| Clojure CLI / JVM | 未见可用 | S2（OpenAPI 快照）、JWE 测试向量生成受阻 |
| Transit 预言机 | `frontend-nextjs/node_modules/transit-js` **可用**，已实测产出真实线格式；`lib/transit.ts` + `lib/transit.test.ts` 是已对真实后端验证过的移植参考 | **不需要后端也能生成 transit 金样本**（关键发现） |

结论：本阶段只排「纯逻辑 + 离线可自证」的代码。凡需要活 PG/Redis/JVM 的验证，代码照写、测试标 `#[ignore]` 并写清解锁条件。

---

## 2. 已核对的契约事实（后续代码的依据）

### 2.1 Transit+JSON 线格式（本地 oracle 实测）

| 事实 | 实测样本 |
| --- | --- |
| map = 紧凑数组 + `^ ` 头，键走缓存 | `["^ ","~:a",1,"~:b",["^ ","~:c","x"]]` |
| 重复 referent 写成 `^N` 缓存引用 | `lib/transit.test.ts` 断言 `,"\^\d` 出现 |
| 顶层标量被 quote 包裹 | `nil` → `["~#'",null]`；`~m1700000000000` → `["~#'","~m1700000000000"]`（transit-js writer 复用所致，实现期需定案） |
| 关键字 / 歧义串 / 二进制 | `~:a/b`、`~$sym`、`~b<base64>` |
| Penpot 标量 tag | `~u<uuid>`、`~m<millis>`、`~n<bigint>` |
| **vector 与 array 不对称** | CLJS JS 数组写成 `[1,2,3]`，而后端把所有 **vector 应答**写成 `["~#list",[...]]`（F5.1 实测：缺 `list` reader 会让整个 dashboard 空白） |

后端注册的 handler（`common/src/app/common/transit.cljc`）逐条：

| tag | 类/来源 | 读 | 写 |
| --- | --- | --- | --- |
| `file`、`path` | JVM only | ✓ | ✓ |
| `n`、`u` | CLJS only（parseInt / parse-uuid） | ✓ | — |
| `duration` | JVM `Duration`，rep = millis | ✓ | ✓ |
| `m` | `Instant`/`OffsetDateTime`/`js/Date`，rep = `(str inst-ms)` | ✓ | ✓ |
| `ordered-map`、`ordered-set` | LinkedMap/LinkedSet，rep = vec | ✓ | ✓ |
| `penpot/pointer` | `Pointer`，rep = `[id meta]` | ✓ | — |
| `uri` | `app.common.uri`，rep = str | ✓ | ✓ |

数据侧另有（`lib/transit.ts` + `objects_map.cljc` + 测试）：`~#shape`、`~#point`、`~#matrix`、`~#rect`、`~#penpot/fills`、`~#penpot/path-data`（rep 为 `~b` 二进制，28 字节小端段）、`~#penpot/objects-map/v2`（值是**嵌套 transit 字符串**，必须用独立 reader 解码以免破坏外层缓存）、`~#with-meta`。

> 待确认（T1.6）：同一语义在 CLJ 写侧的形态可能不同（例如 UUID 是否写 `~u` 还是
> `["~#uuid",…]`）。仓库内无真实应答语料，需一次后端采样定案；不影响编译，影响兼容性断言。
> 完整清单见 `crates/transit/TODO-ONLINE.md`。

### 2.2 RPC / HTTP 语义（`backend/src/app/rpc.clj`、`http/errors.clj`）

- 路由三组：`/api/main/methods/:name`、别名 `/api/rpc/command/:name`、`/api/management/methods/:name`（`shared-key` 鉴权）；另有 `/api/main/doc[/openapi.json]`。
- **GET 只允许 `get-` 前缀**，否则 `restriction/method-not-allowed`（在 handler 之前判定）。
- 请求头：`accept: application/transit+json,text/event-stream,*/*`、`x-session-id`、`x-external-session-id`、`x-event-origin`，加 `client-header-check`。
- 身份优先级：`::session/profile-id` → `::actoken/profile-id` → `auth key-id`（有 key-id 而无身份时匿名 = `uuid/zero`）；`auth-type` ∈ `:session | :token`（token 带 `token-perms`）。
- 应答：`nil` → **204**；`::http/status`/`::http/headers` 挂在 meta；stream body 缺 content-type 时补 `application/octet-stream`；SSE（`text/event-stream`）是独立分支。
- 中间件顺序（逐层，必须同序复刻）：`authentication → params-validation → nitrate-sso → audit → rlimit → metrics → climit → retry → cond → db-transaction`。
- 错误 → 状态：401/403/405/400/409/413/**429（body `{:type :rate-limit ...}`）**/404/500（`:server-error/:assertion`）/503（`nitrate-unavailable`、`nitrate-not-configured`）；body 一律是 `ex-data`（`:type/:code/:hint/...`）。

### 2.3 会话令牌（`app/tokens.clj`、`app/setup/keys.clj`、`app/http/session.clj`）

- `claims = {:iss "authentication" :aud "penpot" :sid :iat :uid :sso-provider-id? :sso-session-id? :exp?}`，`header = {:kid 1 :ver 1}`。
- payload = **transit 编码**（`t/encode`，`:type :json`），再 `buddy.sign.jwe/encrypt`，`:alg :a256kw :enc :a256gcm`。
- 密钥 = `HKDF(alg :hkdf, digest :blake2b-512, key=secret-key, salt="tokens", size=32)`。
- `verify`：`exp` 已过 → `:validation/:invalid-token :reason :token-expired`；`iss` 不符 → `:invalid-issuer`。
- 会话状态在 **`http_session_v2`**（`0155-drop-http-session-table.sql` 已删旧表）→ `rewrite.md` 与本目录 README 的 `http_session` 措辞需订正。
- 已落地细节（M4）：HKDF 的 `info` 为空、BLAKE2b-512 的 BlockSize 为 128；`exp == now` 仍算有效
  （Clojure 用严格早于）；`exp` 检查先于 `iss`；cookie 默认 idle 7 天、absolute 30 天、renewal 6 小时，
  `SameSite` 由 `cors > strict > lax` 决定，`Expires = modified-at + idle`，`Comment = "Renewal at: …"`。
- 兼容性现状：HKDF 与 A256KW/A256GCM 往返已用 **Node/OpenSSL 第二实现**逐字节对拍
  （`crates/session/fixtures/gen-jwe-vector.mjs`）。**buddy 逐字节兼容仍待 C1**，仓库内没有真实向量。

### 2.4 后续里程碑相关（先登记，不在本轮实现）

- `task.props` 是 **jsonb + transit**（`db/tjson`），不是 Fressian → worker 只需 transit 解码。
- dispatcher：`FOR UPDATE SKIP LOCKED` 认领 + `tenant:queue` RPUSH + 丢失任务重排；runner：BLPOP + parallelism + `::retry` 语义；17 个任务、10 条 Quartz 6 段 cron。
- `storage_object`：统一闭包 metadata schema、11 个 canonical bucket、按 hash 去重、`status/deletion_attempts`、`:fs`/`:s3` + 遗留别名 `:assets-fs`/`:assets-s3`。
- file data blob = **Fressian v4/v5**（`app.common.fressian`，JVM 专有，无 Rust 实现）→ 本阶段明确不碰。

---

## 3. 工作区设计（无 `pp-` 前缀）

```
backend-rust/
├── Cargo.toml              # [workspace] members = ["crates/*"] + [workspace.dependencies] 锁版
├── Cargo.lock              # 提交，保证离线可构建
├── rust-toolchain.toml     # channel = "stable"（不钉小版本）
├── .gitignore              # target/
├── fixtures/               # transit 金样本（transit-js 生成）+ JWE 向量（待采集）
└── crates/
    ├── transit/            # Transit+JSON reader/writer、缓存、Penpot 标签
    ├── errors/             # ex-data 模型 → HTTP status/body（axum IntoResponse）
    ├── config/             # PENPOT_* env + flags（enable-/disable-）
    ├── session/            # JWE a256kw+a256gcm + HKDF-BLAKE2b512、claims、verify、cookie（纯算法，无 DB）
    ├── db/                 # sqlx 池、kebab→snake 命名、事务包装（运行时查询，不用 query! 宏）
    ├── storage/            # metadata schema、bucket、去重、GC 状态机、ObjectStore trait + fs/s3
    ├── worker/             # cron 解析、task 状态机、dispatcher SQL、runner 循环、retry/dedupe
    ├── ws/                 # msgbus、协议、axum WebSocket、RedisBusClient + InMemoryBus
    └── rpc/                # bin：axum 服务（路由 + 中间件管道 + Registry），仅本地监听 6061
```

依赖方向：`rpc → {transit, errors, config, session, db, storage, worker, ws}`；下层 crate 之间互不引用（除 `errors`/`config` 这类叶子）。

---

## 4. 里程碑与任务分解

### M0 — 工作区基线（1 人日，全离线）

- T0.1 workspace、`rust-toolchain.toml`、`[workspace.dependencies]` 按缓存版本锁定、`.gitignore`
- T0.2 `backend-rust/Makefile`：`build` / `test` / `fmt` / `lint`（`clippy -- -D warnings`）/ `check-offline`；**不接 `scripts/ci`**
- T0.3 更新 `backend-rust/README.md`：crate 命名表、「只写代码不承接流量」边界、`http_session` → `http_session_v2` 订正
- 落地（2026-11-24）：工作区、锁文件、stable 工具链、`.gitignore` 与 `Makefile` 已就位；`serde_json` 打开
  `float_roundtrip`；若干 malformed 用例按 JSON/transit 规范改正。

DoD：`make build && make test && make lint` 绿；`cargo build --offline` 绿；README 与本文一致。

### M1 — `transit`（5–8 人日，关键路径，✅ 代码完成，T1.6 待线上语料）

现状（2026-11-24）：reader/writer/value/cache、103 条 transit-js 金样本、畸形输入与 proptest
round-trip 已落地；`TODO-ONLINE.md` 已写清 10 项待确认形态。真实应答语料（C2）仍待 devenv，
它只影响字节兼容断言，不影响 M1 的代码与离线验收。

- T1.1 标签/handler 表定稿（`transit.cljc` + `transit.ts` + 本地 transit-js 源码）
- T1.2 Value 模型（**已定：自建 enum**，不用 `serde_json::Value` 打标）：`Keyword` / `Str` /
  `Uuid` / `Instant` / `Duration` / `BigInteger` / `Uri` / `Binary` / `List(vector)` / `Array` / `Set` /
  `OrderedMap` / `OrderedSet` / `Pointer` / `Tagged`；**vector 与 array 必须是不同变体**
  （后端 vector 应答写 `~#list`，裸 JSON 数组是 transit array，读者两者都要接）
  - `CacheRef` 不建独立变体：`^N` 在解码时立即解析，值模型只保留解析后的值。
    `Value::Quoted` 只用于写侧；`~#'` 读回是 identity。
- T1.3 reader：`^ ` map 头、`^N` 缓存、`~u/~m/~n/~:、~$、~b`、`~#list/set/ordered-*/with-meta/'`、嵌套 `penpot/objects-map/v2`（独立 reader，隔离缓存）、`penpot/path-data`
- T1.4 writer：关键字键、缓存注册策略、vector → `~#list`、与 CLJS/CLJ 写侧形态对齐
  - 缓存长度按 **UTF-16 code unit** 计数，与 JavaScript/Java 的 `String.length` 一致
    （非 ASCII referent 用字节数或 Rust 字符数都会错位）；单字符 tag 的判定同规则。
  - URI 写 `["~#uri", …]`，对齐 `transit.cljc` 的 `:id "uri"`；`~r` 仅在读取时接受并归一。
- T1.5 `fixtures/gen-transit-corpus.mjs`：用 transit-js 作预言机批量产样本（含 ≥60 条：标量、嵌套 map、vector、pointer、objects-map、path-data、with-meta）→ Rust 逐字节对拍 + `proptest` round-trip
- T1.6 兼容性缺口清单：把「需真实后端才能定案」的形态（`~u` vs `~#uuid` 等）写成 `crates/transit/TODO-ONLINE.md`，不靠猜实现
  - 已落地：10 项待确认 + 4 项离线定案的设计。

DoD：语料逐字节一致；round-trip 1000 例；畸形输入返回结构化错误、零 panic。三项均已在离线验收。
红线：不得为「测试跑通」而偏离 `transit.cljc` 的标签定义。

### M2 — `errors` + `config`（3–4 人日）✅（2026-11-24）

- T2.1 ✅ `crates/errors`：`ErrorType`/`ErrorCode` + `ex-data` → status/body，逐分支对照
  `app/http/errors.clj`（401/403/405/400/409/413/429/404/500/503/504 全覆盖）。
  `Cause` 区分受控错误、PG、IO、`Completion/ExecutionException` 包装与无 `ex-data` 的异常；
  `:rate-limit` 的 body 固定四键（缺值写 nil），`:concurrency-limit` 走 429 + headers 无 body。
  请求体统一用 `Value` 保留未知 `ex-data` 键，只删 `errors.clj` 明确删除的键。
- T2.2 ✅ axum `IntoResponse`：map body 用 `transit::encode_verbose`（对齐
  `t/encode-str body {:type :json-verbose}`），标 `application/transit+json`；无 body 分支只发状态与 headers。
  为此给 `transit` 补了 verbose writer（15 条单测 + transit-js 对拍）。
- T2.3 ✅ `crates/config`：`PENPOT_*` 键表 18 项（secret-key、auth-token-cookie-*、public-uri、
  host、tenant、is-saas、objects-storage-*、redis-uri、telemetry-enabled、worker-*-parallelism、
  flags）+ 类型化解码（bool/int/duration/uri/keyword/set）+ `enable-`/`disable-` 有序应用 +
  HTTP 非 localhost 关闭 secure cookie、telemetry 派生 flag；未识别键进 `Config::unknown`，
  并由 `Config::pending` / `Config::unrecognized` 区分「schema 已定义、Rust 未接」与真未知。
- T2.4 ✅ 表驱动 diff：flag 三集合与 `default` 向量对 `common/src/app/common/flags.cljc`；
  `KNOWN_KEYS` 的名字与 `ValueKind` 对 `schema:config`；schema 其余 143 个键进显式 `PENDING_KEYS`
  （两边增删都会失败）；PG hint 表与 `strip-internal-fields` 对 `errors.clj`。

DoD ✅：errors 33 条分支测试（每个 `defmethod` 至少一条）+ 2 条源码表对齐；config 18 条单测 +
5 条源码表对齐。未知 `PENPOT_*` 进 `unknown`，未接的 schema 键进 `PENDING_KEYS`，都不静默丢。

### M3 — `rpc`（axum 骨架）（5–7 人日）

- T3.1 三组路由 + GET/`get-` 前缀限制 + `/:name` 未知命令 → `:not-found`
- T3.2 上下文抽取：headers、`x-session-id`、client-header-check、IP、request-id
- T3.3 `Registry`：`name → {auth, mdata, Handler}`；`Handler` 为 trait-object/闭包，输入 `Transit` params，输出 `Result<Value, Error>`
- T3.4 中间件管道按 2.2 的顺序建骨架，先实装 `authentication`（依赖 session 解码，DB 校验走 trait）、`params-validation`（先做类型/必需/closed 的薄校验）、`metrics`（tracing span）、`db-transaction`（trait 占位）
- T3.5 GET query → transit 参数解码（复刻 `repo.cljs` 编码）
- T3.6 multipart（axum 内建）、204 空体、SSE 应答骨架
- T3.7 本地可跑：`cargo run -p rpc` 监听 `:6061`（避开后端 `:6060`），只挂 DB-free 的样本命令；**不接 nginx**

DoD：`tower::ServiceExt::oneshot` 测试 ≥20 条（路由、限制、编解码、错误映射、鉴权分支）；测试不依赖 PG/Redis。

落地（2026-11-24）：`crates/rpc` 有 `registry / params / response / router / context` 五个模块与
`tests/router.rs`（29 条 oneshot）、`tests/clj_contract.rs`（3 条源码契约）。门禁
`cargo test -p rpc --offline` 为 15 条单测 + 32 条集成测试。

- 已对齐：三组路由与 4 条 308 重定向；GET/HEAD 的 `get-` 前缀检查**早于**命令查找（未知名字也是 405）；
  默认 `AuthPolicy` 等同 `(::auth mdata true)`；`authentication-required` / `token-auth-required` /
  `missing-perms` 三支鉴权；query→keyword map、重复键→vector；transit body 与 query 合并、body 优先；
  薄参数 schema（str/UUID/int/bool/keyword/set/vector、required、closed）；`nil`→204；compact/verbose
  transit；`x-shared-key`、`x-client`；CORS（allowlist + `Vary: Origin`，预检 204）；
  `x-session-id`；`inet/parse-request` 的 IP 优先级
  （`x-real-ip` → `x-forwarded-for` 首跳 → socket peer），服务端用
  `into_make_service_with_connect_info` 提供 peer。
- 鉴权接线已在 M9 落地：`auth::TokenResolver` 把 cookie/Bearer 会话令牌与 `Token`
  访问令牌接进 `SessionResolver`，存储留在 trait 后。
- 仍未做：sqlx 事务与 PG 存储（数据库片）；multipart（axum 的 `multipart` feature 依赖
  `multer`，本地缓存没有该 crate，需单独批准拉依赖）；长连接 SSE（M7，当前只渲染固定帧）；
  `Accept: application/json`。

### M4 — `session`（✅ 2026-11-24，buddy 向量待 C1）

- T4.1 ✅ `TokenKey::derive`：HKDF-HMAC-BLAKE2b-512，salt `"tokens"`、空 `info`、32B；
  `SimpleHkdf`（BLAKE2b 不是 eager hash，`SimpleHmac` 走同一条 RFC 2104 构造）。
  输出与 OpenSSL 的 `hkdfSync("blake2b512", …)` 逐字节一致。
- T4.2 ✅ `crates/session` 的 `jwe`：RFC 7516 compact，A256KW（本地 RFC 3394 实现，`aes 0.8`）
  + A256GCM；protected header `{"alg":"A256KW","enc":"A256GCM","kid":1,"ver":1}`，payload = transit bytes。
  五段严格检查、无填充 base64url、AAD = protected 段 ASCII、IV 12B、tag 16B、CEK 32B。
- T4.3 ✅ `claims`：`SessionClaims` 按 Clojure 键序写、nil 省略、`iat` 缺省补当前时间；
  `Claims` 保留未知 claim。`Token::verify` 先判 `exp < now` 再判 `iss`，`exp == now` 仍有效。
  `cookie`：name/`Path=/`/`HttpOnly`/`Expires`/`Comment`/`SameSite`（cors→None、strict→Strict、否则 Lax）
  /`Secure`；清除只写 `Path=/` 与 `Max-Age=0`。RFC 1123 用 Java 的日不补零形态。
- T4.4 ✅ `tests/buddy_vector.rs`（`#[ignore]`）：`PENPOT_TOKEN` + `PENPOT_SECRET` 解码真 token；
  另有 `fixtures/gen-jwe-vector.mjs` 生成 Node/OpenSSL 向量，Rust 编码端逐字节匹配、解码端解出 claims。

DoD 已达成：round-trip、五段任一处篡改均拒绝、错误 alg/enc/kid/ver 拒绝、nonce/tag/密文长度自洽。
诚实标注：**「与 buddy 逐字节兼容」在 C1 向量到位前不视为完成**；已验证的是 RFC 语义与第二实现互通。

### M5 — `storage`（✅ 2026-11-24，真实 S3 桶待 devenv）

- T5.1 ✅ metadata 闭包 schema（11 bucket + `bucket-requirements` 存在性校验 + legacy `:reference/:upload-id/:chunk-index` 归一化 + verbose-transit 历史形态判定）
- T5.2 ✅ hash 去重语义 + `status/deletion_attempts` 状态机（纯逻辑 + 快照测试）
- T5.3 ✅ `ObjectStore` trait + Fs 实现（`object->relative-path` 规则一致；`x-accel-redirect` 只登记不接线）
- T5.4 ✅ S3 实现（`aws-sdk-s3`，键位对齐 `storage-assets-s3-*` / `objects-storage-*`）；集成测试 `#[ignore]`
- T5.5 ✅ GC 三态（deleted/touched/pending）纯逻辑

DoD：schema 与 CLJ 版逐条 diff 测试；fake store 单测全覆盖；真实 I/O 待 devenv。

落地（2026-11-24）：`crates/storage` 有 `content / error / fs / gc / metadata / object / path /
repository / s3 / service / store` 十一个模块。测试为 crate 内 45 条通过 + 1 条 ignored
（`tests/{metadata,path_and_hash,gc,service,fs_store,s3}.rs`），整个 workspace 237 条通过 + 2 ignored。

- metadata：11 bucket 与 `requirements` 表；必填 `bucket`/`content-type`，未知键拒绝；
  旧 `reference` 提升为 bucket，空 bucket 回退 reference，最后回退 `file-media-object`；
  `upload-id`/`chunk-index` 归一化时丢弃；verbose transit 与 plain JSON 双读双写，
  sniff 只看文档开头，避免值里的 `"~:` 误判。
- hash：`BLAKE2b-256` + `blake2b:` 前缀；`content`/空串向量与独立 digest 对齐。
- 生命周期：写入前先校验 bucket 必填键，再插 `pending`、写 blob、提升 `valid`；dedup 只查 valid 且 `deleted_at IS NULL`；
  `tempfile`/`upload-session` 不去重；命中但 blob 缺失时按同 id 修复；`expired_at == now` 不可读，
  重复软删返回 false。
- FS：UUID 路径为 `aa/bb/<剩余 28 hex>`；先写同目录临时文件再 rename，覆盖已有 blob；
  `file://` URL 与 `x-accel-redirect` 路径规则只登记，不接 HTTP。
- S3：`aws-config` 默认凭证链 + 显式 region；自定义 endpoint 强制 path-style；
  读旧 `PENPOT_STORAGE_ASSETS_S3_*` 再读 `PENPOT_OBJECTS_STORAGE_S3_*`；put/head/get/delete/
  bulk delete（1000 条一批，整批请求失败按全部失败上报）与 presigned GET（`max_age` +
  `content-disposition`）。
- GC：pending 24h/100 条、touched 默认 2h/10 条、deleted 25 条、删除失败 7 次放弃并延后 1 天；
  三条 SQL 常量保留 `FOR UPDATE SKIP LOCKED`；poison metadata 延后 1 天。
- 依赖：`aws-sdk-s3 1.123` 与 `aws-config 1.8` 声明 Rust 1.91，workspace MSRV 从 1.85 提到 1.91。
- 明确未做：`sqlx` 仓储/GC 执行器（本阶段没有 live PG）；真实 S3 桶与真实 PG 的集成验证；
  `x-accel-redirect` 接线。S3 集成测试用 `PENPOT_TEST_S3_BUCKET` + AWS 凭证解锁。

### M6 — `worker`（2026-11-25，Redis live 已验证；真实 PG 待 devenv）

- T6.1 ✅ Quartz 6 段 cron 解析 + `#penpot/cron` 语义（与 `app.util.cron` 表对拍）
- T6.2 ✅ task 行模型（props = transit jsonb）+ 状态机（`new/retry/scheduled/running/completed/failed`、`retry_num/max_retries`、`label`、`tenant:queue`）
- T6.3 ✅ dispatcher SQL 复刻（`FOR UPDATE SKIP LOCKED`、丢失重排、in-flight 失败判定）；本轮落 SQL 常量 + 文本断言
- T6.4 ✅ runner 循环（BLPOP、parallelism、`::retry` 分类、超时）+ 注册 5 个不依赖 Fressian 的任务（sendmail / objects-gc / tasks-gc / session-gc / run-webhook）
- T6.5 ✅ 混合集群（Clojure↔Rust）双向兼容测试设计文档 `crates/worker/tests/DESIGN.md`，代码待 devenv
- T6.6 ✅ `RedisTaskQueue`：独立 `RPUSH` 连接 + 可复用 `BLPOP` 连接池，支持并行 runner

DoD：状态机与 cron 全表单测；Redis 队列 live 用例通过；PG 仓储与混合集群仍待 devenv。

落地（2026-11-24）：`crates/worker` 有 `cron / dispatcher / error / handler / queue / repository /
runner / task / tasks` 九个模块。默认测试为 crate 内 68 条通过 + 5 ignored；
整个 workspace 338 条通过 + 14 ignored。Redis live 5 条独立跑通。

- cron：六段加可选 year，支持 `*`、`?`、列表、范围、步长、月份/星期名称、`L`、`W`、`#`；
  `#penpot/cron` 当前 10 条表达式逐条通过源码契约测试。
- task：`task.props` 按 Transit JSONB 处理；提交默认 queue `default`、priority `100`、
  max_retries `3`、首延迟 1 秒；每次落库前按毫秒截断时间。
- dispatcher：先重排超过 5 分钟的 `scheduled` 行，再将超过 24 小时的 `running` 行标为
  `orphan with running status`，随后按 `priority DESC, scheduled_at` 认领 due 行；
  按 `tenant:queue` 分组 RPUSH，Redis key 为 `penpot.worker.queue:<tenant>:<queue>`。
- runner：payload 为 Transit `[uuid scheduled-at]`；先校验行存在与 scheduled 时间，再标记
  `running`；handler 缺失按 Clojure 行为完成任务；未捕获失败在达到 `max_retries` 前转
  `retry`，首次延迟取配置值，后续按新 `retry_num` 指数增长。
- handlers：五个 offline 任务均由 trait 边界注入，测试使用内存 fake，不依赖真实邮件、
  webhook、PG 或 Redis。
- queue：`RedisTaskQueue` 用 `RPUSH` 原子追加一批 Transit payload；`BLPOP` 使用独立连接池，
  不让阻塞 pop 串行化多个 runner，也不阻塞 dispatcher 的 publish 连接。
- Redis live：FIFO、单次批量追加、超时返回 `None`、阻塞 pop 不挡 push、并发 pop 共享同一
  列表，以及无效 URI 的 `WorkerError::Queue`，共 5 条 live + 1 条默认测试。
- 明确未做：`sqlx` 仓储、live PG、Clojure↔Rust 混合集群；SQL 常量已覆盖 dispatcher、
  GC 与 webhook 的三类写入路径。

### M7 — `ws`（✅ 2026-11-24，Redis live 已验证）

- T7.1 ✅ msgbus topic 约定 + `prefix-topic` 复刻（profile-id / file-id / team topics / `uuid/zero` 系统 topic）
- T7.2 ✅ 订阅计数状态机（首订阅真订阅、末退订真退订）+ 单测
- T7.3 ✅ 消息多态（`subscribe-team`/`subscribe-file`/`unsubscribe-file`/presence/心跳）
- T7.4 ✅ axum WebSocket upgrade + `RedisBus` trait + `InMemoryBus`（离线测试用）
- T7.5 ✅ `RedisBusClient`：发布/订阅双连接、首订阅开通道、末退订关通道、断线重连重订阅

DoD：InMemoryBus 下 ≥8 条协议测试（实测协议 10 条）；真实 Redis 的 7 条 `#[ignore]`
live 用例通过。

落地（2026-11-24）：`crates/ws` 有 `bus / error / heartbeat / protocol / redis / server`
六个模块。默认测试为 crate 内 33 条通过 + 7 ignored；整个 workspace 337 条通过 + 9 ignored。
Redis live 7 条独立跑通。

- bus：`prefix_topic` 按 `<tenant>.<topic>` 拼接；`InMemoryBus` 复刻本地订阅计数，
  首订阅打开、末退订关闭，退订幂等；发布补逻辑 `:topic`，慢订阅丢弃，关闭的发送端自动清理。
- protocol：解码 `subscribe-team`/`subscribe-file`/`unsubscribe-file`/`pointer-update`/
  `broadcast`/`keepalive`；id 必须是 Transit UUID；team 订阅经 `AccessControl` 解析组织并
  同时订阅组织 topic；open 订阅 profile 与 zero topic；join/leave/presence/disconnect 与
  pointer 的发送者字段按 `websocket.clj` 补齐；本 session 消息回环过滤。
- server：`/ws/notifications?session-id=<uuid>` 的查询参数校验、401 鉴权边界、
  RFC 6455 accept key、101 响应与 `hyper::upgrade` 接线；升级后由
  `tokio-tungstenite` 读写，文本帧走 Transit verbose；入站上限 1 MiB/消息、256 KiB/帧。
- heartbeat：8 字节大端序号；profile 16、scope 64、输出/输入 64、5 秒、最多 3 个未答
  ping；超时用 Clojure 的关闭码 8802。`clj_contract` 锁定路由、tenant 前缀、缓冲与消息类型。
- redis：`RedisBusClient` 用多路复用连接发布、独立 Pub/Sub 连接接收；本地计数决定首个
  `SUBSCRIBE` 与最后一个 `UNSUBSCRIBE`。监听任务在断线后按 100ms 到 5s 退避重连，
  重开仍有本地订阅的通道。坏 channel、非 Transit 或非 map payload 只告警并跳过。
- live 测试：发布往返、两个本地订阅共享一个 Redis 通道、外部连接直投前缀通道、租户隔离、
  退订后重订阅、坏 payload 后继续投递，共 7 条通过。
- 明确未做：浏览器到真实 Redis 的两标签页联调、Clojure/Rust 混合集群对拍、强制断线重连
  的自动化用例。设计边界见 `crates/ws/tests/DESIGN.md`。

### M8 — `rpc` 只读命令承接：**本阶段不交付**

前置条件（缺任一不启动）：S3 DDL 快照、S2 OpenAPI、目标命令补齐 `::sm/result`、可用 devenv、JWE 向量。
永久排除：`add-file-transient-changes`、binfile 导入导出、files 写路径、thumbnails 生成、nitrate。

### M9 — `rpc` 鉴权接线（✅ 2026-11-25，PG 存储待 devenv）

M8 被 live PG/devenv 卡住，先做不依赖数据库的下一片：把 M4 的 `session` 真正接进
RPC 鉴权。存储留在 trait 后面，PG 实现随 devenv 补。

- T9.1 ✅ `crates/rpc/src/auth.rs`：`TokenResolver` 实现 `SessionResolver`。凭据顺序照
  `mw/wrap-auth` 的 `some-fn`：`auth-token` cookie 先于 `Authorization`；空 cookie 视为
  没有；`Bearer` 会话令牌、`Token` 访问令牌、其他 scheme 忽略。
- T9.2 ✅ 会话令牌先读 `{:kid 1 :ver 1}` 头，再用 `:iss "authentication"` 校验，最后按
  `:sid` 查 `http_session_v2`。缺行或 idle 过期（`modified_at + 7 天 < now`）按匿名处理；
  `exp == now` 仍有效。
- T9.3 ✅ 访问令牌用 `:iss "access-token"` 校验，按 `:tid` 查 `access_token`，取
  `profile_id`/`perms`/`expires_at`；`expires_at <= now` 无效。
- T9.4 ✅ 解码失败降级为未认证（对应 `decode-token` 吞异常）；存储错误冒泡为 500。
- T9.5 ✅ `SessionStore`/`AccessTokenStore` 两个 trait；`rpc` 不引入 sqlx，测试用内存 store。
- T9.6 ✅ `session::decode_header` 补上 `app.tokens/decode-header` 的等价能力，带单测。

DoD ✅：16 条 `auth` 单测 + 10 条 `oneshot` 集成；workspace 366 passed + 14 ignored；
fmt/clippy/build/doc 全绿。sqlx 存储随后由 M10 补上；cookie 续期写回与
`::actoken/type` 审计字段仍未做。

### M10 — `db` 与 PG 认证存储（✅ 2026-11-25，live PG 待 devenv）

把 M9 的 trait 接到真实 PostgreSQL 上。`rpc` 仍不依赖 sqlx；SQL 只在 `pg` crate 里。

- T10.1 ✅ `crates/db`：`DbOptions` 复刻 `app.db/defaults`（60 连接、30s 获取、2min idle、
  30min lifetime）与 `initsql` 的 `statement_timeout`/`idle_in_transaction_session_timeout`
  各 300s；`connect_lazy_with` 不建连，行为同 Hikari 的 `initializationFailTimeout -1`。
- T10.2 ✅ `snake_case`/`kebab_case`/`table_name` 对齐 `app.db.sql` 的 `-` ↔ `_` 规则。
- T10.3 ✅ `DbError` → `errors::Cause`：服务器错误保留 SQLSTATE（57014/25P03 → 504，
  其余 500），IO 与连接池故障按 500 处理。
- T10.4 ✅ `Database::begin` 返回 sqlx 事务，未 commit 直接 drop 即回滚；`close` 等待
  连接归还。`read_only` 用 `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`。
- T10.5 ✅ `SessionResolver`/`SessionStore`/`AccessTokenStore` 改为 async trait
  （sqlx 查询必须 await），router 的鉴权阶段同步改为 await。
- T10.6 ✅ `crates/pg`：`PgSessionStore` 查询 `http_session_v2`（跳过 `profile_id IS NULL`，
  `modified_at` 转毫秒），`PgAccessTokenStore` 查询 `access_token`（过滤过期行，`perms`
  转集合）。

依赖：`sqlx` 固定 `=0.9.0`（0.9.1 需要未缓存的 `sqlx-mysql 0.9.1`），关闭默认 feature，
只开 `runtime-tokio`/`postgres`/`uuid`；TLS 关闭，连接本地 devenv。

DoD ✅：db 11 条单测 + doc test；pg 2 条 live 测试 `#[ignore]`；workspace 378 passed +
18 ignored；fmt/clippy/build/doc 全绿。明确未做：live PG 实跑、示例二进制接线、
sqlx 事务 hook 与 M5/M6 仓储。

---

## 5. 顺序与总量

```
M0 ▓ → M1 ▓▓▓（关键路径）→ M2 ▓▓ ∥ M3 ▓▓▓ → M4 ▓▓ → M5 ▓▓ → M6 ▓▓ → M7 ▓▓
```

约 **50 人日**（1 人 ≈ 10 周；2 人 ≈ 5–6 周，M2/M3 与 M5/M6 可并行）。
把 `transit` 放第一：RPC 请求体、应答体、`task.props`、session payload 全是 transit，它不对，后面全错。

---

## 6. 本阶段红线（明确不做）

- 不接 nginx / 反代、不加灰度开关表、不改 `docker/`、不改根 `package.json` / `pnpm-workspace.yaml` / `scripts/ci` 现有 target
- 不读写 `file.data` / `file_data.data` blob（Fressian v4/v5）；不引入 `fressian`/`lz4`/`zstd` 依赖
- 不改 `backend/` 与 `common/` 一行
- 不做生产集成测试（需活 PG/Redis 的一律 `#[ignore]` + 解锁说明）
- 不把真 token / `PENPOT_SECRET_KEY` / DB 凭据写进仓库（见 §10 采集安全规则）
- 不 `git push`；未获明确要求不 `git commit`

---

## 7. 风险

| 风险 | 概率 | 影响 | 处置 |
| --- | --- | --- | --- |
| transit 缓存（`^N`）语义实现不全 → 大应答解码错位 | 中 | 严重 | T1.5 语料含缓存用例（照搬 `transit.test.ts` 两条针对性断言） |
| CLJ 写侧与 CLJS 写侧形态不一致（`~u` vs `~#uuid`） | 高 | 中 | 不猜；登记 TODO-ONLINE，待一次后端采样定案 |
| JWE 与 buddy 不逐字节兼容 | 高 | 严重（未来承接时） | 结构自洽 + `#[ignore]` 向量测试；明确标注未完成 |
| rsproxy 镜像缺某版本 → 拉取失败 | 中 | 中 | 只用已验证缓存版本 + 提交 `Cargo.lock` |
| 无 PG → sqlx 相关代码写了编译不过 | 中 | 中 | 只用运行时 API（`sqlx::query`），不用 `query!` 宏；避免 `prepare` 依赖 |
| 只做代码、无流量验证 → 缺陷延后暴露 | 高 | 中 | 每个 crate 的 DoD 必须是可执行测试；兼容性测试设计文档随码交付 |
| 「只写代码」范围蔓延成实现 file-changes | 中 | 严重 | §6 红线 + M8 排除清单 |

---

## 8. 决策记录（2026-10-16 已拍板）

| # | 议题 | 决定 |
| --- | --- | --- |
| 1 | 门禁 | 改口径为「**实现但不接入部署**」；`backend/` 仍不改一行。已同步 `rewrite.md`（§0 表、§3.2 原则 1、§4 阶段 B、§5、§7.7、新增 7.26） |
| 2 | crate 命名 | **不加任何前缀**（无 `pp-`）：`transit / errors / config / session / db / storage / worker / ws / rpc` |
| 3 | `transit` 值模型 | **自建 enum**（能区分 `Keyword`↔`String`、`List(vector)`↔`Array`） |
| 4 | Web 框架 | axum 0.8 |
| 5 | JWE 兼容性向量 | 用户换机器后**开 devenv**采集（见 §10）。采集前 `session` 按「结构自洽、兼容性待验」交付并显式标注 |

未拍板、由我按保守默认执行（可随时否决）：

- DB 层用 `sqlx` **运行时查询**，不用 `query!` 宏（避免编译期依赖活库/`.sqlx`）。
- M3 的 `rpc` 骨架保持 DB-free，不在本阶段实现任何需要 PG 的命令。
- 一个里程碑一个 commit（`backend-rust: <scope> …`），**只 commit 不 push**，且每次都过 `scripts/check-commit`。

## 9. 下一步

M0–M7 代码主干已落地（2026-11-25）。M1：103 条语料、round-trip 1000 例、畸形输入与零 panic；
M2：`errors` 全部状态分支 + verbose transit 应答 + `config` 18 个键与两张源码表对齐；
M3：`rpc` 的 5 个模块、29 条 oneshot、3 条 `rpc.clj` 契约测试；
M4：`session` 的 HKDF 键、RFC 3394 AES-KW、A256KW/A256GCM JWE、claims/verify、cookie 策略，
50 条 crate 测试（含 OpenSSL 交叉向量），C1 只差真实 buddy token；
M5：`storage` 的 metadata 双编码、BLAKE2b 去重、pending→valid 状态机、FS/S3 后端与 GC 纯逻辑，
45 条 crate 测试 + 1 ignored（真实桶）；
M6：`worker` 的 Quartz cron、六态 task 状态机、dispatcher 认领/恢复、runner 重试、
五个 offline handler 与 Redis 队列适配器，68 条默认 crate 测试 + 5 条 Redis live；
M7：`ws` 的 msgbus 前缀/订阅计数、协议多态、presence、心跳、鉴权、axum WebSocket 路由
与真实 Redis 适配器，33 条默认 crate 测试 + 7 条 Redis live 用例，整个 workspace
337 条通过 + 9 ignored。
M9：`rpc` 鉴权接线——`TokenResolver` 接 cookie/Bearer 会话令牌与 `Token` 访问令牌，
存储留在 `SessionStore`/`AccessTokenStore` trait 后，16 条 auth 单测 + 10 条 oneshot；
整个 workspace 366 条通过 + 14 ignored。
M10：`db` 的池、命名、错误映射与事务助手，`pg` 的会话/访问令牌存储，鉴权 trait 改为
async；workspace 378 条通过 + 18 ignored。
下一步是 devenv 起来后的 live PG 验证（`PENPOT_TEST_DATABASE_URL`）与 M6/M5 的 PG 仓储，
再把 `PgSessionStore` 接进示例二进制。C2 真实应答到位后，按 `TODO-ONLINE.md` 回填金样本，
再把 M1 的「线上形态」标为定案。M8 仍不交付。

## 10. 换机器 / devenv 起来之后的采集清单

本机（旧机器）没有 docker/JVM/PG，以下四项必须在新机器 devenv 起来后一次性采完，采完再回填 `fixtures/`：

| ID | 采什么 | 怎么采 | 用来解锁 |
| --- | --- | --- | --- |
| C1 | **JWE 兼容性向量** | 登录一次，取 cookie `auth-token`；同时记下该实例的 `PENPOT_SECRET_KEY` 与对应 `http_session_v2` 行 | M4 `session`：Rust 解出 claims 与后端一致，才算「兼容」 |
| C2 | **真实 transit 应答语料** | `curl -b auth-token` 抓 `get-profile`、`get-teams`、`get-project-files`、`get-file`、一条 204 应答、一条 multipart 请求 | M1 T1.6：定案 CLJ 写侧形态（`~u` vs `["~#uuid",…]`、`~m` vs `["~#inst",…]`） |
| C3 | **DDL 快照（S3）** | `scripts/db-schema` → `api/schema/schema.sql` + `tables.json` | M5/M6 的表与列真名、`sqlx` 类型、GC 语义 |
| C4 | **OpenAPI 快照（S2）** | 后端带 `enable-backend-openapi-doc`，抓 `GET /api/main/doc/openapi.json`（`/api/openapi` 只是重定向） | M8 命令承接的契约输入 |

采集安全规则（硬）：

- 真 token、`PENPOT_SECRET_KEY`、DB 凭据**一律不进 git**。`backend-rust/fixtures/` 只放**已脱敏**的结构样本（固定测试 secret 重新加密过的），或直接把 `fixtures/online/` 加进 `.gitignore` 并在 Makefile 提供 `make capture` 本地重生成。
- C1 的兼容验证走「本机向量比对」，不做在线调用留存。
- 采集期间不动既有账号资料（沿用历次做法：一次性账号，用完软删）。

换机器自检（开工前 30 秒）：

```bash
rustc --version && cargo --version                     # 期望 ≥1.9x
ls ~/.cargo/registry/cache/*/ | grep -E '^(axum|tokio|sqlx|aes-kw|aes-gcm|hkdf|blake2|redis)-'   # 离线可用性
node -e "require('/path/to/frontend-nextjs/node_modules/transit-js')"   # transit 预言机
psql -h localhost -p 5433 -U penpot -d penpot -c 'select 1'             # C1–C4 前置
```
