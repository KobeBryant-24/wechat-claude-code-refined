# `/notify-me`：监控会话本轮完成并微信通知

**日期**：2026-10-26
**状态**：已实现（设计已确认，4 个待定项已由用户拍板）
**前置事实**：`docs/superpowers/specs/2026-10-26-compact-msg-and-continue-design.md` 确立了「一条用户消息换 10 条出站」的配额模型，以及服务级功能与命令层的分工（`routeCommand` 只做判定，副作用由 `main.ts` 执行）。

---

## 1. 问题陈述

用户在 Claude Code 终端里跑一个长任务（重构、跑测试、查资料），不想守着窗口。微信这边只能等——除非他主动回到微信问一句。

桥接服务本身看不见终端里的 Claude Code 会话：它只知道自己经手的对话。终端会话唯一留下的持久痕迹是 transcript 文件——`~/.claude/projects/<project>/<sessionId>.jsonl`，一行一个 JSON 事件。

于是问题是：**怎么在不打断用户、不新增对话轮次的前提下，判定某个会话"这一轮做完了"，并主动推一条微信通知？**

约束：

- 通知是**服务级**的，不是某个微信会话的属性——用户要的是"那个终端会话"，不是"这个微信会话"。
- 同一时刻**最多监控一个会话**（用户明确要求）。
- 监控**不限时**，直到用户手动取消。
- 监控必须**跨服务重启**存活——watchdog 随时会重启守护进程。

## 2. 目标

1. 提供 `/notify-me <会话ID>`：把监视镜头对准某个 Claude Code 会话。
2. 该会话本轮结束时，微信收到一条完成提示。
3. 监控状态可查询（`/notify-me` 无参）、可取消（`/notify-me off`）、可被 `/status` 一眼看到。
4. 服务重启后监控继续，服务停机期间完成的那一轮仍然会被补报。

## 3. 已确认的设计决策

| # | 决策 | 用户选择 |
|---|---|---|
| 1 | 通知内容 | **只发完成提示**——不回放回复正文、不调 LLM 总结、不带附件，1 条消息 |
| 2 | 监控时长 | **不限时，手动取消为止**。监控线程不占资源，但**每次最多监控一个 session** |
| 3 | 监控可能结束时（如会话消失） | **也发一条提醒**——不能静默消失，用户得知道监视镜头没了 |
| 4 | 持久化 | **持久化，重启后继续** |

---

## 4. 改动清单

| 文件 | 改动 | 新增/修改 |
|---|---|---|
| `src/claude/session-watcher.ts` | **新建**。transcript 解析、回合判定、轮询、持久化、通知 | 新 |
| `src/commands/router.ts` | 路由 `notify-me`；`CommandContext` 加 `getNotifyWatch`；`CommandResult` 加 `notifyAction` | 改 |
| `src/commands/handlers.ts` | `handleNotifyMe`；`/help` 增补条目；`/status` 增补监控行 | 改 |
| `src/main.ts` | 启动 watcher；入站刷新 contextToken；执行 `notifyAction`（注册/取消） | 改 |
| `src/tests/session-watcher.test.ts` | **新建**。解析、判定、watcher 行为 | 新 |

---

## 5. 详细设计

### 5.1 transcript 格式与「本轮完成」的判据

实测 Claude Code 的 JSONL 事件形态（读真实 transcript 归纳）：

| 事件 | 含义 | 是否回合边界 |
|---|---|---|
| `{"type":"user","message":{"role":"user","content":"..."}}` | 用户（或排队的 prompt）发言 | **是**——一轮开始 |
| `{"type":"user","message":{"content":[{"type":"tool_result",...}]}}` | **工具**回报，不是人说话 | 否——这一轮还在跑 |
| `{"type":"assistant","message":{"stop_reason":"tool_use"}}` | Claude 调了工具 | 否——还在跑 |
| `{"type":"assistant","message":{"stop_reason":"end_turn"}}` | Claude 给出最终答复 | **是**——一轮结束 |
| `isSidechain: true` | 子 agent 的对话 | 忽略——不是同一条对话线 |
| `queue-operation` / `attachment` / `last-prompt` / `mode` / … | 元数据 | 忽略 |

三个必须踩准的点：

1. **工具结果长得像用户消息**。它也是 `type: "user"`，但 `content` 是 `[{type:"tool_result"}]` 数组。把它当 prompt 处理会让监视镜头在回合中途误判。
2. **一条 assistant 消息横跨多行 JSONL**。thinking 块和 text 块各占一行，`apiBlockIndex` 不同，但 `message.id` 和 `message.stop_reason` 相同。判据取 `message.stop_reason`，不看行数。
3. **子 agent 必须排除**。它写进同一个文件，但属于另一条对话线；它的"最终答复"不代表被监控的会话做完了。

**完成判据**：`message.stop_reason ∈ {end_turn, max_tokens, stop_sequence}`。`tool_use` 和 `pause_turn` 都表示"还在继续"。

### 5.2 状态机：`needUserPrompt` + `busy`

