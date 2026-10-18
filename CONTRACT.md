# 一页永恒 · 模块契约（实现者必读）

包：`dsh-cyrene-memory`（安装目录即本仓库根目录）。
设计要点见 `README.md` 的技术附录；本文件是模块级契约（目录/格式/数据模型/调度）。
运行环境：Node 22（ESM，`node:fs`/`node:path`/`node:crypto`，**零第三方依赖**）。测试：`node --test "test/*.test.mjs"`。

## 0. 硬约束

- 只用 Node 内置模块；不得 import `@deepseek-ai/*`。
- 模块之间不得循环依赖：`paths → (无)`；`parse → (无)`；`store → parse`；`search → parse`；`core → (无)`。
- 所有函数对坏输入**不抛**（返回空/默认 + 在返回值里给 error 字符串），因为注入链路必须 fail-open。
- 写文件一律走 `store.atomicWrite`（tmp + rename）。
- 注释与文档用中文；代码标识符英文。

## 1. Entry 对象（唯一数据形状）

```js
{
  id: "20261018140201-a1b2c3",   // 时间前缀 + 6 位 base36 随机
  text: "用户说他更喜欢先看结论……",   // ≤400 字
  kind: "fact",                  // fact|event|decision|lesson|rule|goal|identity|style|topic|artifact
  axis: "智",                    // 德|智|体|美|劳
  q: "你",                       // 我|你|来|去
  I: 6,                          // 1..10
  S: 3.0,                        // 稳定性（天）
  status: "active",              // fresh|active|dormant|archived|tombstone
  kw: ["偏好","写作","结论"],      // 3..13 个
  src: "conv",                   // conv|dream|user|import|web|restore
  src_ids: ["s-8f2/ev-42"],      // 溯源
  src_quote: "",                 // 用户原话（可空）
  sup: null,                     // 被本条目取代的旧 id
  links: [],                     // 关联 id
  fact_time: 1792000000000,      // 事实发生时间（ms）
  reviewed_at: 1792000000000,    // 最近取用/复评（艾宾浩斯只认它）
  touched_at: 1792000000000,     // 系统最后触碰（审计）
  created_at: 1792000000000,
  day: "2026-10-18",             // 归属日档
  path: "日/2026/10/2026-10-18.md", // 相对根目录
  sync: true,                    // 是否镜像思源
  n_recall: 0
}
```

## 2. 日档文件格式（parse ↔ store 的唯一约定）

```markdown
---
date: 2026-10-18
entries: 14
axes: {德: 2, 智: 5, 体: 1, 美: 3, 劳: 3}
dreamed: false
dreamed_at: null
---

# 2026-10-18 · 日档

## 14:02 · 智 · I6 S3 · #偏好 #写作

用户说他更喜欢先看结论、再看过程。

> 原话：「你以后先说结论，过程我有兴趣再问。」

<!--cyrene:{...Entry 的 JSON（不含 text）...}-->
```

- 元数据注释前缀固定 `<!--cyrene:`，单行，行尾 `-->`；JSON 里存除 `text` 外的全部字段（`text` 由正文承载）。
- 正文 = 小标题与引用之间的段落（可多段，保留换行，`trim`）。
- 手改容错：缺元数据/JSON 坏 → 该条按 `normalizeEntry` 默认值收编，并在 `errors` 里记一条；**不影响同文件其他条目**。
- 引用行 `> 原话：…` 解析进 `src_quote`（去掉「原话：」前缀与引号）。

## 3. 模块导出（严格按此签名）

### lib/parse.js

```js
export function entryId(now = Date.now(), random) // random: 0..1 可选，便于测试
export function parseFrontMatter(text)   // → { front: object, body: string }
export function renderFrontMatter(front) // → string（含首尾 ---）
export function serializeEntry(entry)    // → string（含末尾换行）
export function parseDay(text)           // → { front, entries, errors: string[] }
export function renderDay(front, entries)// → string（front 缺省补全）
export function normalizeEntry(partial, ctx) // ctx: { day, path, now }；返回完整 Entry
export function hashText(text)           // → 12 位 sha256 十六进制前缀
```

