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

## 当前实现边界速查（探索阶段确认）

- 消息**完全没有** `cache_control`（`anthropic.ts` 直接 `toAnthropicMessages(request.messages)`）。
- `fork.ts` 的 `cacheMissSources` 归因基建已存在，但 `recordForkTrace` 只在子 agent 路径调用，主循环每轮不记。
- cache token 已全程流通（M1.5a：`cache_creation`/`cache_read` → TokenUsage → usage 事件 → `myagent usage`），列已在，缺命中率汇总。
- 压缩当前只在 `query.ts` 的 `prompt_too_long`/`max_output` 错误后被动触发一次（`compactForRetry`），非主动、非语义。
