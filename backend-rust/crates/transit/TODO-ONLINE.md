# transit 线上语料待确认清单（T1.6）

本文件记录「离线无法定案、需要一次真实后端应答」的线格式。采集与脱敏规则见
`backend-rust/PLAN.md` §10（C2）。每条都写清当前行为、为什么不能靠猜，以及解锁样本。

结论只影响字节兼容或表示形态；在拿到样本前，代码按下面写明的保守形态工作，并且都有测试。

## 1. 标量 tag 的写侧拼写

| 值 | 当前写侧 | 读取侧接受 | 待确认 |
| --- | --- | --- | --- |
| UUID | `~u<uuid>` | `~u`、`["~#uuid", "..."]` | JVM 侧是否出现 `~#uuid` |
| Instant | `~m<millis>` | `~m`、`~t<iso>`、`["~#inst", "..."]` | JVM 侧是否出现 `~#inst` / `~t` |
| URI | `["~#uri", "..."]` | `~#uri`、`~r` | `java.net.URI` 路径是否写出 `~r` |

依据：`common/src/app/common/transit.cljc` 里 `u` 只有 CLJS 的 `:rfn`，`m` 有
`:rfn`/`:wfn`，`uri` 是 Penpot 自己的多字符 handler id。transit-js 的 URI 类型写 `~r`，
但它的默认 reader 把 `~r` 留成 `TaggedValue`；`frontend-nextjs/lib/transit.ts` 只注册了
`uri` handler。因此 Rust 写 `~#uri`，读 `~r` 时归一到同一变体。

解锁：`get-profile`（UUID 字段）、`get-teams`（`created-at`）、任一含 URI 的应答。

## 2. JVM 专有的 `file` / `path`

当前：两者都落到 `Value::Tagged { tag, rep: Str }`，读写保持 tag 与原字符串。

原因：`transit.cljc` 为 JVM 的 `java.io.File` 和 `java.nio.file.Path` 注册了
`:id "file"` / `:id "path"`，但 M1 的 wire 层不需要文件系统类型。storage 里程碑会自己
建模路径，不把这个 JVM 类搬进 transit crate。

待确认：是否存在真实 RPC 应答携带二者。若没有，保持 `Tagged` 即可。

## 3. 嵌套 tagged probe 的有意偏差

当前：`reader::array` 对 2 元素数组的 `~#tag` 探测在「tagged rep 内部」也会执行。
transit-js 在 `tagValue = true` 时跳过探测，从而把内层 `["~#list", [...]]` 的头留成
裸 `Tag` 对象。

原因：Penpot 的 `~#penpot/fills` 写侧是 `:wfn (vec fills)`
（`common/src/app/common/types/fills/impl.cljc`），rep 里会出现内层 `~#list`。
后端读 handler 期望的是已解析的 vector。跳过探测会把文档解成 Tag 对象，重编码也会失败。

待确认：抓一条真实 `penpot/fills`（例如含 fills 的 shape），确认后端写侧确实是这个嵌套形态，
且 Rust 解码后再编码能逐字节还原。

## 4. `penpot/path-data` 的非 binary rep

当前：rep 是 `~b` 二进制时解成 `Value::PathData`；其他 rep 原样保留为 `Tagged`。
这与 `frontend-nextjs/lib/transit.ts` 的 reader 守卫一致。

待确认：CLJS 写侧是否只发 `~b`。若真实 path shape 出现数组或其他 rep，再决定是否支持。

## 5. `penpot/objects-map/v2` 的嵌套文档

当前：每个 value 按 transit 字符串用**独立 reader** 解码；写侧每个 value 用独立 writer
重新编码。外层缓存因此不受影响。

待确认：真实 `get-file` 的 objects-map 中

- value 是否总是字符串（外层是否可能直接给 map）；
- key 是 `~u` UUID 还是普通字符串；
- 经过 Rust 解码/编码后能否与后端原始文本逐字节一致。

## 6. 顶层 quote 与标量应答

当前：单字符 tag 的顶层值用 `["~#'", rep]` 包裹；多字符 tagged 值直接写。
依据是 transit-js 的 `marshalTop`/`maybeQuoted`。

待确认：CLJ `t/write` 的顶层形态是否一致。多数 RPC 返回 map/vector，`nil` 走 204；
可用一条非 nil 标量应答或 session payload 验证。

## 7. 非 ASCII referent 的缓存长度

当前：按 **UTF-16 code unit** 计数，等价 JavaScript `String.length` 与 Java
`String.length()`。`"éé"` 是 2 units，不缓存；`"😀😀"` 是 4 units，缓存。

待确认：抓一条含非 ASCII map key（长度落在 3/4 边界）的真实应答，确认 CLJ 写侧的 `^N`
分配与 Rust 一致。语料已用 `cache-utf16-*` 三条样本对 transit-js 对拍。同一 UTF-16 规则
也用于判定单字符 tag：含 astral 字符的 tag 是 2 units，必须写 `["~#😀", rep]`，
不能写 `~😀rep`（语料 `tagged-astral-tag`）。

## 8. `cmap` 的 key 位置

当前：`["~#cmap", [k1, v1, k2, v2, ...]]`，key 按 value 位置编码（不重打标）。

待确认：RPC 应答里是否出现复合 key。若出现，抓样本核对 key 的 tag 与缓存位置。

## 9. `duration` 的 rep 类型

当前：写 `["~#duration", <integer millis>]`；读接受整数或数字字符串。
`:wfn inst-ms` 在 JVM 返回 long，理论上就是整数。

待确认：是否存在 Duration 应答；若有，确认 rep 没有被写成字符串。

## 10. 未知 tag 与未来数据的策略

当前：未知 tag 一律 `Value::Tagged` 透传，读写保持 tag + rep。`~#quoted` 与 `~#'`
按 identity 读取，`Value::Quoted` 只是写侧提示。

这不是缺口，是策略：不做静默丢弃。新 tag 出现时应在对应 milestone 增加语义变体，而不是
在 transit crate 里猜。

## 已在离线定案的设计

- **不暴露 `CacheRef` 变体。** `^N` 是线协议里的槽位指针，`reader` 在解码时立即解析。
  把它留在值模型里会让每个消费者都要处理一层间接。`writer` 的缓存是输出细节。
  这与 transit-js / transit-java 的 reader 行为一致。
- **`Value::Quoted` 只用于写侧。** `~#'` 读回时是 identity，解码不会产出该变体。
- **`file` / `path` 不建专用变体。** 见 §2；wire 层保留 tag + string 已可无损往返。
- **vector 与 array 必须是不同变体。** 后端 vector 应答写 `~#list`，裸 JSON 数组是
  transit array；合并会让 dashboard 类应答整体失效。
