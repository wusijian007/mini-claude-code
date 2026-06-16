# v3 内核极致化路线图

> 锚文档。v1.x（M1.1–M1.5b）与 v2（M2.1–M2.3）已完成；本轨道把 Agent 内核四项能力做到极致。
> 这份文档锁三样东西：**四项 + 耦合 + 顺序**、各项的**已定决策**、以及**跨切面不变式**。每个里程碑 PR 应引用本文件。

## 为什么需要这份锚文档

v1/v2 的里程碑彼此独立，"commit message 即 spec" 足够。v3 不同——四项**两两硬耦合**，某一项的设计会约束另一项。这类跨切面不变式，是动手前唯一真正该钉死的东西（不是需求，是 invariant）；否则会在第 3 个 PR 才发现违反、然后返工。

产品级 PRD 对一个学习用内核是空转（无外部用户、无 KPI）。本轨道沿用已验证的节奏：**audit 现状 → 紧凑设计 + 设计抉择 → 实现 → 测试 → PR，commit body 即该项 spec of record**。前置 spec 的程度按爆炸半径分级（见下）。

## 四项能力

| # | 能力 | 建在哪个已有原语上 | 一句话目标 |
|---|---|---|---|
| §1 | 智能压缩 Smart Compaction | `context.ts` 的 `compactMessages` / M1.4 归档 | 从哑截断升级到主动、分层、语义保留的压缩 |
| §2 | 缓存对齐 Prompt Cache Aligning | M1.5b 的 `cache_control` + `fork.ts` 归因基建 | 用满断点预算 + 让命中率可测可调 |
| §3 | 真后台状态机 True Background Task Control | `task.ts` 状态机 + detached worker | 从轮询升级到推送、组合、资源受控 |
| §4 | 自愈循环 Self-Correction & Verification | `verifier` 子 agent + `finalizeBeforeMaxTurns` | 从可选验证升级到结构性闸门 + edit→test→fix |

## 耦合关系（必须共同设计）

| 耦合 | 说明 | 后果 |
|---|---|---|
| §1 ⊥ §2 | 压缩改写历史 → 炸掉消息前缀缓存 | 压缩必须"缓存稳定"：追加摘要、不改写中间 |
| §3 ⊥ §4 | 验证步骤（跑测试）本身就是一个后台任务 | 两者复用同一执行 + 推结果入 context 的路径 |
| 全部 ⊥ eval 确定性 | 每个新机制都要保持离线可测 | M2.1 executor seam + M2.3 FakeModel 脚本化 usage 是使能器 |

## 跨切面不变式（v3 全程不可违反）

1. **压缩须缓存稳定** —— 任何上下文压缩只能在缓存断点边界以"追加"方式发生（追加一条摘要消息 + 丢弃尾部），不得改写被缓存的前缀。改写前缀 = 下一请求 100% cache miss。
2. **一切须离线可测** —— 每个机制必须能在 `npm test` 下用 FakeModel / mock executor 确定性地验证；非确定性组件（如 LLM 摘要器）在测试中必须可替换为脚本化 fake。新机制若改变 agent 行为，必须在 `myagent eval run` 的指纹里可见。
3. **推结果入 context 须考虑缓存前缀** —— 把后台任务结果 / 验证失败 / 反思注入对话时，应在缓存断点之后追加，避免使已缓存前缀失效。

## 推进顺序（不是 1-2-3-4）

依赖关系决定顺序，理由写在每步：

1. **§2 缓存对齐（先做）** —— 最小、可测。没有命中率测量，就无法判断 §1 压缩到底变好还是变坏。它同时确立"缓存稳定"这条约束供 §1 遵守。
2. **§1 智能压缩** —— 设计成缓存稳定的（追加摘要不改写），与 §2 协作。
3. **§4 自愈循环** —— 用户可见价值最高，复用现成的 executor seam 跑测试。
4. **§3 真后台状态机（最后/并行）** —— 工程面最大；"任务收件箱"机制能受益于 §4 已经在用 executor 跑测试的经验。

## 前置 spec 分级（按爆炸半径）

| 项 | 前置程度 |
|---|---|
| §2 / M3.1a-b | 小、可逆 → 直接实现，commit body 即 spec |
| §1 智能压缩（含 LLM 摘要） | 中、碰缓存 + 确定性 → 动手前在本文件追加一页设计 |
| §3 / §4 | 大、多状态 → 各写一份设计章节再码 |

## §2 缓存对齐 — 已定决策（M3.1）

入口里程碑，决策已在探索阶段锁定：

- **断点规则：滚动到前缀末尾。** 每轮给发出去的最后一条消息打 `cache_control: ephemeral`。下一轮请求是本轮的严格扩展 → 命中 Anthropic 增量缓存。配合现有 system + tools 两个断点，共 3 个，在 4 上限内。
- **本轮范围：M3.1a 断点 + M3.1b 命中率遥测。** M3.1c（主循环 fork-trace 归因，解释"为何 miss"）后置到做 §1 时再加——那时才真正需要它报警"压缩炸了缓存"。

