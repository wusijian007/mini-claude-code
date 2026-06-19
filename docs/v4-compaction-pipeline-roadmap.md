# v4 上下文压缩流水线路线图

> 锚文档。v1.x/v2/v3 已完成；本轨道把上下文压缩从"单盒子 + 启发式触发"重做成 **Claude Code 风格的五层流水线**：每次调模型前从最便宜到最贵依次跑,前一层省够空间后面就什么都不做,语义压缩作为最后兜底。每个 milestone PR 应引用本文件。
> 灵感图:`D:\pencil\claudecode-learning\claude_code_five_layer_compaction_pipeline.svg`（Budget / Snip / Microcompact / Context collapse / Auto-compact）。

## 为什么需要这份锚文档

myagent 现状是一个**单盒子压缩**（`compactMessagesTiered`，把分层/指针化/截断揉在一起，在轮边界触发），触发判断挂在 `chars/4` 启发式上。五层流水线的价值不在某一层，而在**结构**：分级、短路、缓存感知、可逆优先。这类跨层不变式必须动手前钉死，否则会在第 3 层才发现违反、返工。沿用 v3 验证过的节奏：**audit → 紧凑设计 + 抉择 → 实现 → 测试 → PR，commit body 即该层 spec of record**。

## 五层 + 锚点（真实顺序，每次调模型前跑）

| 层 | 目标 | 代价 / 可逆性 |
|---|---|---|
| **L1 Budget** | 工具结果 > 阈值 → 全文落盘、上下文留 ~2KB 预览 + 指针（`Read` 取回） | 零成本 · 非破坏（零信息损失） |
| **L2 Snip** | 丢弃陈旧脚手架（窗口外的旧 tool_use/result），向预算上报释放的 token | 零成本 · 结构性 |
| **L3 Microcompact** | 保留最近 N 个工具结果；**冷/热双路径**（基础设施状态决定算法） | 零 API 调用 · 可逆性视路径 |
| **L4 Collapse** | ~90% 满 → 视图叠加摘要，原文保留、可回滚；**生效则压制 L5** | 零成本 · 可逆（视图叠加，非真改写） |
| **L5 Auto-compact** | ~87% 触发 → fork 子 agent 摘要（CoT 分析→摘要）；**熔断器 + 压缩后恢复** | 1 次 API 调用 · 不可逆（唯一不可逆层） |
| **锚点** | 预算判断挂在**上次 API `usage`**（服务端精确值）上,只估算新增增量,误差 <5% | — |

## 现状审计（动手前确认）

| 层 | myagent 现状 | 缺口 |
|---|---|---|
| L1 | **已有**：`executeToolUse`（[tool.ts:177](../packages/core/src/tool.ts)）超 `toolResultBudgetChars`（默认 **8K**）落盘 → artifact + 预览 + 指针，`Read` 可取回，零损失 | 调成 cascade 一层；2KB **智能**预览（头+尾）；阈值调参；上报释放量 |
| L2 | 部分：tiered 就地截断文本 | 拆成独立阶段 + 释放量记账 |
| L3 | **缺**：总是就地改写（冷路径风格），无缓存状态分支 | 建双路径（最值得抄的一层） |
| L4 | **缺** | 新建：请求装配期的视图叠加、可回滚、压制 L5 |
| L5 | 部分：opt-in `compactMessagesWithSummary`（一条 LLM recap），**无熔断/无恢复/无压制** | 加固成受护栏的最后兜底 |
| 锚点 | **缺**：触发用纯 `chars/4`（[query.ts:403](../packages/core/src/query.ts)）；`tokenBudgetFromUsage` 已存在但**未接进循环触发** | 把 usage 锚点接进触发判断 |
| 时机 | 轮边界单盒子 + 被动网 | 统一成一条 pre-flight cascade |

**别丢的优势**：L1 落盘已是"转存非砍掉"。**真缺口**：触发靠猜、中三层揉成一次就地改写、语义层无护栏。

## 关键约束 → L3 热路径的原生适配（已定）

myagent 的模型客户端走**网关,不暴露 Anthropic 的 `cache_edits` beta**。所以 L3"缓存热"路径**不能**在服务端删引用。原生适配（用户拍板）：
- **缓存冷暖 = 距上次成功调用的耗时**（≈ 5 分钟 TTL，**可注入时钟**估算；myagent 无法查 Anthropic 真实 TTL）。
- **冷**（TTL 大概率过期）：就地改写——免费，前缀反正要重建。
- **热**：走缓存**保护**路径——**推迟破坏性改写 / 在断点后追加压缩标记**，保住已缓存前缀。
- 两路都**零额外 API 调用**。原则（"基础设施状态决定算法"）不变,只是不靠 `cache_edits` 实现。未来客户端若支持,从同一热路径 seam 接入。

## 跨层不变式（v4 全程不可违反）