### lib/store.js

```js
export function resolveRoot(configured)  // 绝对路径；空则 $DSH_HOME/cyrene-memory（无 DSH_HOME 用 ~/.dsh）
export function ensureTree(root)         // 建目录 + 缺省 指南.md（若 lib/guide.js 提供）+ 四问锚点占位
export function atomicWrite(file, text)
export function readTextSafe(file)       // 读不到 → ''
export function readJSON(file, fallback)
export function writeJSON(file, obj)
export function dayFilePath(root, day)   // 相对路径 posix：日/YYYY/MM/YYYY-MM-DD.md
export function appendEntry(root, entry) // 读-改-写日档（front.entries 重算）；返回 { ok, path, errors }
export function readDay(root, day)       // → { front, entries, errors }（无文件返回空结构）
export function writeDay(root, day, front, entries)
export function listDays(root)           // → ['YYYY-MM-DD'] 升序
export function readAnchor(root, which)  // which: self|user|origin|goal → { meta, content }
export function writeAnchor(root, which, content, meta)
export function walkFiles(root)          // → [{ rel, bytes, mtime }]（跳过 元/ 下的日志与索引）
export function quotaUsage(root)         // → { bytes, byTop: {日,月,年,锚,梦,档,如我所书,元,其它} }
export function safeRelPath(root, rel)   // 越界 → null；否则绝对路径
```

锚点文件名映射：`self→锚/我是谁.md`、`user→锚/你是谁.md`、`origin→锚/来处.md`、`goal→锚/去处.md`。
锚点文件 = front-matter（`version`,`updated_at`,`immutable`）+ 正文。

### lib/search.js

```js
export function tokenize(text)                    // 中文 2-gram + 英文小写词
export function keywordScore(entry, queryTokens)  // 0..1（命中 kw 的覆盖率，封顶 8 个 kw）
export function search(entries, query, opts)      // opts: {topK=5, includeArchive=false, filters={}}
  // → [{ entry, score, rel }]，按 score 降序；includeArchive=false 时过滤 archived/tombstone
export function filterEntries(entries, filters)   // filters: {axis,q,kind,dayFrom,dayTo,status,project}
export function jaccard(a, b)                     // 两个 id 数组
export function textSimilarity(a, b)              // 0..1（2-gram 余弦，用于去重判断）
```

### lib/core.js

```js
export function retention(entry, now)             // R = exp(-Δt天 / S)，Δt 用 reviewed_at
export function priority(entry, now)              // P = I_eff * R（I_eff 见实现说明）
export function selectionScore(entry, rel, now)   // S_sel = I_eff^0.8*(0.35+0.65*(1-R))*relGate
export function review(entry, event, now)         // event: 'used'|'corrected'|'praised'|'dream'；返回新 Entry
export function shouldArchive(entry, now)         // 按冻结阈值返回 true/false
export function dueScore(entry, now)              // 1 - retention
export function allocate(buckets, budgetChars, opts={})
  // buckets: { near:[{entry,rel}], mid, far, todo, hit, due }
  // → { items: [{entry, bucket, chars}], alloc: {bucket: chars}, dropped: n }
export function truncateText(text, maxChars)      // 按句读截断，补「…」
```

`allocate` 规则（见设计 §8.4）：基础权重 `{near:.22, mid:.18, far:.14, todo:.16, hit:.20, due:.10}`；空桶权重按比例并给邻近桶；每桶按 `selectionScore` 降序贪心填充；总量 ≤ budgetChars；单条最多 300 字（超出用 `truncateText`）。

## 4. 测试要求

每个模块至少 `test/<module>.test.mjs`，用 `node:test` + `node:assert/strict`；覆盖：
- parse：roundtrip（含多段正文/引号/emoji/手改缺元数据/坏 JSON）；
- store：tmp 目录建树、append 两次计数、quota 统计、越界路径 null、原子写后内容完整；
- search：命中、停用词、archived 过滤、filters；
- core：R 衰减数值、S 增长上限、归档阈值、allocate 配额与上限、水填充。

**验收命令**（在包目录）：`node --test "test/*.test.mjs"`，全绿才算完成。