单纯看"最后一条是不是 end_turn"不够——它回答的是"会话此刻闲不闲"，不是"我要等的那一轮结束了没有"。

两个正交的状态位：

- `needUserPrompt` —— 还没看到我们要等的那一轮的 prompt。
- `busy` —— 会话此刻在跑。

注册时按会话当下的状态初始化：

| 注册时 | `busy` | `needUserPrompt` | 语义 |
|---|---|---|---|
| 会话正在跑 | `true` | `false` | prompt 在监视镜头装上之前就出现了，直接等它的 end_turn |
| 会话空闲 | `false` | `true` | 等下一个 prompt 出现，再等它的 end_turn |

轮询时逐行推进：

```
user_prompt        → needUserPrompt = false, busy = true
assistant 非终态   → busy = true
assistant 终态     → busy = false
                     若 needUserPrompt == false → 这一轮完成，触发通知
```

**为什么需要 `needUserPrompt`**：注册时会话空闲，然后 transcript 里出现了一条 end_turn——但那是**上一轮的尾巴**（注册前就写完了，我们只是刚读到）。若直接触发，用户会收到一条"你等的任务完成了"的假通知，而真正等的那一轮还没开始。`needUserPrompt` 就是防这个。

### 5.3 轮询：字节偏移

轮询间隔 3 秒。用**字节偏移**而不是字符偏移记录读到哪里：

- transcript 是 UTF-8，中文 3 字节、emoji 4 字节。字符偏移在多字节文本上会漂。
- 偏移必须**行对齐**（正好落在 `\n` 之后），否则下一次读到的第一行是残行。

`readTranscriptTail`（注册时用）读最后 256 KiB，用于判断会话当下忙不忙；窗口若从行中间开始，首行是残片，丢弃但偏移照常推进。

`readTranscriptFrom`（轮询时用）从偏移往后读完整行，末尾的半行留给下一次轮询——文件可能正在被写。另外做一次防御：若偏移处的上一个字节不是 `\n`（文件被换掉了），首行按残片丢弃。

### 5.4 持久化

watch 写在 `<DATA_DIR>/watch.json`（`~/.wechat-claude-code/watch.json`），字段：

```ts
{ sessionId, toUserId, contextToken, registeredAt, needUserPrompt, busy, offset }
```

**不写 transcript 的绝对路径**。两个理由：

1. 会话所在的项目目录会变——Claude Code 的 `/cd` 会把会话挪到另一个项目目录。存死的路径下次就失效了。路径改为**按 sessionId 重新解析**（扫 `~/.claude/projects/*/<sessionId>.jsonl`），会话挪到哪都能找到。
2. 不在仓库外留下一个指向用户对话文件的绝对路径。

重启后从 `offset` 继续读，因此**服务停机期间完成的那一轮仍然会被补报**——这是"持久化，重启后继续"的实际含义。

若按 id 解析不到会话（被删了 / 项目目录被清了），监视镜头无法继续：此时**发一条"会话已不存在，监控已结束"的提醒**并清掉记录。静默消失更糟——用户以为有人盯着，实际没有。

### 5.5 contextToken 刷新

通知是**主动发出**的，没有对应的用户消息来刷新配额。而 contextToken 会过期，服务端对过期 token 的拒绝方式与配额耗尽**完全一样**（都是 `ret=-2`）——两者无法区分。

因此每次收到用户消息时，调用 `sessionWatcher.noteInbound(fromUserId, contextToken)` 把监视镜头里的 token 换成最新的。这样通知真正触发时，token 至少是"上一条用户消息时"的，而不是注册时的。

### 5.6 命令面

```
/notify-me              查看当前监控状态（无监控时给出用法）
/notify-me <会话ID>     开始监控该会话
/notify-me off          取消监控
```

会话 ID 支持**前缀匹配**（复用 `findSessionFile`）：`/session` 列表里显示的是 8 位短 id，用户直接抄短 id 即可。匹配到多个会话时明确报错并列出候选，不猜。

短 id 只有**一个定义**（`shortSessionId`，`session-watcher.ts`），`/session` 列表、`/status`、监控通知三处共用——否则同一个会话在三处显示成不同的字符串，用户会以为监控错了对象。

**一次只监控一个**：注册新会话会顶掉旧的，回执里明说「原监控 xxx 已取消」。用户明确要求了这个上限——两个静默的监视镜头只会让人忘记第一个。

### 5.7 通知文案

完成时：

```
✅ 会话 abc12345 已完成本轮

用 /session abc12345 可切换查看完整对话。
```

只发一条，不回放正文、不调 LLM 总结、不带附件。理由是配额：一条用户消息换 10 条出站，通知本身不能是条数敏感的。

会话消失时：

```
⚠️ 被监控的会话 abc12345 已不存在，监控已结束。
```

### 5.8 命令层与执行层的分工

`routeCommand` 拿不到 sender、store 和 transcript 查找器——`CommandContext` 里没有这些东西。所以处理器的职责仅限于**判定**：

