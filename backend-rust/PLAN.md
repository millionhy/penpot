# backend-rust 开发计划（**已批准** · 实现但不接入部署）

本文件是阶段 B 的执行计划。2026-10-16 决策已定（见 §8）；M0–M4 已完成（2026-11-24），下一步 M5
`storage`。换机器后的上下文快照见 `backend-rust/HANDOFF.md`。

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
| 已缓存关键依赖 | axum 0.8.9、tokio 1.53.1、tower-http 0.6.11、sqlx 0.9.0/0.8.6、redis 0.27.6、tokio-tungstenite 0.28.0、uuid 1.26.1、chrono 0.4.45、indexmap 2.14.2、tracing 0.1.44、thiserror 2.0.21、proptest 1.11、aws-sdk-s3 1.123、reqwest 0.13.5、mime、url、hex、base64 0.23.1；密码学以 digest-0.10 一代为准：aes 0.8.4、aes-gcm 0.10.3、hkdf 0.12.4、blake2 0.10.6、hmac 0.12.1、httpdate 1.0.3、zeroize 1.8 | M0–M7 依赖全在缓存内，可离线构建；`aes-kw 0.3.1` 虽在缓存但需要未缓存的 `aes 0.9`/`cipher 0.5`，故 AES-KW 自带实现 |
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
    ├── ws/                 # msgbus topic/订阅计数、消息多态、RedisBus trait + InMemoryBus
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
- 明确未做：把 M4 `session` 接进 rpc 的鉴权中间件（crate 已就绪，接线随 M5/M8）；sqlx 事务（M5）；multipart（axum 的
  `multipart` feature 依赖 `multer`，本地缓存没有该 crate，需单独批准拉依赖）；长连接 SSE（M7，
  当前只渲染固定帧）；`Accept: application/json`。

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

### M5 — `storage`（6–9 人日）

- T5.1 metadata 闭包 schema（11 bucket + `bucket-requirements` 存在性校验 + legacy `:reference/:upload-id/:chunk-index` 归一化 + verbose-transit 历史形态判定）
- T5.2 hash 去重语义 + `status/deletion_attempts` 状态机（纯逻辑 + 快照测试）
- T5.3 `ObjectStore` trait + Fs 实现（`object->relative-path` 规则一致；`x-accel-redirect` 只登记不接线）
- T5.4 S3 实现（`aws-sdk-s3`，键位对齐 `storage-assets-s3-*` / `objects-storage-*`）；集成测试 `#[ignore]`
- T5.5 GC 三态（deleted/touched/pending）纯逻辑

DoD：schema 与 CLJ 版逐条 diff 测试；fake store 单测全覆盖；真实 I/O 待 devenv。

### M6 — `worker`（6–9 人日）

- T6.1 Quartz 6 段 cron 解析 + `#penpot/cron` 语义（与 `app.util.cron` 表对拍）
- T6.2 task 行模型（props = transit jsonb）+ 状态机（`new/scheduled/processing/completed/error`、`retry_num/max_retries`、`label`、`tenant:queue`）
- T6.3 dispatcher SQL 复刻（`FOR UPDATE SKIP LOCKED`、丢失重排、in-flight 失败判定）——本轮只落 SQL 常量 + 文本断言测试
- T6.4 runner 循环（BLPOP、parallelism、`::retry` 分类、超时）+ 注册 5 个不依赖 Fressian 的任务（sendmail / objects-gc / tasks-gc / session-gc / run-webhook）
- T6.5 混合集群（Clojure↔Rust）双向兼容测试设计文档 `crates/worker/tests/DESIGN.md`，代码待 devenv

DoD：状态机与 cron 全表单测；无 live DB/Redis 依赖。

### M7 — `ws`（5–7 人日）

- T7.1 msgbus topic 约定 + `prefix-topic` 复刻（profile-id / file-id / team topics / `uuid/zero` 系统 topic）
- T7.2 订阅计数状态机（首订阅真订阅、末退订真退订）+ 单测
- T7.3 消息多态（`subscribe-team`/`subscribe-file`/`unsubscribe-file`/presence/心跳）
- T7.4 axum WebSocket upgrade + `RedisBus` trait + `InMemoryBus`（离线测试用）

DoD：InMemoryBus 下 ≥8 条协议测试；真实 Redis `#[ignore]`。

### M8 — `rpc` 只读命令承接：**本阶段不交付**

前置条件（缺任一不启动）：S3 DDL 快照、S2 OpenAPI、目标命令补齐 `::sm/result`、可用 devenv、JWE 向量。
永久排除：`add-file-transient-changes`、binfile 导入导出、files 写路径、thumbnails 生成、nitrate。

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

M0–M4 已完成（2026-11-24）。M1：103 条语料、round-trip 1000 例、畸形输入与零 panic；
M2：`errors` 全部状态分支 + verbose transit 应答 + `config` 18 个键与两张源码表对齐；
M3：`rpc` 的 5 个模块、29 条 oneshot、3 条 `rpc.clj` 契约测试；
M4：`session` 的 HKDF 键、RFC 3394 AES-KW、A256KW/A256GCM JWE、claims/verify、cookie 策略，
50 条 crate 测试（含 OpenSSL 交叉向量），C1 只差真实 buddy token。下一步 M5 `storage`：
metadata 闭包 schema、hash 去重与状态机、`ObjectStore` 的 fs 实现。C2 真实应答到位后，
按 `TODO-ONLINE.md` 回填金样本，再把 M1 的「线上形态」标为定案。

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
