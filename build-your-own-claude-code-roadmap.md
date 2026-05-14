# 从 0 到 1 构建你自己的 Claude Code —— 学习与实战路线图

> 基于 [claude-code-from-source.com](https://claude-code-from-source.com) 18 章源码逆向工程的深度学习总结  
> 目标：在 build 中学习，逐步实现一个具备 Claude Code 关键能力的 AI 编码 Agent

---

## 一、整本书的核心洞察（先看清地图再上路）

在你写一行代码之前，请把下面这些信息**烙印在脑子里**——它们是整个 18 章反复出现的"灵魂"。

### 1. Claude Code 真正的复杂度分布

| 模块 | 占比 | 性质 |
|---|---|---|
| AI 决策逻辑（agent loop） | **约 1.6%** | 一个 `while(true)` |
| 确定性基础设施 | **约 98.4%** | 权限门、上下文管理、工具路由、错误恢复 |

**关键启示**：所谓"AI Agent"，AI 部分只是一个流式调用 + 工具循环。真正难的是周边的**确定性工程**——这正是你需要花 90% 时间的地方。

### 2. 6 个核心抽象（贯穿全书）

1. **Query Loop** —— 一个 async generator 函数（约 1700 行），所有交互的唯一入口
2. **Tools** —— 自描述的工具对象（40+ 种），统一接口
3. **State** —— 双层架构：可变 bootstrap 单例 + 响应式 UI store
4. **API Layer** —— 多 Provider 客户端 + Prompt Cache + 流式
5. **Tasks/Sub-Agents** —— `pending → running → completed/failed/killed` 状态机
6. **Hooks/Skills** —— 进程隔离的扩展点

### 3. 让它工作的 10 个核心模式（必须吃透）

1. **Async Generator 作为 agent loop** —— 天然背压、清晰取消、类型化终止状态
2. **Speculative tool execution** —— 模型还在流式输出时就开始执行只读工具
3. **按安全分类批处理** —— 读操作并行，写操作串行
4. **Fork agents 共享 prompt 前缀** —— 字节级一致换 95% 缓存折扣
5. **4 层上下文压缩** —— snip → microcompact → collapse → autocompact
6. **文件型 memory + LLM recall** —— Sonnet 边路查询胜过 embedding 搜索
7. **Skill 两阶段加载** —— 启动只读 frontmatter，调用时才读全文
8. **Sticky latch 保护 cache** —— beta header 一旦发送，整个会话不再撤销
9. **Slot reservation** —— 默认 8K 输出上限，命中才升 64K（节省 99% 请求的上下文）
10. **Hook 配置启动快照** —— 启动时冻结，运行时不再读盘，防注入攻击

### 4. 5 个架构性"赌注"

1. **Generator 循环** > 回调
2. **文件型 memory** > 数据库
3. **自描述工具** > 中央 orchestrator
4. **Fork agents** > 全新 sub-agent（为 cache 共享）
5. **Hooks（外部进程）** > Plugins（in-process）

### 5. 一句话原则

> **把复杂度推向边界，让边界吸收混乱并导出秩序；内部保持纯净。**

---

## 二、技术栈选型建议

| 维度 | 推荐选择 | 备选 |
|---|---|---|
| 语言 | **TypeScript**（与原作贴近、生态成熟） | Python（更易上手）、Rust（性能极致） |
| Runtime | Node.js 20+ 或 **Bun**（Bun 启动快、内置 bundler） | Deno |
| LLM SDK | `@anthropic-ai/sdk` | OpenAI SDK / Vercel AI SDK |
| 验证 | **Zod**（与原作一致） | Yup, Joi |
| CLI 解析 | **Commander.js** | yargs |
| 终端 UI | **Ink**（React for CLI） | Blessed, raw stdout |
| State | **Zustand-shaped 自实现 30 行** | Zustand, Redux |
| 测试 | **Vitest** + 依赖注入 | Jest |
| 子进程 | `node:child_process` | execa |
| 文件搜索 | **ripgrep** binary | grep, fast-glob |
| MCP | `@modelcontextprotocol/sdk` | 自实现 JSON-RPC |

---

## 三、18 周渐进式 Build 路线图

下面是**真正以 build 驱动学习**的路线。每个阶段都对应 Claude Code 的一组章节，并以**可运行的 milestone** 收尾。

### 阶段 0：环境与心智准备（Week 0）

**学习目标**：理解为什么是 agentic CLI，与传统 CLI 的本质区别。

**任务**：
- [ ] 安装真正的 Claude Code，作为日常使用一周（理解你要复刻的产品）
- [ ] 阅读第 1 章 + 第 18 章（首尾呼应，建立全局视图）
- [ ] 准备 Anthropic API Key
- [ ] `npm init`，建立 monorepo 骨架：`packages/{cli,core,tools,ui}`

**Milestone**：一个能跑 `myagent --version` 的空壳 CLI。

---

### 阶段 1：最小可用的 Agent Loop（Week 1-2）—— 对应第 4、5 章

这是**整个项目的心脏**。先做最丑陋、最简单、但能跑的版本。

#### 任务 1.1：单次 API 调用

```typescript
// packages/core/src/api.ts
import Anthropic from "@anthropic-ai/sdk";

export async function* callModel(messages, systemPrompt, tools) {
  const client = new Anthropic();
  const stream = await client.messages.stream({
    model: "claude-sonnet-4-5",
    max_tokens: 8000,
    system: systemPrompt,
    messages,
    tools,
  });
  for await (const event of stream) yield event;
}
```

#### 任务 1.2：最小 Generator Loop（20 行）

```typescript
// packages/core/src/loop.ts
export async function* agentLoop(initialMessages, tools, systemPrompt) {
  let messages = [...initialMessages];
  while (true) {
    const response = await collectModelResponse(callModel(messages, systemPrompt, tools));
    yield { type: "assistant", message: response };
    if (!response.toolUses?.length) return { reason: "completed" };
    
    const results = await executeToolsSerial(response.toolUses, tools);
    yield { type: "tool_results", results };
    messages = [...messages, response, { role: "user", content: results }];
  }
}
```

#### 任务 1.3：两个最小工具

- `Read`：读取文件，返回带行号的文本
- `Bash`：执行 shell 命令（**先无安全检查，下个阶段补**）

#### 任务 1.4：最简 REPL

```typescript
// packages/cli/src/repl.ts
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
for await (const line of rl) {
  for await (const event of agentLoop([{ role: "user", content: line }], tools, sysPrompt)) {
    console.log(event);
  }
}
```

**Milestone**：在终端里输入 "读一下 README.md 然后总结一下"，能看到模型调用 Read 工具并返回总结。

**学到的核心模式**：
- ✅ Async Generator 作为 loop（模式 1）
- ✅ 流式响应 → 工具调用 → 结果回填 → 再次循环
- ✅ Terminal 状态用 generator 的 return value 表达

**反模式警告**：不要用 EventEmitter / 回调 / Promise chain。Generator 是这个领域的正确抽象。

---

### 阶段 2：工具系统（Week 3-4）—— 对应第 6 章

把工具从"一次性函数"升级为**自描述、可验证、可分类、可权限化**的对象。

#### 任务 2.1：定义统一 Tool 接口

```typescript
export interface Tool<I = any, O = any> {
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;          // Zod schema, 双重职责
  isReadOnly: (input: I) => boolean;       // 默认 false（fail-closed）
  isConcurrencySafe: (input: I) => boolean; // 默认 false
  validateInput?: (input: I, ctx: Ctx) => Promise<string | null>;
  call: (input: I, ctx: Ctx) => Promise<ToolResult<O>>;
}

// 关键：buildTool 工厂注入安全默认值
export function buildTool<I, O>(def: Partial<Tool<I, O>> & Pick<Tool<I,O>, 'name'|'inputSchema'|'call'>): Tool<I, O> {
  return {
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    description: "",
    ...def,
  };
}
```

#### 任务 2.2：实现 14 步 pipeline 的简化版（先做 7 步）

```typescript
async function executeOneTool(toolUse, registry, ctx) {
  // 1. 查找
  const tool = registry.get(toolUse.name);
  if (!tool) return errorResult("unknown tool");
  
  // 2. abort check
  if (ctx.abortController.signal.aborted) return errorResult("aborted");
  
  // 3. Zod 校验
  const parsed = tool.inputSchema.safeParse(toolUse.input);
  if (!parsed.success) return errorResult("invalid input");
  
  // 4. 语义校验（可选）
  const semErr = await tool.validateInput?.(parsed.data, ctx);
  if (semErr) return errorResult(semErr);
  
  // 5. 权限（下阶段做）
  
  // 6. 执行
  try {
    const result = await tool.call(parsed.data, ctx);
    
    // 7. 结果预算（输出过大时落盘）
    return budgetResult(result, tool.name);
  } catch (e) {
    return classifyAndReturnError(e);
  }
}
```

#### 任务 2.3：扩充工具集到至少 8 个

| 工具 | 并发安全 | 关键点 |
|---|---|---|
| `Read` | ✅ | 维护 readFileState 缓存（mtime + content） |
| `Glob` | ✅ | 用 `fast-glob` |
| `Grep` | ✅ | 包装 ripgrep 二进制，支持 head_limit 分页 |
| `Edit` | ❌ | 检查文件 staleness（必须先 Read 过） |
| `Write` | ❌ | 同上 |
| `Bash` | 🟡 取决于命令 | 解析复合命令，纯读才并发安全 |
| `Fetch` | ✅ | HTTP GET |
| `TodoWrite` | ❌ | 任务列表（提升模型规划能力） |

#### 任务 2.4：结果预算系统

- 每个工具声明 `maxResultSizeChars`
- 超限时落盘到 `~/.myagent/tool-results/{hash}.txt`，返回带预览的 wrapper

**Milestone**：`agent "在 src/ 下找到所有 TODO 注释并整理成报告"` 能正确执行 `Glob → Grep → Read → 总结`。

**学到的核心模式**：
- ✅ 自描述工具（架构赌注 3）
- ✅ Fail-closed 默认值
- ✅ Input-dependent safety（同一工具不同输入安全性不同）
- ✅ 结果预算

---

### 阶段 3：并发执行（Week 5）—— 对应第 7 章

把"全串行"升级为"读并行、写串行、流式投机执行"。

#### 任务 3.1：分区算法

```typescript
function partitionToolCalls(calls: ToolUse[], registry: ToolRegistry): Batch[] {
  const batches: Batch[] = [];
  for (const call of calls) {
    const tool = registry.get(call.name);
    const parsed = tool?.inputSchema.safeParse(call.input);
    const safe = parsed?.success ? tryCatch(() => tool!.isConcurrencySafe(parsed.data), false) : false;
    
    const last = batches.at(-1);
    if (safe && last?.parallel) last.calls.push(call);
    else batches.push({ parallel: safe, calls: [call] });
  }
  return batches;
}
```

#### 任务 3.2：批执行（先做这步，再做投机）

```typescript
async function* runBatches(batches, ctx) {
  for (const batch of batches) {
    if (batch.parallel) {
      // 用 boundedAll 限制并发到 10
      yield* boundedAll(batch.calls.map(c => executeOneTool(c, registry, ctx)), 10);
    } else {
      for (const call of batch.calls) {
        yield await executeOneTool(call, registry, ctx);
      }
    }
  }
}
```

#### 任务 3.3：StreamingToolExecutor（投机执行）

这是优化大头，但实现复杂。先做最小版：
- 模型流式吐出 tool_use 块时就 push 到队列
- 只有所有"运行中"的工具都是 concurrencySafe，才允许新的 concurrencySafe 启动
- 任何非 safe 的工具进入时，等待全空才执行
- 结果**按提交顺序输出**（非完成顺序）

#### 任务 3.4：abort controller 三层结构

```
query-level (用户 Ctrl+C)
  └── sibling-level (一个工具失败级联取消同批)
      └── per-tool (单个工具自身取消)
```

#### 任务 3.5：Bash 错误级联

仅 Bash 工具的错误会取消同批兄弟（因为命令往往有隐式依赖）；Read/Grep 错误隔离。

**Milestone**：让模型一次请求 5 个 Read，肉眼可观察到并行（而非串行 5 倍时间）。

**学到的核心模式**：
- ✅ 按安全分类批处理（模式 3）
- ✅ Speculative tool execution（模式 2）
- ✅ 结果按提交顺序而非完成顺序输出

---

### 阶段 4：状态架构（Week 6）—— 对应第 3 章

之前你的 state 全是局部变量。现在重构为双层架构。

#### 任务 4.1：Bootstrap State（mutable singleton）

```typescript
// packages/core/src/bootstrap-state.ts
const STATE = {
  sessionId: crypto.randomUUID(),
  cwd: process.cwd(),
  totalCostUSD: 0,
  totalLinesAdded: 0,
  cachedSystemPromptSections: new Map(),
  // ... ~30 fields
};

// 通过 getter/setter 暴露，路径字段做 NFC normalize
export const getCwd = () => STATE.cwd;
export const setCwd = (p: string) => { STATE.cwd = p.normalize('NFC'); };
// ...
```

**关键**：这个文件不依赖任何东西（DAG 叶子）。

#### 任务 4.2：UI State（reactive store, ~30 行）

```typescript
function makeStore<T>(initial: T, onChange?: (prev: T, next: T) => void) {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set: (updater: (prev: T) => T) => {
      const next = updater(state);
      if (Object.is(next, state)) return;  // 关键：引用相等跳过
      const prev = state; state = next;
      onChange?.(prev, next);
      subs.forEach(s => s());
    },
    subscribe: (cb: () => void) => { subs.add(cb); return () => subs.delete(cb); },
  };
}
```

#### 任务 4.3：onChange 集中处理副作用

```typescript
const appStore = makeStore(initialState, (prev, next) => {
  if (prev.model !== next.model) setMainLoopModelOverride(next.model);  // 同步到 bootstrap
  if (prev.permissionMode !== next.permissionMode) notifyRemoteSession(next.permissionMode);
  // ...
});
```

#### 任务 4.4：Sticky Latch 模式

```typescript
// 一旦设为 true 永不撤回，保护 cache key 稳定
let afkModeLatched: boolean | null = null;
export function shouldSendAfkHeader(active: boolean): boolean {
  if (afkModeLatched === true) return true;
  if (active) { afkModeLatched = true; return true; }
  return false;
}
```

**Milestone**：你能解释**为什么** session ID 在 bootstrap state 而 permission mode 在 UI store。

**学到的核心模式**：
- ✅ 按访问模式（不是按 domain）分层 state
- ✅ Sticky latch（模式 8）
- ✅ 集中式 onChange 副作用

---

### 阶段 5：上下文管理与压缩（Week 7-8）—— 对应第 5 章

随着会话变长，上下文会爆炸。实现 4 层压缩。

#### 任务 5.1：精确 Token 计数

- 优先使用上次 API 响应里的 `usage.input_tokens`（权威）
- 之后新增的消息用粗略估计（保守偏高）
- 包装为 `tokenCountWithEstimation()`

#### 任务 5.2：Layer 0 - Tool Result Budget

每条消息 enforce 单条上限（Bash 30K, Edit/Grep 100K）。

#### 任务 5.3：Layer 1 - Snip Compact（最轻）

```typescript
// 直接物理删除最老的 N 条消息，yield 一个 boundary 消息提示 UI
function snipCompact(messages: Message[], targetTokens: number): Message[] { /* ... */ }
```

#### 任务 5.4：Layer 2 - Microcompact

按 `tool_use_id` 删除不再需要的 tool_result。注意：thinking blocks 不能删！

#### 任务 5.5：Layer 3 - Auto-Compact（最重）

调用一次模型，让它总结整个对话历史为一段精炼摘要：

```typescript
async function autoCompact(messages, callModel): Promise<Message[]> {
  const summary = await callModel({
    messages: [...messages, { role: "user", content: "Summarize the conversation so far ..." }],
    systemPrompt: COMPACT_SYSTEM_PROMPT,
  });
  return [{ role: "system", content: `<conversation-summary>${summary}</conversation-summary>` }];
}
```

#### 任务 5.6：阈值与熔断器

```typescript
const effectiveWindow = ctxWindow - Math.min(modelMaxOutput, 20000);
const AUTOCOMPACT_THRESHOLD = effectiveWindow - 13000;
const BLOCKING_LIMIT = effectiveWindow - 3000;
const MAX_CONSECUTIVE_FAILURES = 3;  // 关键：熔断器！
```

#### 任务 5.7：错误恢复升级阶梯

把简单的 `try/catch` 升级为这个阶梯：

```
Error → Withhold (从 yield 流隐藏)
     → If prompt_too_long: Context collapse → Reactive compact
     → If max_output_tokens: 8K → 64K → Multi-turn recovery (max 3次)
     → If image_size: Reactive compact
     → All exhausted: Surface error, exit
```

每一层都有显式的次数上限（防止 infinite loop 烧 API 配额）。

**Milestone**：进行一段超长对话（数十轮），观察 console 里输出的"Auto-compact triggered, freed 28000 tokens"。

**学到的核心模式**：
- ✅ 4 层压缩（模式 5）
- ✅ Withholding 模式（recoverable error 不抛给消费者）
- ✅ 每个 retry 都有 circuit breaker
- ✅ 死循环守卫

---

### 阶段 6：权限系统（Week 9）—— 对应第 6 章下半部分

让你的 agent 不会`rm -rf /`。

#### 任务 6.1：7 种权限模式

```typescript
type PermissionMode = 
  | "default"           // tool 自检 + 不识别的操作弹窗
  | "acceptEdits"       // 自动允许文件编辑
  | "plan"              // 只读：拒绝所有写
  | "dontAsk"           // 自动拒绝任何会弹窗的（背景 agent 用）
  | "bypassPermissions" // 全部放行（危险！）
  | "auto"              // 用 LLM 分类器决定
  | "bubble";           // 子代理用：上抛给父代理
```

#### 任务 6.2：解析链

```
1. PreToolUse Hook 决定 → 终结
2. Always-allow / always-deny / always-ask 规则匹配
3. tool.checkPermissions() → tool 特定逻辑
4. 模式默认（plan 拒写、bypass 全允）
5. 交互式弹窗（仅 default/acceptEdits）
6. Auto 模式：LLM 分类器
```

#### 任务 6.3：规则匹配（支持 glob 和命令前缀）

```typescript
type Rule = { tool: string; pattern?: string };  // 例：{ tool: "Bash", pattern: "git *" }
function matchRule(rule: Rule, toolUse: ToolUse): boolean { /* ... */ }
```

#### 任务 6.4：Bash 命令安全分类

- 用 `shell-quote` 库解析 `&&` `||` `;` `|`
- 维护 `BASH_READ_COMMANDS / BASH_LIST_COMMANDS / BASH_NEUTRAL_COMMANDS` 集合
- 复合命令：所有非 neutral 子命令都在 read/list 集合 → 才是 read-only

#### 任务 6.5：Trust Boundary

```
启动时：
  → 仅读取 TLS、theme 等"安全"配置
  → 显示"Trust this directory?" 对话
  → 用户确认后才读 PATH、LD_PRELOAD、运行 git 命令
```

**Milestone**：`agent "rm -rf /tmp/test"` 必须弹出确认；`agent "ls"` 直接执行。

**学到的核心模式**：
- ✅ 分层权限（无单一机制能涵盖所有场景）
- ✅ Trust boundary 概念

---

### 阶段 7：API 层进阶（Week 10）—— 对应第 4 章

现在你的 API 调用是裸的。升级为生产级。

#### 任务 7.1：Prompt Cache 友好的 system prompt

```typescript
// 关键：把 system prompt 拆成 [静态部分] + DYNAMIC_BOUNDARY + [动态部分]
function buildSystemPromptBlocks(): SystemPromptBlock[] {
  return [
    { type: "text", text: STATIC_INTRO, cache_control: { type: "ephemeral" } },
    { type: "text", text: STATIC_TOOL_GUIDANCE, cache_control: { type: "ephemeral" } },
    // === DYNAMIC BOUNDARY ===
    { type: "text", text: dynamicSessionGuidance() },
    { type: "text", text: claudeMdContent },
    { type: "text", text: environmentInfo() },
  ];
}
```

**坚守原则**：boundary 之前**不能**有任何 runtime 条件分支（每个条件都让 cache 变体翻倍）。

#### 任务 7.2：DANGEROUS_uncachedSystemPromptSection 命名规范

```typescript
function DANGEROUS_uncachedSystemPromptSection(content: string, _reason: string): SystemPromptBlock {
  // _reason 参数运行时不用，但强制写入是 code review 必查文档
  return { type: "text", text: content };
}
```

#### 任务 7.3：Idle Watchdog

```typescript
async function* streamWithWatchdog(stream, idleMs = 90_000) {
  let timer: NodeJS.Timeout;
  const reset = () => { clearTimeout(timer); timer = setTimeout(() => stream.controller.abort(new Error("idle")), idleMs); };
  reset();
  try {
    for await (const ev of stream) { reset(); yield ev; }
  } finally { clearTimeout(timer); }
}
```

#### 任务 7.4：非流式 fallback

流式失败（中断、坏 SSE）→ 自动 retry 一次非流式 `messages.create`（处理代理坏 SSE 的常见情况）。

#### 任务 7.5：Retry as generator

```typescript
async function* withRetry(streamFn) {
  let attempt = 0;
  while (attempt < 3) {
    try {
      yield* streamFn();
      return;
    } catch (e) {
      if (e.status === 529) { yield { type: "system_status", message: `Overloaded, retrying in ${2**attempt}s` }; await sleep(2**attempt * 1000); attempt++; }
      else if (e.status === 401) { await refreshOAuth(); attempt++; }
      else throw e;
    }
  }
}
```

#### 任务 7.6：Output token slot reservation

- 默认 `max_tokens: 8000`
- 命中（响应被 truncate）→ 单次重试 `max_tokens: 64000`
- p99 输出 ≈ 4900 tokens，常规情况 over-reserve 8 倍 = 浪费 cache

**Milestone**：在 dashboard 里能看到 cache hit rate > 80%（前几轮对话之后）。

**学到的核心模式**：
- ✅ Prompt cache 作为架构约束
- ✅ DANGEROUS naming convention
- ✅ Watchdog（不只 timeout）
- ✅ Retry 作为 generator
- ✅ Slot reservation（模式 9）

---

### 阶段 8：启动管线优化（Week 11）—— 对应第 2 章

现在你的启动可能 1 秒。把它压到 300ms 以内。

#### 任务 8.1：5 阶段管线

```
cli.tsx     → fast-path dispatch (--version, --help 等不导整个项目)
main.tsx    → module-level I/O 副作用（subprocess、keychain）
init.ts     → memoized init（多入口安全）+ trust boundary
setup.ts    → 命令、agents、hooks、plugins 并行注册
launcher.ts → 7 个入口收敛到 query() 调用
```

#### 任务 8.2：模块级并行 I/O

```typescript
// main.ts 顶部，不是函数里面
const credsPromise = readKeychainCredentials();  // 启动 138ms 模块求值时已在跑
const mdmPromise = startMDMSubprocess();
// 后续 await 时通常已 resolved
```

#### 任务 8.3：动态 import 延迟加载

```typescript
// 用户从不调用 telemetry 的话，OpenTelemetry（400KB+）永远不加载
async function initTelemetry() {
  const otel = await import("@opentelemetry/api");
  // ...
}
```

#### 任务 8.4：Init 函数 memoize

```typescript
let initPromise: Promise<Config> | null = null;
export function init(args): Promise<Config> {
  return initPromise ??= doInit(args);
}
```

**Milestone**：`time myagent --version` < 50ms；`time myagent --help` < 80ms；冷启动 REPL < 350ms。

**学到的核心模式**：
- ✅ Overlap I/O with module evaluation
- ✅ 尽早收敛 scope
- ✅ Memoized init（多入口安全）

---

### 阶段 9：终端 UI（Week 12-13）—— 对应第 13、14 章

把丑陋的 `console.log` 升级为 Ink 驱动的真正 TUI。

#### 任务 9.1：Ink + React 基础

```tsx
import { render, Box, Text } from "ink";

function App() {
  const messages = useStore(s => s.messages);
  return (
    <Box flexDirection="column">
      {messages.map((m, i) => <MessageBlock key={i} msg={m} />)}
      <InputBox />
    </Box>
  );
}
```

#### 任务 9.2：流式渲染

每收到一个 stream chunk → setState → React re-render → Ink diff 输出到终端。

#### 任务 9.3：键盘解析

支持基础 + 高级模式：
- 普通字符
- `Ctrl+C`（abort 当前 turn）
- `Ctrl+D`（退出）
- `Esc`（中断生成）
- `Shift+Tab`（切换 acceptEdits）
- `↑/↓`（历史命令）
- 多行粘贴检测（连续输入超过阈值不立即 submit）

#### 任务 9.4：交互式 prompt 组件

```tsx
function PermissionPrompt({ tool, input, onDecide }) {
  // 选项：Allow once / Allow always / Deny / Edit input
  // 用键盘箭头选择，回车确认
}
```

#### 任务 9.5：Slash 命令

```
/help, /model <name>, /compact, /clear, /memory, /hooks, /resume, /agents
```

**Milestone**：流式输出顺滑、Ctrl+C 立即停止、Tab 补全文件路径。

**学到的核心模式**：
- ✅ React + 函数式 state 是 TUI 的右抽象
- ✅ 流式 = 高频 setState

---

### 阶段 10：Memory 系统（Week 14）—— 对应第 11 章

让你的 agent 跨 session 学习。

#### 任务 10.1：目录结构

```
~/.myagent/projects/<sanitized-git-root>/memory/
  MEMORY.md                 # 始终加载的索引（200 行 / 25KB 上限）
  user_role.md              # 4 类之一
  feedback_testing.md
  project_db_freeze.md
  reference_linear.md
  team/                      # 团队共享
    MEMORY.md
    feedback_db_testing.md
```

#### 任务 10.2：4 类 taxonomy 强制

System prompt 教模型只能保存 `user / feedback / project / reference`，**不能**保存 code patterns / git history / 任何能从代码库重新推导的东西。

#### 任务 10.3：YAML frontmatter

```yaml
---
name: Testing Policy
description: Integration tests must hit real DB, not mocks
type: feedback
---

(body...)
```

#### 任务 10.4：写路径 = 普通工具

不要发明新 API。模型用现有的 `Write` 和 `Edit` 工具：
1. 写一个 `feedback_testing.md`
2. Edit `MEMORY.md` 加一行索引

#### 任务 10.5：Recall = LLM 边路查询

```typescript
async function selectRelevantMemories(userQuery: string, manifest: MemoryManifest): Promise<string[]> {
  const result = await callHaiku({
    system: MEMORY_SELECTOR_PROMPT,
    messages: [{ role: "user", content: `Query: ${userQuery}\nManifest:\n${formatManifest(manifest)}` }],
    response_format: { type: "json_schema", schema: { selected_memories: z.array(z.string()) } },
  });
  return result.selected_memories.filter(name => manifest.has(name));  // 验证防幻觉
}
```

#### 任务 10.6：Staleness 警告

```typescript
function stalenessWarning(mtimeMs: number): string {
  const days = Math.floor((Date.now() - mtimeMs) / 86400000);
  if (days <= 1) return "";
  return `\n[Note: This memory is ${days} days old. Verify against current code before relying on file:line citations.]`;
}
```

#### 任务 10.7：背景抽取 agent

每次 query loop 结束后，fork 一个轻量 agent 查看最近消息，捕捉用户提到但没记下的"feedback / preferences"。

**Milestone**：让模型在 session 1 中记住"我们使用 PGlite 做集成测试"，session 2 启动后写测试时它自动遵守。

**学到的核心模式**：
- ✅ 文件型 memory（架构赌注 2）
- ✅ LLM recall > embedding（更好处理否定、上下文）
- ✅ Staleness warning > expiration

---

### 阶段 11：扩展性 - Hooks 与 Skills（Week 15）—— 对应第 12 章

#### 任务 11.1：Hooks 配置

```json
// .myagent/settings.json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash(git push *)", "command": "./scripts/check-branch.sh", "type": "command" }
    ],
    "PostToolUse": [...],
    "Stop": [...]
  }
}
```

#### 任务 11.2：启动快照（防注入）

```typescript
// init() 时读取一次，冻结，运行时不再读盘
const HOOK_SNAPSHOT = Object.freeze(loadHooks());
```

#### 任务 11.3：执行 hook = spawn 进程

```typescript
async function runHook(hook: Hook, payload: any): Promise<HookDecision> {
  const proc = spawn(hook.command, { stdio: ["pipe", "pipe", "pipe"] });
  proc.stdin.end(JSON.stringify(payload));
  const stdout = await collectStdout(proc);
  // exit code 0 = continue; 2 = block; 其他 = warning
  return parseDecision(proc.exitCode, stdout);
}
```

#### 任务 11.4：Skills 两阶段加载

```
启动：扫描 .myagent/skills/*/SKILL.md，只读 frontmatter （name, description, when_to_use）
调用：模型决定使用某 skill 时，工具读取该 SKILL.md 的完整内容并 inject 为 user message
```

#### 任务 11.5：Skill 调用的"快路径"

如果 skill 是内部、可信的（built-in），跳过 spawn 进程，直接 in-process 调用，节省 70% 延迟。

**Milestone**：写一个 lint hook，每次 Edit 后自动运行 ESLint，错误时 block 模型继续。

**学到的核心模式**：
- ✅ Hooks（外部进程）vs Plugins（in-process）—— 进程隔离换稳定性
- ✅ 启动快照 = 安全
- ✅ Skill 两阶段加载（模式 7）

---

### 阶段 12：Sub-Agents（Week 16）—— 对应第 8、9、10 章

让模型自己 spawn 帮手。

#### 任务 12.1：AgentTool 定义

```typescript
const AgentTool = buildTool({
  name: "Agent",
  inputSchema: z.object({
    description: z.string(),
    prompt: z.string(),
    subagent_type: z.enum(["general-purpose", "explore", "plan", "verifier"]).optional(),
    model: z.enum(["sonnet", "haiku", "opus"]).optional(),
    run_in_background: z.boolean().optional(),
  }),
  isConcurrencySafe: () => false,  // 默认串行；swarm 模式才并行
  call: async (input, ctx) => {
    // 走完整 15 步生命周期 → 调用 runAgent()
    return runAgent({ ... });
  },
});
```

#### 任务 12.2：runAgent 15 步生命周期（精简版做 8 步即可）

1. 模型解析（caller > definition > parent > default）
2. AgentId 生成
3. Context 准备（fork 用 parent 历史，否则空）
4. CLAUDE.md 剥离（read-only agents 不需要）
5. 权限隔离（自己的 mode + scope）
6. 工具池解析（read-only agents 没有 Edit/Write）
7. System prompt 构建
8. **Abort controller 隔离**（async agent 自己一个；sync agent 共享 parent 的）
9. （可选）Hook 注册
10. （可选）Skill 预加载
11. Context 创建
12. 调用 query loop
13. **Cleanup（finally 块）**：MCP 断开、hooks 清除、文件缓存清空、子进程 kill

#### 任务 12.3：4 个内置 sub-agent 类型

| 类型 | 模型 | 工具 | 何时用 |
|---|---|---|---|
| general-purpose | inherit | 全（除 Agent） | 默认 |
| explore | **haiku** | 只读 | 大规模搜索 |
| plan | inherit | 只读 | 架构设计 |
| verifier | inherit | 只读 | 对抗性验证（**总是 background**） |

#### 任务 12.4：Fork agent（关键优化）

让 child 共享 parent 的 system prompt + tool array + message history（**字节级一致**）。这样 API 端 prompt cache 命中，节省约 90% 输入 token。

#### 任务 12.5：Bubble 权限模式

子代理没有终端 → 权限请求"冒泡"到 parent 终端。

**Milestone**：`agent "并行搜索 src/ 和 tests/ 中所有的 deprecated 标记"` → 模型 spawn 两个 explore sub-agent 并行，最后汇总。

**学到的核心模式**：
- ✅ 子代理 = 同一个 query loop 的递归（不是特殊代码路径）
- ✅ Fork = cache 共享（架构赌注 4）
- ✅ Bubble 模式

---

### 阶段 13：MCP 协议集成（Week 17）—— 对应第 15 章

让你的 agent 能用第三方工具（Slack、Linear、GitHub 等）。

#### 任务 13.1：MCP 客户端基础

```typescript
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";

const client = new Client({ name: "myagent", version: "1.0" });
await client.connect(new StdioClientTransport({ command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"] }));
const tools = await client.listTools();
```

#### 任务 13.2：MCP 工具适配器

把 MCP tool 包装成你的 `Tool` 接口：

```typescript
function wrapMcpTool(client: Client, mcpTool: MCPTool): Tool {
  return buildTool({
    name: `mcp__${client.name}__${mcpTool.name}`,
    description: mcpTool.description,
    inputSchema: jsonSchemaToZod(mcpTool.inputSchema),
    isConcurrencySafe: () => false,  // 保守
    call: async (input) => {
      const result = await client.callTool({ name: mcpTool.name, arguments: input });
      return { content: result.content };
    },
  });
}
```

#### 任务 13.3：8 种 transport（先做 2 种）

先做 stdio + HTTP，后面有需要再加 SSE / WebSocket / SDK / IDE。

#### 任务 13.4：MCP tools 在 prompt 中的位置

按字母排序，**追加在 built-in 工具后**（这样添加 MCP server 不会影响 built-in 的 cache 位置）。

**Milestone**：连接 GitHub MCP server，让 agent `agent "把昨天的 PR 都列出来"`。

**学到的核心模式**：
- ✅ MCP 是事实标准 → 不要发明私有工具协议

---

### 阶段 14：性能优化（Week 18）—— 对应第 17 章

#### 任务 14.1：性能预算表

| 操作 | 目标 | 实测 |
|---|---|---|
| `--version` 启动 | < 50ms | __ |
| 冷 REPL 启动 | < 350ms | __ |
| 第一次首字节（TTFB） | < 1s | __ |
| Cache hit rate（5 轮+） | > 70% | __ |
| 内存峰值（1h 会话） | < 500MB | __ |

#### 任务 14.2：代码级优化清单

- [ ] 用 `Promise.all` 替换串行 await
- [ ] 大对象用 `for...of` 不用 `forEach`
- [ ] React memo（`memo`, `useMemo`, `useCallback`）渲染热路径
- [ ] Bash spawn 复用（避免重复 fork）
- [ ] `readFileState` LRU 上限（防内存泄漏）
- [ ] Generator cleanup `try/finally`（防进程泄漏）

#### 任务 14.3：Profile 工具

- Node.js 内置 `--prof`
- `clinic.js`（GUI 化展示）
- 自打 50+ 个 perf checkpoint

**Milestone**：所有指标达标。

---

## 四、关键的反模式（务必避开）

> 这些都是 Claude Code 源码里**血泪史**留下的注释教训。

### 反模式 1：在 boundary 之前加条件 system prompt section
**后果**：每个条件让 cache 变体翻倍（2^N），后果可能是几百倍处理成本。  
**做法**：所有 runtime 条件都放在 dynamic boundary 之后。

### 反模式 2：忽略 fail-closed 默认值
**例**：写新工具忘记声明 `isReadOnly` → 默认 `true` 会让 `rm -rf /` 也并发执行。  
**做法**：默认全 `false`（最安全）。

### 反模式 3：把 sub-agent 写成特殊代码路径
**后果**：行为悄悄发散，错误处理不一致。  
**做法**：sub-agent = 同一 `query()` 函数 + 不同 message history + 不同 tool pool。

### 反模式 4：retry 没有 circuit breaker
**事故**：生产环境会因为某个 corner case 一夜烧掉数千美元 API 配额。  
**做法**：每个 retry 显式上限：`MAX_AUTOCOMPACT_FAILURES = 3` 之类。

### 反模式 5：把 error 直接 yield 给消费者
**后果**：SDK 消费者可能在错误上断开连接，恢复 loop 继续跑但没人听。  
**做法**：可恢复错误**先 withhold**，所有恢复都失败再上抛。

### 反模式 6：在 context window 边缘没有"安全垫"
**做法**：`AUTOCOMPACT_THRESHOLD = effectiveWindow - 13000`，留出空间让 compact 自己运行。

### 反模式 7：所有事都用同一个 abort controller
**后果**：用户 Ctrl+C 杀掉 background agent，丢失工作。  
**做法**：query/sibling/per-tool 三层 controller 结构。

### 反模式 8：用 EventEmitter 做 agent loop
**后果**：背压问题、取消混乱、终止状态丢失。  
**做法**：始终用 async generator。

### 反模式 9：动态 dump 全部 agent 列表到 tool description
**后果**：每次配置变化（连 MCP / 装 plugin）都 bust 掉前面 50K tokens 的 cache。  
**做法**：放到 user attachment message 里。

### 反模式 10：直接读 session memory 不管 staleness
**做法**：超过 1 天的 memory 自动附加 staleness 警告。

---

## 五、推荐的学习节奏

| 节奏类型 | 时长 | 适合谁 |
|---|---|---|
| **冲刺型** | 6 周（每天 4h） | 已有 LLM 工程经验、想快速建立完整心智模型 |
| **稳健型** | 18 周（周末 8h） | 想真正吃透每个模式、并产出 portfolio 项目 |
| **零碎型** | 半年（每天 1h） | 工作之余学习；建议跳过阶段 8-9，重点做 1-7、10、12 |

**每周必做**：
1. 阅读对应章节 2 遍：第一遍快速通读，第二遍重点看 "Apply This"
2. Build 至少一个可运行 milestone
3. 在你自己的项目里**真实使用** Claude Code 同样的功能，对比你的实现
4. 写一篇 < 500 字的 blog 总结这周学到了什么（强迫主动消化）

---

## 六、最后的几条核心原则（贴墙上）

1. **The product is the model.** 你的 agent 质量上限 = 模型质量。所有"agent harness"都是把模型推理力转化为可靠工具调用的脚手架。

2. **Push complexity to boundaries.** 内部保持纯净，混乱在 input parser、output renderer、external protocol 处吸收。

3. **Every retry needs a circuit breaker.** 没有例外。

4. **Generator > Callbacks.** 在 agent loop 这个领域，不要折中。

5. **Fail-closed by default.** 安全相关的默认值永远偏严格。

6. **Cache stability is architecture.** Prompt cache 不是 feature，是约束你 prompt 结构的物理定律。

7. **Files beat databases.** 对于 agent memory、配置、hooks，文件系统的可观察性 > 数据库的查询能力。

8. **Don't reinvent MCP.** 用标准协议，让生态为你打工。

9. **Measure, then optimize.** 50+ profile checkpoint 不是过度设计，是工程严肃性。

10. **Read the source.** Claude Code 的 npm 包里有 source maps，自己去读。

---

## 七、参考资料汇总

| 资源 | 链接 | 用法 |
|---|---|---|
| **本书 18 章原文** | https://github.com/alejandrobalderas/claude-code-from-source/tree/main/book | 主参考，每周精读 1 章 |
| **官方 Claude Code 文档** | https://docs.claude.com/en/docs/claude-code | 用户视角理解功能 |
| **Anthropic API 文档** | https://docs.claude.com | 实现 API 层时必查 |
| **MCP 规范** | https://modelcontextprotocol.io | 阶段 13 必读 |
| **Ink 文档** | https://github.com/vadimdemedes/ink | 阶段 9 必读 |
| **VILA-Lab 学术分析** | https://github.com/VILA-Lab/Dive-into-Claude-Code | 比较视角，深化理解 |
| **`@anthropic-ai/sdk` 源码** | https://github.com/anthropics/anthropic-sdk-typescript | 看 SDK 内部细节 |

---

**结语**

不要急着写完所有功能。Claude Code 团队用了**很多人月**才达到现在的状态，每一行代码背后都有真实的 production incident。你的目标不是复刻全部，而是通过**亲手实现核心 30%** 来内化整个领域的设计模式。

完成阶段 1-7 你就已经能得到一个**可用的、有自己特色的 AI 编码 agent**，超过 90% 的同类教程项目。

剩下的阶段是在为"多 agent 协作"和"生态"打基础——这些是更前沿的领域，做完后你会成为真正稀缺的人才。

🦀 The crab has the map. Go read it.
