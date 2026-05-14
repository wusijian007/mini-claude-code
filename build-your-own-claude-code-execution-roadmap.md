# 从 0 到 1 构建 Claude Code：执行版 Roadmap

> 这是一份面向个人 / 小团队实战的 build 手册。  
> 核心原则：**先做安全的可用 agent，再做聪明的 agent，最后做便宜、快、可扩展的 agent。**

---

## 0. 两份文档的关系

- `build-your-own-claude-code-roadmap.md` 是**知识地图**：负责理解 Claude Code 的架构模式、核心抽象、反模式和源码学习脉络。
- `build-your-own-claude-code-execution-roadmap.md` 是**执行手册**：负责指导你从 0 到 1 逐周 build 一个可运行、可测试、可扩展的 AI 编码 agent。

读法建议：

1. 每周先读知识地图里对应章节，建立概念。
2. 再按本执行手册实现本周 milestone。
3. 每周必须留下可运行产物、测试记录和复盘笔记。

---

## 1. 执行原则

### 1.1 三阶段原则

1. **先做安全的可用 agent**：宁可功能少，也不要让 agent 在没有权限边界时执行危险操作。
2. **再做聪明的 agent**：在可用、安全、可测试之后，再加并发、memory、hooks、skills、MCP。
3. **最后做便宜、快、可扩展的 agent**：当核心系统稳定后，再优化 prompt cache、fork agents、remote、性能。

### 1.2 安全顺序

- 早期不做无权限 Bash。
- Bash 初版只允许白名单只读命令。
- Edit / Write 必须具备权限模式、diff preview、staleness check。
- 所有工具默认 fail-closed：默认不可并发、默认不是只读、默认需要权限。
- 所有 retry 必须有 circuit breaker。

### 1.3 每周交付物

每周都必须交付：

- 一个可以运行的 milestone。
- 至少一组 fake model / golden transcript 测试。
- 一条复盘记录：本周学到什么、踩到什么坑、下周如何改。

---

## Phase A：安全可用 Agent（Week 0-6）

目标：先得到一个能在本地安全读代码、理解代码、做受控修改的最小编码 agent。

### Week 0：工程骨架与协议先行

**学习目标**

建立项目骨架，先定义系统内部协议，而不是直接写模型调用。你要先知道 agent loop、工具、消息、终止状态之间如何对话。

**主要实现任务**

- 初始化 TypeScript monorepo：`packages/{cli,core,tools,ui}`。
- 定义核心类型：`Message`、`ToolUse`、`ToolResult`、`LoopEvent`、`TerminalState`、`PermissionDecision`。
- 建立 `FakeModel`，可以按脚本吐出 assistant message 和 tool_use。
- 建立 golden transcript fixture，用来记录一次完整 agent 交互。
- 实现 `myagent --version` 和 `myagent --help`。

**验收标准**

- `myagent --version` 能在终端输出版本。
- 不接真实 API，也能用 fake model 跑完一条 transcript。
- golden transcript 测试能断言 loop event 顺序。

**对应原书章节**

- Ch1 Architecture
- Ch2 Bootstrap
- Ch5 Agent Loop

**风险提醒**

- 不要一开始就接真实模型，否则你会用 API 调试架构。
- 不要先做 UI，先让核心协议可测试。

---

### Week 1：API 层最小闭环

**学习目标**

实现一个可靠的模型调用边界，让 query loop 不关心具体 provider、认证和网络细节。

**主要实现任务**

- 实现 `ModelClient` 接口：`stream()`、`create()`。
- 接入 Anthropic SDK 的最小流式调用。
- 增加 request id、基础错误类型、超时配置。
- 实现 streaming watchdog：长时间没有 chunk 时主动 abort。
- 实现非流式 fallback，但仅在没有工具投机执行时启用。
- 保留 fake model，所有 core 测试默认使用 fake model。

**验收标准**

- `myagent chat "hello"` 可以流式输出真实模型响应。
- fake model 测试不依赖网络和 API key。
- 模拟 stream stall 时，watchdog 能触发并走 fallback 或返回可分类错误。

**对应原书章节**

- Ch4 API Layer
- Ch17 Performance

**风险提醒**