### M3.1a — 消息前缀缓存断点 ✅ 已交付（PR #17）

- `ModelRequest` 加 `cacheConversation?: boolean`（agent 路径开，chat 路径不开）。
- `toAnthropicMessages` 接受"标记最后一条消息末块"的选项，给它加 `cache_control`。
- query 循环透传 `cacheConversation: true`。
- 测试：用捕获请求体的 fake Anthropic client 断言断点落在正确消息块（照搬 `packages/core/test/security/prompt-caching.test.ts` 的 `toAnthropicTools`/`toModelUsage` 单测套路）。

### M3.1b — 缓存命中率遥测 ✅ 已交付（PR #17）

- `myagent usage` 加命中率行 `cache_read / (cache_read + input)`，会话级 + 每轮（token 已由 M1.5a 采集，纯渲染层）。
- `myagent eval run` 报告同步加命中率列。
- 可选：`model.cache_hit_ratio` profile 指标。

### M3.1c — 主循环 fork-trace 归因（后置）

- 主循环每轮记一条 fork-trace，`cacheMissSources`（`fork.ts:compareForkTraces` 已能区分 system_prompt/tools/message_prefix/child_directive/model）告诉你这轮为何 miss。
- 做 §1 压缩时再加：它能立刻报警"压缩这轮炸了 message_prefix 缓存"。

## §1 智能压缩 — 设计草案（M3.2） ✅ M3.2a/b + M3.1c 已交付（PR #18）

> 中等爆炸半径（碰缓存 + 可能引入非确定性），按分级规则动手前先写这一节。
> 交付偏差：M3.1c 从"逐轮 fork-trace"缩为"压缩时记一个 profile mark"——因为 fork.ts 的 prefixHash 是整列表哈希，每轮 append 都变，会把正常追加误标成 prefix miss；单次 run 内真正使缓存失效的只有压缩，已由 compaction 事件 + profile mark `query.cache_prefix_reset` 标记。M3.2c（LLM 摘要器）仍后置。

### 核心张力：相关性 vs 缓存（决定整个设计）

- **相关性**想保留"近期"、丢"旧的"。
- **缓存**想保留"旧前缀"、丢"近期"——因为丢旧消息 = 在前缀靠前处改动 = 几乎全 miss。

**解法**：压缩是一次性、摊销的**缓存重置点**。接受压缩那一轮全 miss，压缩后的新前缀成为之后许多轮的缓存基底。因此 invariant #1 的实操含义是：**压缩别太频繁（每次 = 一次 miss），且压完要狠（降到远低于触发阈值），最大化两次压缩之间的轮数**——这样摊销下来缓存命中率反而最高。每次压缩的代价现在可由 M3.1b 命中率（+ M3.1c 归因）观测。

### M3.2a — 分层确定性压缩（默认，纯确定性）

把哑截断（保留首1+尾6+snip）升级为**按块类型分层**的外科式压缩：

- **根任务**（首条 user 消息）—— 永不丢。
- **陈旧 tool_result**（近期窗口之外的）—— 内容换成**指针**：`[archived tool_result: Read src/x.ts (412 lines) -> <archivePath>]`。文件还在盘上、可重读，这是最大的"鲸鱼"，指针化收益最高。
- **旧 assistant 轮**（近期窗口之外）—— 保留一行 head 或丢弃。
- **近期窗口**（最后 N 轮）—— 原样保留。

纯函数、无模型调用 → **构造上即 eval 安全**（满足 invariant #2）。

### M3.2b — 主动阈值触发（主，被动兜底）

- 在 query 循环的**轮边界**估 token；超 `softLimit`（默认上下文预算 75%）就在下一请求前压。
- **压得狠**：目标降到 ~50% 预算，最大化两次压缩间的轮数（缓存友好，见上）。
- 现有 `prompt_too_long`/`max_output` 被动路径**保留为安全网**（兜住意外）。
- 压缩发生时 emit 一个 `compact` LoopEvent，CLI/session 记录（复用 M1.4 归档 + 现有 session compact event）。

### M3.2c — LLM 摘要器（后置，opt-in）

- `compactMessages(messages, { summarizer })` 注入点（镜像 M1.4 的 `archiver`、FakeModel 模式）：`summarizer: (dropped) => Promise<string>`，把丢弃段摘成一条 recap。
- 语义最强但非确定 + 花钱 → 测试里注入脚本化 fake summarizer（同 FakeModel 套路）保持离线可测。
- **本轮只设计注入点形状，不实现 LLM 摘要器**——保持 §1 首刀确定性、可 gate。

### M3.1c 顺带做（归因，此时才真正有用）