承接 v3 三条 + 新增两条：
1. **压缩须缓存稳定**（承接，并被 L3 冷热双路径**强化**）——只在缓存**已冷**时才使已缓存前缀失效；热时走保护路径。
2. **一切须离线确定性可测**（承接）——冷暖时钟、摘要器、熔断失败都必须可注入 fake；新机制改行为须在 `myagent eval run` 指纹可见。
3. **推结果入 context 须考虑缓存前缀**（承接）——collapse 叠加、压缩后恢复的注入应在断点后追加。
4. **逐层上报释放量,够了就短路**（新）——每层把释放的 token 报给预算；一旦低于目标,后面层**什么都不做**。预算判断挂 usage 锚点,不挂启发式。
5. **便宜/可逆 先于 贵/不可逆**（新）——L1–L4 零成本且（多数）可逆；L5 是唯一 API 调用 + 唯一不可逆步,且锁在熔断器之后。

## 推进顺序（地基优先,逐层落 —— 已定）

每层一个 PR,引用本文件。

1. **M4.0 — Cascade 骨架 + usage 锚点**（地基）：一个 `runCompactionPipeline()` 在每次发请求前跑；各层是只在"仍超预算"时执行、够了就**短路**的 stage（与 M3.5 gate-chain 同构）。接入 usage 锚点（上次 `usage` 为基 + 增量估算）。首版骨架内只放现有 tiered（+ opt-in 语义）作单 stage → **零行为回归**,只是重构 + 换锚点。
2. **M4.1 — L1 溢出转存** 接成 cascade 一层：智能 2KB 预览、阈值调参、上报释放量。（轻,核心已有）
3. **M4.2 — L2 历史 snip**：确定性丢弃陈旧脚手架 + 释放量记账,缓存稳定。
4. **M4.3 — L3 微压缩双路径**：保留最近 N 个工具结果；冷改写 / 热保护,由冷暖时钟选路。（核心招式）
5. **M4.4 — L4 上下文 collapse**：请求装配期的可逆视图叠加（原文保留、可回滚）；**压制 L5**（collapse ~90% 胜过 auto-compact ~87%）。
6. **M4.5 — L5 auto-compact 加固**：现有语义 recap 升级为受护栏的最后兜底 + **熔断器**（连续 3 次失败即停）+ **压缩后恢复**（最近读过的文件 via FileStateStore、激活技能、工具/agent 声明；plan 状态映射到 myagent 现有状态）。

## 各层设计草案 + 设计抉择

### M4.0 — Cascade 骨架 + usage 锚点 ✅ 已交付

> 已交付：`estimateAnchoredTokens`（上次 usage 精确前缀 + 增量估算）、`UsageAnchor`、`CompactionStage` + `runCompactionPipeline`（cheapest-first 短路）；query 循环触发改挂锚点、压缩后失效锚点；首版 stage 列表 = semantic ? [auto_compact] : [tiered]（零行为回归）；6 个新测试（锚点 3 + 流水线 2 + 锚点驱动触发集成 1）。eval `semantic-compaction` 的脚本化 usage 调成与 seeded 内容一致（2400），证明触发现在尊重服务端 token 数；指纹 in 14350→15850（其余不变）。

**usage 锚点**：上次 API `usage`（`inputTokens + cache_read + cache_creation` = 上次请求的服务端精确 prompt token 数）为基；自上次请求后追加的消息（assistant + tool_results + 注入）是增量,只对增量做 `chars/4` 估算。`anchored ≈ 上次prompt + 增量估算 + 输出预留`。复用/扩展 `tokenBudgetFromUsage`,接进 [query.ts](../packages/core/src/query.ts) 的触发判断。
**cascade 骨架**：`type CompactionStage = (messages, ctx) => { messages, freedTokens }`；`runCompactionPipeline` 按序跑,每步后用锚点重估,低于目标即短路返回。首版 stage 列表 = `[tiered]`（+ summarizer 存在时 `[semantic]` 末尾）,等价于现状。被动 `prompt_too_long` 网保留为骨架之下的绝对兜底。
**抉择**：① 触发挂 usage 锚点,不挂纯启发式。② 骨架首版零行为回归（现有 proactive/semantic eval 任务原样绿）。③ cascade 与 gate-chain 同构（stage 列表 + 短路 + 可注入）。

### M4.1 — L1 溢出转存（cascade 一层） ✅ 已交付

> 已交付：`smartPreview`（头 70%+尾 30%+省略标记）、`ToolContext.toolResultPreviewChars`（默认 2048，与溢出阈值解耦）；执行期 `budgetToolResult` 改用智能预览；请求期 `createSpillStage`（cascade 最便宜一层，转存超阈值且未转存的 tool_result，保留 artifactPath、`Read` 可取回）接为流水线首 stage。阈值默认 = 执行预算（eval 预算未设→120K→L1 在 eval 中休眠，指纹不变；CLI 设 8192→生效）。6 个新测试（smartPreview 2 + spill stage 2 + 既有预算测试加固头尾标记 + 锚点驱动已在 M4.0）。