- 不要把 provider 判断散落到 loop 内。
- 不要把模型名硬编码到业务逻辑里。
- 不要在这周实现 prompt cache 全套机制，只保留 prompt block 的结构位置。

---

### Week 2：只读 Agent Loop

**学习目标**

把单次模型调用变成可循环的 agent：模型请求工具，工具结果回填，直到模型不再请求工具。

**主要实现任务**

- 实现 async generator 版本的 `query()`。
- 支持 `Read`、`Glob`、`Grep` 三个只读工具。
- 实现 tool result 回填到 message history。
- 实现 `TerminalState`：`completed`、`aborted`、`max_turns`、`error`。
- 加入 `maxTurns`，防止无限循环。

**验收标准**

- 用户输入“总结 README”，模型能调用 `Read` 并总结结果。
- 用户输入“找出 src 下 TODO”，模型能调用 `Glob/Grep/Read` 并汇总。
- fake transcript 能覆盖：无工具结束、多轮工具调用、超过 maxTurns。

**对应原书章节**

- Ch1 Architecture
- Ch5 Agent Loop
- Ch6 Tools

**风险提醒**

- 本周不要做 Bash。
- 不要用 EventEmitter 做主 loop。
- 不要让工具直接修改全局状态，先通过 ToolResult 回传。

---

### Week 3：工具系统与权限骨架

**学习目标**

把工具从函数升级为自描述对象：schema、权限、并发安全、结果预算都由工具自己声明。

**主要实现任务**

- 实现 `buildTool()`，注入 fail-closed 默认值。
- 每个工具必须声明 `name`、`description`、`inputSchema`、`call()`。
- 增加 `isReadOnly(input)`、`isConcurrencySafe(input)`、`validateInput(input, ctx)`。
- 实现工具执行 pipeline 的最小版：lookup、abort check、Zod validation、semantic validation、permission、execute、budget、error classification。
- 实现权限模式最小集：`plan`、`default`、`bypassPermissions`。
- 实现 permission matrix 测试。

**验收标准**

- schema 错误不会进入工具执行。
- `plan` 模式拒绝所有非只读工具。
- 未声明安全属性的新工具默认不可并发、默认按写操作处理。
- permission matrix 测试覆盖 read tool、write tool、unknown tool、invalid input。

**对应原书章节**

- Ch6 Tools
- Ch1 Permission System

**风险提醒**

- 不要让 `checkPermissions()` 成为唯一权限机制，它只是分层解析链中的一环。
- 不要在中央 orchestrator 写死每个工具的安全逻辑。

---

### Week 4：安全写入能力

**学习目标**

在权限边界和文件新鲜度检查存在的前提下，加入最小可用的代码修改能力。

**主要实现任务**

- 实现 `Edit` 工具：基于 `old_string/new_string` 的精确替换。
- 实现 `Write` 工具：仅允许创建或覆盖经过确认的文件。
- 实现 `readFileState`：记录文件路径、mtime、hash、最近读取内容。
- Edit / Write 前必须检查 staleness。
- 生成 diff preview，交给权限 prompt 或 headless policy。
- Bash 初版只允许白名单只读命令：`pwd`、`ls`、`cat`、`grep`、`rg`、`find`、`git status`、`git diff`、`git log`。

**验收标准**

- agent 能修复 fixture repo 中一个小 bug。
- 未读过的文件不能直接 Edit。
- 文件被外部修改后，Edit 必须失败并提示重新 Read。
- `rm`、`mv`、`git commit`、带重定向写入的 Bash 都被拒绝或要求明确权限。

**对应原书章节**

- Ch6 Tools
- Ch7 Concurrency
- Ch2 Trust Boundary

**风险提醒**

- 不要为了进度跳过 diff preview。
- 不要用字符串猜测复杂 shell 命令；无法可靠解析时按危险处理。

---

### Week 5：状态与会话持久化

**学习目标**

把散落变量收束为两层 state：基础设施状态和 UI / app 响应式状态。

**主要实现任务**