- 压缩落地后，"为何这轮 miss"才有报警价值。主循环每轮记 fork-trace，命中率掉时能区分是 system/tools/prefix 哪个变了——压缩那轮应显示 `message_prefix` miss，确认是预期的摊销重置而非 bug。

### 已定的设计抉择（M3.2）

- **摘要方式**：M3.2a 分层确定性为默认；M3.2c LLM 摘要器只设计注入点、不实现。
- **触发**：M3.2b 主动阈值为主 + 被动兜底。
- **归因**：M3.1c 在本轮顺带做（压缩使它有用）。

## §4 自愈循环 — 设计草案（M3.3） ✅ M3.3a/b 已交付（PR #19）

> 大爆炸半径（改 query 终止语义 + 跑外部命令 + 可能跑飞），按分级规则动手前写这一节。
> 已交付：完成路径验证闸门（on_terminal）、反思式失败注入、bounce 上限 + `verification_failed` 终态、`verification` LoopEvent、`myagent agent --verify`、self-correction eval 任务。finalize critic 仍后置。

### 现状边界（探索确认）

- `verifier` 子 agent 只在模型自选 `subagent_type:"verifier"` 时调用，从不自动；read-only、默认后台。
- `finalizeBeforeMaxTurns` 注入终答轮 + 剥工具，无 critic 复审。
- 工具错误裸 `tool_result` 回流，无"反思"包装。
- executor（M2.1）**不受白名单限制**（白名单只在 Bash 工具 parser），可跑任意命令返回 `{exitCode, stdout, stderr, timedOut}`；`ToolContext.executor` 已就位、测试可注入 mock。

### 核心机制：结构性验证闸门

把"模型自选验证"升级为"循环结构性闸门"。**插入点 = 完成路径**：模型某轮不再调工具（今天直接 `terminal_state: completed` 返回）那一刻，是"我以为做完了"的天然 gate。

闸门逻辑：
1. 模型停止调工具 → 不立即完成，先跑配置的 verify 命令（经 `ToolContext.executor`，非 Bash 工具）。
2. `exitCode === 0` → 真完成。
3. 非 0 → 把失败**以反思式 user 轮**注入（不是裸 dump）：`验证失败（命令 X，exit N）：<截断输出>。请定位并修复，然后我会重新验证。`，bounce 计数 +1，循环继续。
4. bounce 超 `maxBounces`（默认 2）→ 以显式 `verification_failed` 终态退出（不静默"完成"）。

### M3.3a — 验证闸门（核心）

- `QueryOptions.verify?: { command; args; when?; maxBounces? }`。
- `when` 默认 `"on_terminal"`（模型自认完成时验证）；`"on_write"`（每个含成功 Edit/Write 的轮后验证，紧但贵）作为可选。
- 经 `ToolContext.executor.run(...)` 跑，捕获 exitCode + 输出。
- 失败注入反思式 user 轮 + bounce 计数；超限 → `verification_failed` 终态。
- emit `verification` LoopEvent `{ passed, exitCode, bounce, command }` 供 CLI 打印 / session 记录 / 可观测。

### M3.3b — CLI 接入 + eval

- `myagent agent --verify "<command>"` 透传到 `QueryOptions.verify`。
- eval 新增任务：edit → verify 失败一次 → fix → verify 通过，断言 bounce 发生 + 最终成功；用注入的 mock executor（verify 结果在 fix 后翻转）保持确定性。

### 后置（§4 follow-up，不在 M3.3）

- **finalize critic 过滤**：终答经只读 critic 子 agent 标无支撑断言。
- 不变式 #2（离线可测）：verify 命令必须能经 executor seam mock，eval 才确定——M2.1 seam 正是为此。

### 已定的设计抉择（M3.3）

- **触发时机**：默认 `on_terminal`（模型自认完成时验证）；`on_write` 仅作配置项保留，本轮不设为默认。
- **失败注入**：反思式 user 轮（命令 + exit + 截断输出 + "请修复，我会重验"），非裸 dump。
- **超限行为**：超 `maxBounces`（默认 2）以显式 `verification_failed` 终态退出，不静默完成。
- **critic 范围**：finalize critic 过滤后置到 §4 follow-up；M3.3 只做闸门。

## 当前实现边界速查（探索阶段确认）

- 消息**完全没有** `cache_control`（`anthropic.ts` 直接 `toAnthropicMessages(request.messages)`）。
- `fork.ts` 的 `cacheMissSources` 归因基建已存在，但 `recordForkTrace` 只在子 agent 路径调用，主循环每轮不记。
- cache token 已全程流通（M1.5a：`cache_creation`/`cache_read` → TokenUsage → usage 事件 → `myagent usage`），列已在，缺命中率汇总。
- 压缩当前只在 `query.ts` 的 `prompt_too_long`/`max_output` 错误后被动触发一次（`compactForRetry`），非主动、非语义。