把现有执行期落盘**也**表达为 cascade 的最便宜一层（请求前对超阈值的 tool_result 做转存兜底）；预览改为**头+尾 2KB 智能预览**（非纯前缀切片）；阈值可配（默认评估 8K→更大）；上报释放量。`Read` 取回不变（零损失）。
**抉择**：保留执行期落盘（早转存早省）；cascade 层是"请求前再兜一次 + 智能预览"的补充,不重复转存（已转存的跳过）。

### M4.2 — L2 历史 snip ✅ 已交付

> 已交付：`snipStaleToolScaffolding`（纯函数，在陈旧区把超阈值的 `tool_result` 内容 snip 成标记、保留 toolUseId/artifactPath；`tool_use`、散文、根任务+近期窗口原样）接为 cascade 第二层（`[spill, snip, reclaim]`）。**层分离**：L2 只动工具脚手架,散文留给 L5——为此把 `semantic-compaction` eval 与 M3.2c 集成测试的 whale 从 tool_result 改成 assistant 散文(L1/L2 跳过、只有 L5 能回收),指纹不变。3 个新测试(snip 单测 2 + 既有集成改 prose)。

确定性丢弃**近期窗口外**的陈旧脚手架（旧 tool_use/result 对、冗长旧 assistant 文本）,保根任务 + 近期窗口逐字,保 tool 配对。向预算上报释放量。零成本。
**抉择**：snip 只动窗口外；缓存稳定（只在缓存冷时改写前缀,见不变式 1，与 L3 共用冷暖判断）。

### M4.3 — L3 微压缩双路径（核心）

"保留最近 N 个工具结果",更旧的清成 `[cleared: <tool>(...) -> <artifact>]`。
- **冷**（距上次调用 > ~5min,可注入时钟）：就地改写 → 免费。
- **热**：保护路径——推迟改写 / 断点后追加压缩标记,保住前缀。
- 两路零额外 API 调用。
**抉择**：① 冷暖靠注入时钟的"距上次调用耗时",非真 TTL。② 热路径用原生缓存保护（无 `cache_edits`,见关键约束）。③ 留 `cacheEditsCapable` seam 供未来真 cache_edits 接入。

### M4.4 — L4 上下文 collapse（可逆视图叠加）

~90% 满时,在**请求装配期**生成一个"折叠视图"：摘要叠加在原文之上,**原文保留在 stored transcript**,可 rollback（丢弃叠加层即恢复）。分离"存储的 messages"与"发出去的 view"。**collapse 生效 → 压制 L5**（图中红色互斥线：collapse ~90% > auto-compact ~87%,后者会毁掉前者要保的细粒度上下文）。
**抉择**：① collapse 是**视图变换**,非破坏性改写（可回滚）。② 与 L5 互斥,collapse 优先。③ 复用 myagent 已有的 transcript/artifact 分离。

### M4.5 — L5 auto-compact 加固（受护栏的最后兜底）

现有 opt-in 语义 recap 升级为**最后兜底**：fork 子 agent 摘要（myagent 子 agent 机制现成）,CoT `<analysis>`→`<summary>`,只留摘要,不可逆。加两道生产护栏：
- **熔断器**：连续 3 次失败即停,不无限重试（Anthropic 真出过一天浪费约 25 万次调用的事故）。
- **压缩后恢复**：自动找回最近 N 个读过的文件（via FileStateStore）、激活技能、工具/agent 声明；plan 状态映射到 myagent 现有状态（无独立 plan artifact 则 N/A）。否则模型压缩完会"忘记"刚改过的文件、自相矛盾。
**抉择**：① L5 只在 collapse 未生效且仍超预算时触发。② 熔断器 + 恢复都可注入 fake（确定性）。③ 默认作为兜底开启（不再纯 opt-in）,但仍是最后一层。

## 从 CC 保真度上诚实标注的适配/取舍

- **`cache_edits` 不可用** → L3 热路径用原生缓存保护适配（非服务端删引用）。已记入关键约束。
- **真实缓存 TTL 不可查** → 冷暖用"距上次调用耗时"近似（可注入时钟）。
- **plan 状态** → myagent 无 CC 的 TodoWrite 式 plan artifact；恢复映射到现有状态（最近读文件 + 技能 + 工具声明）,plan 缺则 N/A。
- **collapse 视图叠加**需新增"stored messages vs sent view"分离——本轨道最具侵入性的架构改动,放 M4.4 单独消化。

## 当前实现边界速查（审计确认）

- L1 落盘在执行期（`executeToolUse`/`tool.ts`），非请求前 cascade；预览是 `content.slice(0, maxChars)` 纯前缀。
- proactive 触发用 `estimateMessagesTokens`（`chars/4`），未挂 `usage`；`tokenBudgetFromUsage` 已存在于 `context.ts` 但只在 session 路径用。
- `compactMessagesTiered`（就地指针化+截断）+ opt-in `compactMessagesWithSummary`（一条 recap）是现有全部压缩；被动 `prompt_too_long`/`max_output` 兜底。
- 滚动消息前缀断点（`cacheConversation`）是唯一缓存机制；无 `cache_edits`。