- 实现 bootstrap singleton：`sessionId`、`cwd`、`model`、`cost`、`tokenUsage`、`permissionMode`。
- 实现最小 reactive store：`get`、`set(updater)`、`subscribe`、`onChange`。
- 会话 transcript 落盘到 `.myagent/sessions/`。
- 实现 `myagent resume <sessionId>`。
- 路径字段统一 normalize。

**验收标准**

- 一次会话退出后可以 resume。
- UI/app store 变化能同步必要字段到 bootstrap state。
- bootstrap state 不依赖 React、UI、tools。
- transcript 中能重放用户消息、assistant 消息、tool_use、tool_result。

**对应原书章节**

- Ch3 State
- Ch2 Bootstrap

**风险提醒**

- 不要把所有状态都塞进 reactive store。
- 不要让基础设施模块 import UI 层。

---

### Week 6：上下文预算与错误恢复

**学习目标**

让长对话不会无限膨胀，让可恢复错误不会过早暴露给上层消费者。

**主要实现任务**

- 实现保守 token 估算：优先 API usage，新增消息用估算。
- 实现 tool result budget：超限落盘，只返回预览和路径。
- 实现 simple snip compact。
- 实现 withheld recoverable error。
- 实现 retry circuit breaker：prompt too long、max output、stream failure 各自有上限。
- 增加 `/compact` 命令的 headless 版本。

**验收标准**

- 大工具结果不会直接塞爆上下文。
- 模拟 prompt-too-long 时，系统先 compact，再失败才暴露错误。
- 任意 retry 路径最多执行固定次数。
- golden transcript 覆盖 compact 前后消息变化。

**对应原书章节**

- Ch5 Agent Loop
- Ch4 API Layer
- Ch17 Performance

**风险提醒**

- 不要相信纯客户端 token 估算。
- 不要把 recoverable error 立即 yield 给 SDK / UI 消费者。

---

## Phase B：聪明 Agent（Week 7-12）

目标：让 agent 更像真实开发伙伴：能并发读代码、记住偏好、被 hooks 约束、通过 MCP 使用外部工具。

### Week 7：并发与取消

**学习目标**

让只读工具并行执行，写操作保持串行，同时保持结果顺序和取消语义可控。

**主要实现任务**

- 实现 `partitionToolCalls()`：按输入判定并发安全。
- 实现 bounded concurrency，默认最大 10。
- 实现 query-level、sibling-level、per-tool 三层 abort controller。
- 并发工具的 context modifier 延后到 batch 结束，按工具提交顺序应用。
- Bash 错误级联取消同批兄弟；Read/Grep 错误隔离。

**验收标准**

- 5 个 Read 可以并行执行。
- Edit 永远独占执行。
- 并发完成顺序不同，也能按提交顺序回填结果。
- Ctrl+C 能中断当前 turn 并清理正在执行的工具。

**对应原书章节**

- Ch7 Concurrency
- Ch6 Tools

**风险提醒**

- 不要把并发安全当作工具类型属性，它必须依赖输入。
- 不要让并发工具立即修改共享 context。

---

### Week 8：CLI / TUI 最小可用体验

**学习目标**

把 headless agent 变成你愿意日常试用的终端工具，但暂不复刻生产级自定义 renderer。

**主要实现任务**

- 用 Ink 或简单 stdout 渲染流式输出。
- 实现输入框、消息列表、工具调用展示、权限确认 prompt。
- 支持 `Ctrl+C` 中断当前 turn，`Ctrl+D` 退出。
- 支持基础 slash commands：`/help`、`/clear`、`/compact`、`/model`、`/resume`。
- 支持历史输入。

**验收标准**

- 能连续进行 10 轮交互。
- 权限 prompt 可以 allow / deny。
- Ctrl+C 不会让终端留在异常状态。
- `/compact` 后仍可继续对话。

**对应原书章节**

- Ch13 Terminal UI
- Ch14 Input and Interaction

**风险提醒**

- 不要在这周做 custom renderer。
- 不要让 UI 状态污染 core loop。

---

### Week 9：Memory 系统

**学习目标**

让 agent 跨 session 记住用户偏好和项目约束，同时避免把可从代码重新推导的信息存成陈旧记忆。

**主要实现任务**