```ts
notifyAction?:
  | { kind: 'register'; sessionId: string; transcriptPath: string }
  | { kind: 'cancel' };
```

实际的注册/取消由 `main.ts` 执行（那里有 sender 和 watcher 实例）。这与 `/continue` 的 `continueSession` 标志是同一个模式：命令层说"要做什么"，调用层做。

`/notify-me` 的回执走 `enqueuePriority`——它是信息类回执，不该排在积压后面。

---

## 5.9 附带修复：`spawnDeathMonitor` 在 ESM 下从未成功

部署 `/notify-me` 时看日志发现：

```
WARN Failed to spawn death monitor {"error":"__dirname is not defined"}
```

`src/main.ts` 的 `spawnDeathMonitor()` 用 `join(__dirname, '..', 'scripts', 'death-monitor.cjs')` 定位 sibling 监视器，但本项目 `"type": "module"` + `tsconfig` 的 `module: Node16` → 编译产物是 ESM，**ESM 里没有 `__dirname`**。这段代码从写下来就没跑通过，日志里 00:51 那次启动同样报过同样的错——不是本次改动引入的。

改法：沿用 `commands/handlers.ts` 里已有的写法（`fileURLToPath(new URL('.', import.meta.url))`），不用 `import.meta.dirname`——后者要 Node 20.11+，而 `fileURLToPath` 在所有 ESM Node 版本上都可用。

**为什么它还是重要的**：watchdog-v2 自己也会写 `death-YYYY-MM-DD-{childPid}.log`（`watchdog-v2.cjs:122`），所以常规情况下死亡记录不会丢。但 watchdog 和 child 在同一棵进程树里——**整棵树一起死**时（机器断电、OOM killer、任务管理器杀进程组），watchdog 也死了，就没人写记录了。独立的 sibling 监视器正是为这个场景存在的：它在进程树的另一条分支上，能在 parent 消失后继续存活并同步落盘。

改完重启，日志确认：`INFO Death monitor spawned {"monitorPid":36704,"parentPid":33088}`。

---

## 6. 测试计划

**`src/tests/session-watcher.test.ts`**（20 个用例）

- **解析**：user 消息 → prompt；带 `tool_result` 的 user 条目 → 忽略；assistant 条目带出 `stop_reason`；`isSidechain` → 忽略；元数据/垃圾行 → 忽略。
- **忙闲判定**：末尾是 end_turn → 空闲；末尾是 tool_use → 忙；末尾是新 prompt → 忙；空 transcript → 空闲。
- **watcher**：
  - 运行中的会话结束后通知，文案含短 id 与「已完成本轮」。
  - 没有自己的 prompt 的 end_turn **不触发**（防假通知）；随后真正的 prompt + end_turn 才触发。
  - 回合中途的 tool_result **不提前结束**监视。
  - 注册新会话会顶掉旧的；被顶掉的会话随后完成**不**通知。
  - 取消返回被取消的监视；取消后即使会话完成也不通知。
  - **跨重启存活**：新实例从磁盘接回监视，服务停机期间完成的那一轮仍被补报。
  - 会话文件消失 → 结束监视并发出「已不存在」提醒。
  - 通知带的是**刷新后**的 contextToken。
  - 磁盘上的记录**不含** transcript 路径（按 id 解析，不存路径）。
- `shortSessionId` 与 `/session` 列表显示的 8 位一致。

测试全部在临时目录里造合成 JSONL，**不碰真实的 `~/.claude/projects`**。`projectsDir` 是可注入的（默认 `~/.claude/projects`），正是为了让"跨重启"这条路径能在不依赖真实会话文件的情况下被测到。

**回归**：`npm run build && npm test` 必须全绿（`npm test` 跑的是 `dist/`，不先 build 会拿旧产物测新代码）。

---

## 7. 风险与已知未解决项

| 风险 | 缓解 |
|---|---|
| transcript 格式随 Claude Code 版本变化 | 解析器**只依赖** `type` / `message.stop_reason` / `isSidechain` 三个稳定字段；认不出的事件一律忽略，不会误触发。真正的风险是格式变了导致**漏报**（不会误报）——最坏情况是用户以为没完成，其实已完成 |
| 一条 assistant 消息横跨多行 | 完成判据取 `message.stop_reason`，不看行数；一行一个事件解析也不会漏 |
| 主动通知没有用户消息刷配额 | 配额按用户计，上一条用户消息的额度仍在池子里；`noteInbound` 保证 token 不过期 |
| 会话被 `/cd` 挪到别的项目目录 | 路径按 id 重新解析，不存死路径 |
| 轮询空转 | 3 秒一次，只读文件尾部；同步读，不会自我并发 |
| 服务重启丢监视 | 状态持久化到 `watch.json`，重启后从字节偏移继续 |

**已知未解决（不在本次范围）**

- 通知是**单向**的：点开会话要看 `/session` 切换，不能在通知里直接接着聊。
- 一次只监控一个会话——用户已明确要求这个上限，没有做多会话并行监控。
- 监控对象是**本地** transcript 文件；远程/容器里的 Claude Code 会话看不到。