- 建立 `.myagent/projects/<project-slug>/memory/`。
- 实现 `MEMORY.md` 索引。
- 支持四类 taxonomy：`user`、`feedback`、`project`、`reference`。
- 实现 `/memory save`，通过现有 Write/Edit 工具写入 memory。
- 实现 memory recall：先加载索引，再用轻量模型选择相关 memory。
- 超过 1 天的 memory 附加 staleness warning。

**验收标准**

- session 1 保存“测试必须用真实 DB，不用 mock”。
- session 2 写测试时能自动读取并遵守这条 memory。
- 不允许保存 code pattern、git history、能从代码库重新推导的信息。
- memory 文件可人工编辑，下一次启动能生效。

**对应原书章节**

- Ch11 Memory
- Ch5 Agent Loop

**风险提醒**

- 不要上来就做向量数据库。
- 不要新增特殊 memory 写 API；优先复用文件工具。

---

### Week 10：Hooks 与 Skills

**学习目标**

把“模型知道什么”和“系统什么时候拦截执行”分开。Skills 增加能力，Hooks 增加约束。

**主要实现任务**

- 实现 skills 扫描：读取 `SKILL.md` frontmatter。
- 调用 skill 时才读取完整正文并注入上下文。
- 实现 `PreToolUse` 和 `PostToolUse` hooks。
- Hook 初版只支持 command hook：stdin JSON、exit code 0 通过、exit code 2 阻断、其他 warning。
- 启动时读取 hook 配置并冻结为 snapshot。

**验收标准**

- 一个 skill 能指导 agent 按项目规范写测试。
- 一个 lint hook 能在 Edit 后运行检查，失败时阻止继续。
- 修改 hook 配置文件不会影响当前 session，重启后才生效。
- MCP 来源的 skill 不执行 inline shell。

**对应原书章节**

- Ch12 Extensibility
- Ch6 Tools
- Ch2 Bootstrap

**风险提醒**

- 不要把 hooks 做成 in-process plugin。
- 不要运行不可信 MCP skill 里的 shell 命令。

---

### Week 11：MCP 最小集成

**学习目标**

让 agent 使用外部工具协议，而不是发明私有工具生态。

**主要实现任务**

- 接入 `@modelcontextprotocol/sdk`。
- 支持 stdio MCP server。
- 支持 Streamable HTTP MCP server 的最小调用。
- 将 MCP tools 包装成内部 `Tool`。
- MCP tool 命名格式：`mcp__serverName__toolName`。
- Built-in tools 固定排在 MCP tools 前面，MCP tools 在后面按名称排序。

**验收标准**

- 能连接一个本地 stdio MCP server。
- `tools/list` 结果能进入 agent tool pool。
- agent 能调用 MCP tool 并拿到 tool_result。
- 新增或删除 MCP server 不改变 built-in tool 顺序。

**对应原书章节**

- Ch15 MCP
- Ch6 Tools
- Ch4 API Layer

**风险提醒**

- MCP annotation 可以作为 hint，但不能盲目信任为安全事实。
- 不要为了 MCP 改造已有工具 pipeline。

---

### Week 12：真实试用与修补周

**学习目标**

暂停加大功能，用自己的项目真实使用 agent，修掉阻碍日常使用的关键问题。

**主要实现任务**

- 用 agent 完成 3 个真实但低风险的小任务。
- 记录失败 transcript，补 golden tests。
- 补权限矩阵、并发顺序、memory recall、hook 阻断测试。
- 梳理 backlog：必须修、可以延后、不做。
- 写一篇项目复盘。

**验收标准**

- 至少 3 个真实任务完成并有 transcript。
- 每个失败都转成一个测试或明确 backlog。
- agent 在只读分析、小修改、运行检查三个场景都可用。

**对应原书章节**

- Ch1-Ch15 综合复盘
- Ch18 Epilogue

**风险提醒**

- 不要急着进入 sub-agent；先让单 agent 稳。
- 如果你不愿意自己用它，说明基础体验还没过关。

---

## Phase C：便宜、快、可扩展 Agent（Week 13-18）

目标：在核心 agent 稳定后，加入多 agent、cache 共享、remote 和性能工程。

### Week 13：Task 状态机

**学习目标**

为后台任务和 sub-agent 打基础。先管理任务生命周期，再 spawn agent。

**主要实现任务**

- 定义 `TaskState`：`pending`、`running`、`completed`、`failed`、`killed`。
- 定义 task 类型初版：`local_bash`、`local_agent`。
- 每个 task 有 prefixed id、description、start/end time、outputFile、outputOffset。
- 后台任务输出写入文件，父 agent 可增量读取。
- 实现 task kill。

**验收标准**

- 后台只读 Bash 可以启动、输出、完成、被 kill。
- task 完成通知不会重复发送。
- output file 可以在进程重启后被读取。

**对应原书章节**

- Ch10 Coordination
- Ch8 Sub-Agents

**风险提醒**

- 不要用内存消息队列作为唯一输出通道。
- 不要在还没有 task state machine 时直接做 sub-agent。

---

### Week 14：Sub-Agent

**学习目标**

让主 agent 能委派工作，但 sub-agent 必须复用同一个 query loop，而不是走特殊代码路径。

**主要实现任务**

- 实现 `Agent` 工具。
- 支持 `description`、`prompt`、`subagent_type`、`model`、`run_in_background`。
- 内置 agent 类型初版：`general`、`explore`、`verifier`。
- explore 默认只读工具。
- verifier 默认 background。
- sub-agent 权限默认 `bubble` 或只读，不允许自行批准危险操作。

**验收标准**

- 主 agent 能启动 explore sub-agent 搜索代码。
- sub-agent 最终输出回填给主 agent。
- sub-agent 不能直接执行危险写操作。
- fake transcript 覆盖 sync agent、background agent、permission bubble。

**对应原书章节**

- Ch8 Sub-Agents
- Ch10 Coordination
- Ch6 Tools

**风险提醒**

- 不要把 sub-agent 写成新的 mini-agent 框架。
- 不要把 parent 的可变 context 全量共享给 child。

---

### Week 15：Fork Agent 与 Prompt Cache 稳定性

**学习目标**

让并行 child agent 共享 parent 的 prompt 前缀，降低成本并避免重复上下文构造。

**主要实现任务**

- 捕获 parent 最近一次 API 请求的 rendered system prompt。
- fork child 复用 parent 的 tool array，保持顺序和序列化稳定。
- fork child 复用 parent message prefix。
- child directive 只追加在共享前缀之后。
- 增加 recursive fork guard。
- 增加 cache-stability trace：记录 system prompt hash、tool hash、prefix hash。

**验收标准**

- 两个 fork child 的 prefix hash 相同。
- child 不会继续 fork 出无限递归。
- 修改 MCP tool 列表不会改变 built-in tool prefix。
- trace 能解释一次 cache miss 的来源。

**对应原书章节**

- Ch9 Fork Agents
- Ch4 API Layer
- Ch17 Performance

**风险提醒**

- 不要在 fork child 中重新渲染 system prompt。
- 不要为了禁止 child 用 Agent tool 而把 Agent tool 从 tool array 移除；这会破坏工具前缀稳定性。

---

### Week 16：Remote Optional

**学习目标**

只做最小 direct connect，让 agent 可以被浏览器或本地客户端远程驱动。完整云执行先不做。

**主要实现任务**

- 实现本地 WebSocket server。
- 浏览器 / 本地 client 可以发送 user message。
- 读通道用 WebSocket 持久连接，写操作带 UUID 去重。
- 权限请求可以回传给 client，并等待 client 决策。
- session metadata 落盘，支持 detach / resume。

**验收标准**

- 浏览器发送 prompt，CLI agent 执行并流式返回消息。
- 同一个 UUID 重放不会造成重复 user message。
- WebSocket 断开后可以重连并继续读取 session。

**对应原书章节**

- Ch16 Remote
- Ch10 Coordination

**风险提醒**

- 不要一开始做云容器、OAuth、credential injection。
- 不要把读写都强行塞进同一种语义；远程系统天然适合读写分离。

---

### Week 17：启动、Token、渲染性能

**学习目标**

把性能从“感觉”变成指标，优先优化启动、token 使用、API 成本和渲染热路径。

**主要实现任务**

- 增加 profile checkpoints。
- `--version`、`--help` fast path 不加载完整系统。
- provider、telemetry、MCP、TUI 使用 dynamic import 延迟加载。
- 实现 output slot reservation：默认 8K，截断后单次升级。
- 系统 prompt 分成 static boundary 和 dynamic boundary。
- 增加 sticky latch 初版，保护 cache key。

**验收标准**

- 记录 `--version`、`--help`、REPL 冷启动、首 token 时间。
- 默认输出 cap 不再过度预留。
- system prompt static 部分在连续请求中 hash 稳定。
- dynamic runtime 信息只出现在 boundary 之后。

**对应原书章节**

- Ch2 Bootstrap
- Ch4 API Layer
- Ch17 Performance

**风险提醒**

- 不要在没有指标前做微优化。
- 不要把 runtime 条件放到 prompt cache boundary 之前。

---

### Week 18：收尾、文档与作品化

**学习目标**

把项目整理成可展示、可继续迭代的作品，而不是一堆实验代码。

**主要实现任务**

- 整理 README：功能、架构、运行方式、安全模型、限制。
- 整理架构图：query loop、tool pipeline、permission chain、task/sub-agent。
- 固化 smoke test：只读分析、小修改、memory、hook、MCP、sub-agent。
- 标注未实现的 Claude Code 生产级能力。
- 写最终复盘：哪些模式真正迁移成功，哪些不值得个人项目复刻。

**验收标准**

- 新用户能按 README 跑起项目。
- 一条命令能跑完 smoke test。
- 你能用 10 分钟讲清楚这个 agent 的架构和安全边界。
- backlog 明确分为 v1.1、v2、不会做。

**对应原书章节**

- Ch18 Epilogue
- 全书复盘

**风险提醒**

- 不要假装已经复刻完整 Claude Code。
- 作品价值来自清晰、安全、可运行，不来自功能数量。

---

## 4. 执行检查表

每周结束前检查：

- [ ] 本周是否有可运行 milestone？
- [ ] 是否有 fake model / golden transcript 测试？
- [ ] 是否有权限矩阵测试？
- [ ] 是否记录性能和 token 成本指标？
- [ ] 是否保留失败 transcript 并转化为测试或 backlog？
- [ ] 是否有明确的“本周不做”范围？
- [ ] 是否能用一句话说明本周能力如何接入 query loop？

每个阶段结束前检查：

- [ ] Phase A 结束：agent 是否安全、可用、能做受控小修改？
- [ ] Phase B 结束：agent 是否能记忆、被约束、接外部工具？
- [ ] Phase C 结束：agent 是否能多任务、共享 cache、被远程驱动、可衡量性能？

---

## 5. 默认技术取舍

- 语言：TypeScript。
- Runtime：Node.js 20+，需要性能实验时再评估 Bun。
- 测试：Vitest + fake model + fixture repo。
- Schema：Zod。
- CLI：Commander.js。
- UI：先 stdout / Ink，暂不做 custom renderer。
- Memory：Markdown 文件，不使用数据库。
- MCP：优先 stdio 和 HTTP。
- 安全：所有工具 fail-closed，所有危险操作必须显式权限。

---

## 6. 最小可用 v1 定义

完成 Week 0-6 后，你应该拥有一个 v1 agent：

- 能通过真实模型或 fake model 跑 query loop。
- 能安全读取、搜索、总结代码。
- 能在权限确认后做小规模 Edit / Write。
- 能记录 transcript 并 resume。
- 能处理工具结果过大、上下文过长、模型错误和用户中断。
- 有 golden transcript、权限矩阵、上下文预算测试。

这是整个项目最重要的分水岭。  
在 v1 之前，任何 sub-agent、MCP、memory、TUI 优化都应该让位于安全可用性。

---

## 7. 个人节奏建议

- 如果每天 2-3 小时：按 18 周完成。
- 如果周末学习：每个 Week 拆成 2 个自然周。
- 如果目标是快速作品集：只做 Week 0-6 + Week 8 + Week 18。
- 如果目标是深入 agent 架构：完整做 Week 0-18，并每周写复盘。

记住：这不是“读懂 Claude Code”的路线，而是“通过构建自己的 agent，逼自己真正理解 Claude Code 为什么这样设计”的路线。
