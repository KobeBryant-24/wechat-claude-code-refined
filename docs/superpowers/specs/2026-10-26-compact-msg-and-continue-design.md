# 微信回复配额治理：compact-msg 模式 + /continue 指令

**日期**：2026-10-26
**状态**：待实现（设计已确认，4 个待定项已由用户拍板）
**前置事实**：`docs/superpowers/specs/2026-06-20-message-batching-design.md` 把 iLink 的 10 条限制误判为"突发速率限制"，因此保留了指数退避。本设计推翻那个模型。

---

## 1. 问题陈述

iLink 协议规定：**用户每发一条消息，bot 最多只能发出 10 条消息（含回复本身）**。这不是代码限制，是服务端配额。

| 事实 | 依据 |
|---|---|
| 10 条/24h 的配额按「用户消息」重置 | 腾讯云 amc 文章、weilink SDK 文档、WxPusher、pushplus、Kintio（6+ 独立来源） |
| 等待**不会**补充配额 | 同上。配额只在用户发新消息时重置 |
| 文件/媒体与文本**共用**同一池 | "10 outbound messages (text or media)"；一条消息 = 一个媒体项 |
| `ret=-2` 是三义的 | token 过期 / 配额耗尽 / 文本 > 16 KiB（16384 UTF-8 字节），单看返回码无法区分 |
| 惩罚期内重试会**升级**惩罚 | cc-connect 源码注释；hermes-agent PR：把 `ret=-2` 当速率限制会烧掉重试预算并打开断路器，挡住后续所有发送 |

现行代码把它当速率限制处理，因此：

- `api.ts` 的 `sendMessage` 在 `ret=-2` 后**重试 2 次**（3s→6s）——每次重试都是一次注定失败的请求。
- `send.ts` 的 worker 在熔断后 `sleep(getCircuitRetryDelay())` 再重试——退避时长从 30s 涨到 300s，而配额永远不会回来。
- 实测（2026-10-21 日志）：`ret=-2 prepare failed` → 熔断跳闸 5 次（tripCount 4→8），间隔 5 分钟，`events: 1`，24 分钟零成功。

## 2. 目标

1. 让「一条消息换 10 条回复」这件事**可控**：发到第 10 条时明确告知用户，并给出续接手段。
2. 提供 `/continue`：用户发一条新消息刷新配额后，一键补发积压内容并让 agent 接着干活。
3. 提供 `compact-msg` 模式：长回合不再逐条推送，改为「摘要 + md 附件」，把配额从 O(回复段数) 压到 O(1)。
4. 熔断开路时**不再重复发送**（指数退避代码保留但不再用于调度）。

## 3. 已确认的设计决策

| # | 决策 | 用户选择 |
|---|---|---|
| 1 | `compact-msg` 的默认值与作用域 | **默认 off，按会话级别分别记忆** |
| 2 | 第 10 条发完、配额耗尽时正在跑的 agent | **继续生成，剩余内容暂存，`/continue` 时补发** |
| 3 | compact 模式末尾那次"总结本次对话"的 LLM 调用 | **新开独立 session**（不 `--resume`，不污染对话历史） |
| 4 | compact 模式生成的临时 `.md` | **作为微信附件推送，并保留 7 天**（复用 snippet-store 保留机制） |

---

## 4. 改动清单

| 文件 | 改动 | 新增/修改 |
|---|---|---|
| `src/wechat/outbound-quota.ts` | **新建**。按用户、按回合的出站计数与配额判定 | 新 |
| `src/wechat/split.ts` | **新建**。把 `splitMessage` 从 `send.ts` 提取出来，compact 路径共用 | 新 |
| `src/wechat/api.ts` | `ret:-2` 立即抛出不重试；新增 `resetCircuit()`；保留 `_tripCircuit` 指数退避 | 改 |
| `src/wechat/send.ts` | 队列键改为按用户；配额闸门 + 第 10 条提示；worker 熔断时停机；`enqueuePriority`；`noteInbound` | 改 |
| `src/claude/compact-collector.ts` | **新建**。收集一轮产出、判定直发还是走 md、生成 md 正文 | 新 |
| `src/claude/turn-sink.ts` | **新建**。统一「直发 sink」与「compact sink」，供 `sendToClaude` 与续接路径共用；`summarizeSnippet` 从 main.ts 搬过来 | 新 |
| `src/commands/handlers.ts` | `handleCompactMsg`、`handleContinue`、`handleStop`；信息类回执标记 `priority` | 改 |
| `src/commands/router.ts` | 路由 `compact-msg`、`continue`、`stop`；`CommandResult` 加 `continueSession` / `priority` | 改 |
| `src/session.ts` | `Session.compactMsg?: boolean`；`clear()` 保留它 | 改 |
| `src/config.ts` | `Config.compactMsg?: boolean`——服务级默认值 | 改 |
| `src/main.ts` | 接入 compact 路径、`/continue`、入站重置；`runAutoResumeQuery` → `runSessionContinuation`；删死代码；修 `/stop` 回执 | 改 |
| `src/tests/compact-collector.test.ts` | **新建**。收集、判定、md 正文 | 新 |
| `src/tests/turn-sink.test.ts` | **新建**。两个 sink 的投递形态 | 新 |
| `src/tests/commands.test.ts` | **新建**。`/compact-msg`、`/continue`、`/stop` 的路由与处理器 | 新 |
| `src/tests/outbound-quota.test.ts` | **新建** | 新 |
| `src/tests/split.test.ts` | **新建** | 新 |
| `src/tests/sender-quota.test.ts` | **新建**。sender 的配额闸门、队列合并、停机语义 | 新 |

---

## 5. 详细设计

### 5.1 配额计数与第 10 条提示

**新建 `src/wechat/outbound-quota.ts`**，纯逻辑，可单测：

```ts
export class OutboundQuota {
  constructor(limit = 10)
  usedFor(userId: string): number          // 本回合已发出的条数
  nextSlot(userId: string): number         // 下一条将占用的槽位（1-based）
  exhausted(userId: string): boolean       // 预算是否用尽
  consume(userId: string): void            // 发送成功后记一次
  reset(userId: string): void              // 用户发来新消息时清零
}
```

- 键是 **userId**，不是 contextToken：配额按用户计，与 context_token 无关。
- 计数在**发送成功时**递增（入队时计数会把最终没发出去的消息也算进去）。

**第 10 条的提示**：worker 发送前先 `nextSlot(userId)` 拿到槽位；若 `slot === 10`，在**发送前**给正文追加：

```
⚠️ 本轮微信回复额度已用完（10/10）。剩余内容已暂存，回复 /continue 继续。
```

追加在发送时做（而非入队时），因为只有真正发出去的消息才占配额。文件推送同样占配额，因此 `enqueueFile` 走的 worker 也要过同一个闸门。

### 5.2 熔断行为改造

**`api.ts`**

- `ret=-2` 分支：保留 stale-session 判定（`errmsg === 'unknown error'`），其余情况 `_tripCircuit()` 后**立即抛出**，不再走 `MAX_RETRIES` 循环。理由：配额不会因为等待而回来，重试只会升级惩罚。
- `_tripCircuit()` 及其指数退避（30s→60s→120s→240s→300s cap）**原样保留**——用户明确要求保留代码；它现在只用于决定熔断开多久、以及日志里报告，不再驱动重试调度。
- 新增 `resetCircuit()`：清 `_circuitUntil` / `_rateLimitEvents` / `_circuitTripCount`，并清掉 per-user 的 `nextSendTime` 冷却（保留 2.5s 节奏）。**用户发来新消息时调用**——新消息刷新配额，熔断理应同时闭合。

**`send.ts` worker**

两处停机，都是"不再重复发送"：

1. **主动闸门**（首选）：`quota.exhausted(userId)` 为真时，不再发，把 item 放回队首，worker 退出，队列和磁盘记录都留着。
2. **被动熔断**：捕获到 `circuit breaker` 错误时，同样放回队首并退出 worker，**不再 sleep-and-retry**。

worker 退出前必须 `workers.delete(key)`，否则后续 `enqueue` 不会拉起新 worker，队列就永久卡住。下一条用户消息到来时由 `noteInbound` 重新拉起。

### 5.3 队列按用户合并（消除 contextToken 分裂）

现状 `userKey(toUserId, contextToken)` 把同一用户不同回合的队列拆开。后果有二：

- 每条用户消息换新 contextToken → 新队列 → `/status` 意外插队（不是优先级机制，是分队列的副作用）。
- 上一回合积压的内容留在旧队列里，**新消息根本看不到它们**——`/continue` 要补发就必须先解决这个。

**改法**：`userKey` 只用 `toUserId`。contextToken 降级为**每条队列项自己的字段**，在用户发来新消息时统一刷新为最新的那个（`noteInbound` 遍历队列改写）。这样：

- 每个用户只有一个 worker → 严格串行 → 不会并发烧配额。
- 跨回合积压自然落在同一个队列里 → `/continue` 补发不需要跨队列搬运。
- `/status` 改为显式插队（见下）。

**`/status` 的插队**：改动后 `/status` 会排到积压后面，而积压可能占满 10 条配额 → 状态查询永远发不出去。所以给 sender 加 `enqueuePriority()`（unshift 到队首），信息类回执用它。这保留了今天用户已经依赖的"状态查询立刻回"的行为，但把它变成**显式的优先级**而不是分队列的意外。改回"排在队末"只需换回 `enqueue`。

实现上不是只给 `/status` 一个命令插队，而是给所有**纯信息类**回执（`/help` `/status` `/version` `/skills` `/history` `/show`）统一标 `priority: true`——它们都不改变会话状态，用户问一句就等一句。会改变状态或产生对话内容的命令（`/compact-msg`、`/clear`、`/model` 等）不插队，保持顺序。

`/status` 另外多显示两行：整合消息开关状态、当前待发条数（`sender.pendingCount`）——配额用完时这两行直接说明"为什么没收到回复"。

**遗留**：`src/pending-queue.ts`（legacy store）里 `appendPending` / `clearPending` / `hasPending` **从未被调用**，`flushPending` 因此恒为空操作——真正在用的积压是 `pending-store.ts` + 内存队列。实现时删掉 `flushPending` 调用与 legacy store（保留文件无妨，但调用必须清掉，否则会给人"积压已补发"的错觉）。

### 5.4 `/continue` 指令

**语义**：用户发 `/continue` → 配额被刷新 → 补发积压内容 → 让 agent 接着干活。

**顺序**：

1. `sender.noteInbound(toUserId, contextToken)`：清配额计数 → `api.resetCircuit()` → 刷新队列项的 contextToken → 拉起 worker 冲刷积压。
2. 用 `session.sdkSessionId` 续接会话，prompt = `请继续上次没做完的工作。`（与 `runAutoResumeQuery` 一致）。

**实现路径**：复用 `runAutoResumeQuery`（main.ts:1192-1312），把它抽成 `runSessionContinuation(opts)`，参数化 `trigger: 'auto' | 'manual'` 与 `contextToken`，`/continue` 与 auto-resume 共用。

**为什么不走 `claudePrompt` 通道**：`CommandResult.claudePrompt` → `sendToClaude` 会把这条虚拟用户消息写进 `session.lastUserQuery` 和 `chatHistory`。auto-resume 当初就是刻意避开这点（main.ts:1188-1190 注释：*"we don't want a follow-up consultation to think the user just sent 继续"*）。`/continue` 同理——否则重启咨询会把"请继续上次没做完的工作"当成用户的真实提问。

**并发保护**：`activeControllers` 是 `Map<accountId, AbortController>`，每账号单值。`/continue` 在 `session.state === 'processing'` 时必须**直接拒绝**，否则第二个查询会覆盖掉第一个的 controller，第一个查询从此无法 `/stop`。

**命令处理器**：

```
/compact-msg              查看当前状态（以及这个值来自本会话还是服务默认）
/compact-msg on           为本会话开启
/compact-msg off          为本会话关闭
/compact-msg default on   把服务级默认值改成 on（未被单独指定过的会话继承它）
/compact-msg default off  把服务级默认值改成 off
/continue                 续接
```

`/continue` 在 `session.state === 'processing'` 时直接回一句「当前还有一轮对话在进行中，先用 /stop 停止」——不发起第二次查询（见上面的并发保护）。

### 5.5 `compact-msg` 模式

**存储**：两层。

- `Session.compactMsg?: boolean`（`src/session.ts`）——**按会话记忆**，这是实际生效的值。
- `Config.compactMsg?: boolean`（`src/config.ts`）——**服务级默认值**，供没有单独指定过的会话继承。

判定：`session.compactMsg ?? config.compactMsg ?? false`。默认 off。

`/clear` 保留 `compactMsg`（它是通道属性，不是对话内容）；`/reset` 清掉它，回到继承服务默认。

**主流程**（`sendToClaude` 与 `runAutoResumeQuery` 共用一套 sink）：

```
生成中 ──► 全部文本进 collector（不发任何东西）
                    │
              查询结束 / 被中断
                    │
        blocks = collector.toBlocks()   // 已按 4000 字切分
        elapsed = 查询耗时
                    │
    ┌───────────────┴────────────────┐
 blocks ≤ 4 且 elapsed ≤ 30s      否则
    │                                  │
 按原回复顺序逐条 enqueue        写 md → 调 LLM 总结 → 发「摘要 + 附件」
```

- **"四条"** = 切分后的微信消息条数（`splitMessageByBytes` 的 4000 字 / 16 KiB 双上限），不是 turn 块数。compact 路径和 sender 用**同一个**切分函数，"这算几条消息"对阈值判定和对配额的含义才一致。
- **"30 秒"** = 从 `claudeQuery` 发起��查询返回的总耗时（不含总结那次 LLM 调用）。
- **直发路径**：逐块 `sender.enqueue`，顺序与原回复顺序一致。
- **md 路径**：
  1. 正文 = 头部元信息 + 各块之间用 `---` 分割（"适当使用分割线区分每块消息"），块内保持当前 4000 字分块设定。
  2. `saveSnippet(md)` 落盘到 `~/.wechat-claude-code/snippets/<id>.md`，**保留 7 天**（复用 `cleanupExpiredSnippets` 的启动清扫）。
  3. `claudeQuery` **不带 `resume`** 调一次新会话做总结（决策 #3），输入超 8000 字则截断（沿用 `summarizeSnippet` 的 `SUMMARY_INPUT_LIMIT` 先例）。
  4. 发出两条消息：① 摘要正文 + 附件指针（`编号 <id>`，提示 `/show <id>` 可再取）② md 附件本身（`sender.enqueueFile`）。共 **2 条配额**。
- **tool-noise 过滤在 compact 模式下一律不生效**：compact 模式本来就不往微信灌内容，原始文本进 md 文件不构成刷屏，保留原文比压缩成一行更无损。
- **被 `/stop` 中断时**：不调 LLM 总结（abortController 已 abort，总结查询会一起被杀掉），直接发 md + 一行"⏹ 已中断，以下是已生成的部分"。

### 5.6 auto-resume 在 compact-msg on 下的行为

`runAutoResumeQuery` 已重构为 `runSessionContinuation(opts)`，参数化 `trigger: 'auto' | 'manual'`，auto-resume 与 `/continue` 共用同一份实现。两者走同一个 sink：

- compact on → 续接的产出也进 collector，走「≤4 条且 ≤30s 直发 / 否则 md+摘要」同一套判定。
- compact off → 维持现状（逐条推送）。
- 启动咨询本身产生的 `notify` 消息是独立通知，**不受 compact 影响**（它不是生成内容，是一次性告知）。

---

## 6. 附带修复（与配额直接相关，独立可回滚）

### 6.1 tool-noise 文件推送目前是净亏

命中 tool noise 时的流程是「摘要 1 条 + 文件 1 条 = 2 条配额」。但原文直接发只要 `ceil(N/4000)` 条：

| 原文长度 N | 直发条数 | 文件路由条数 | 盈亏 |
|---|---|---|---|
| ≤ 4000 | 1 | 2 | **亏 1** |
| 4000 < N ≤ 8000 | 2 | 2 | 持平 |
| N > 8000 | ≥3 | 2 | 省 ≥1 |

现有判定用的是 `LENGTH_THRESHOLD = 400`（tool-noise-filter.ts:17），比 4000 字的切分点低一个数量级，**400～8000 字区间全在净亏**。

**改法**：`classifyToolNoise` 保持不变（仍决定"这段是不是工具噪音"），但**是否走文件路由**改判 `splitMessageByBytes(text).length > 1`：

- `> 1` → 摘要 + 文件。
- `≤ 1` → 只发摘要，**不发文件、不发 `/show` 指针**（省 1 条配额，内容由 200 字摘要承载）。

**为什么阈值是 `> 1` 而不是 `> 2`**：在原文正好要 2 条消息时，文件路由是**配额打平**（2 条 vs 2 条），既不亏也不省。但打平的代价是**内容只剩摘要**——原文不再进微信，只留在附件里，用户要多点一次才能看到。换成 `> 1` 的判定后，这个区间会走文件路由：配额一样是 2 条，但完整原文保住了。`> 2` 的判定会让它退回"只发摘要"，配额省了 0 条，内容却丢了。

换句话说，阈值问的不是"文件路由能不能省配额"，而是"文件路由有没有把内容保住的额外好处"。答案是：只要原文本来就要占 2 条及以上，就值得。原文只占 1 条时，文件路由要多花 1 条配额却什么都保不住（摘要已经承载了全部内容），所以只发摘要。

### 6.2 `main.ts:1148` 的 `{saved.charCount}` 不插值

模板字符串写成了单花括号，用户在微信里看到的是字面量 `{saved.charCount}`。顺手修成 `${saved.charCount}`，并去掉 `7  天` 里的多余空格。

### 6.3 死代码

`main.ts` 里的 `splitMessage`（:300）、`parseBlocks`、`findSafeSplitPoint`、`splitByNewline` 和 `MAX_MESSAGE_LENGTH`（:140）已无调用点——实际切分在 `wechat/split.ts`，由 sender 和 compact 路径共用（见 5.5）。一并删除，留一行注释指路。

`src/pending-queue.ts` 这个 legacy store 整体没有调用点了（`appendPending` 从未被调用）。调用点已删，文件本身留着（无人引用，不会被加载）。

### 6.4 `/stop` 的回执发不出去

`/stop` 走 `handlePriorityCommand`，**绕过** `handleMessage`，所以收不到 `noteInbound()` 的配额刷新。用户发 `/stop` 的最常见原因恰恰是"额度用完了"——这时候 `/stop` 的回执 `⏹ 已停止当前对话…` 会被排在一个已经花光的配额后面，永远发不出去。

改法：`/stop` 里先 `clearQueue()`（丢掉积压），再 `noteInbound()`（刷新配额 + 关闭熔断），最后用 `enqueuePriority()` 发回执。顺序不能反：先 `noteInbound` 会把积压放出去几条，再 `clearQueue` 就拦不住了。

---

## 7. 测试计划

**`src/tests/outbound-quota.test.ts`**
- 计数按用户隔离；`consume` 后 `usedFor` 递增；`reset` 清零。
- `nextSlot` 返回 1..10，第 11 条 `exhausted` 为真。
- 边界：连续 10 次 consume 后 exhausted；reset 后恢复。

**`src/tests/compact-collector.test.ts`**
- 收集顺序保持；`toBlocks()` 按 4000 字切分，块序稳定；role 跟着切分走。
- 判定函数：`(blocks=4, elapsed=29.9s) → 直发`；`(blocks=5, elapsed=10s) → md`；`(blocks=2, elapsed=30.1s) → md`；`(blocks=4, elapsed=30s) → 直发`（边界含等号）。
- md 正文：块之间有 `---`，块内容原样保留；被中断时状态行写明。

**`src/tests/turn-sink.test.ts`**
- 直发 sink：emit 时立刻投递（不等回合结束）；没有 emit 过才在 deliver 时补发 finalText；发过一次就不重复发。
- compact sink：回合运行期间一条都不发；deliver 时按原顺序逐块发；超过阈值走「摘要 + 附件」，附件真的落盘且内容完整；被中断时不调总结 LLM。

**`src/tests/commands.test.ts`**
- `routeCommand` 能路由 `/continue`、`/compact-msg on|off|status|default on|off`、`/stop`。
- `handleContinue`：无 `sdkSessionId` → 回复提示；有 → 返回 `continueSession` 信号且不回话（回话要花配额）；`session.state === 'processing'` → 拒绝。
- `handleCompactMsg`：`on`/`off` 写入 session；无参返回当前状态并说明来源；`default on/off` 写服务级配置。

**`src/tests/sender-quota.test.ts`**
- 预算停在第 10 条，第 10 条带提示，其余留在队列。
- `noteInbound` 刷新配额并放行积压；一个用户不花另一个用户的配额。
- 跨回合的消息进同一个队列；积压消息被刷上新的 contextToken。
- 停机类错误（circuit breaker / stale session）不重试；普通错误照常重试。

**`src/tests/split.test.ts`**（如提取 `splitMessage`）
- 4000 字边界；多段落切分点；空串；单段超长硬切；字节上限。

**回归**：`npm run build && npm test` 必须全绿（`npm test` 跑的是 `dist/`，不先 build 会拿旧产物测新代码）。

---

## 8. 风险与已知未解决项

| 风险 | 缓解 |
|---|---|
| 队列键从 `(user, contextToken)` 改成 `user`，是行为变更 | 唯一队列保证单 worker 串行；所有**信息类**指令回执（`/status`、`/help`、`/history`、`/skills`、`/version`、`/show`）改走 `enqueuePriority`，保住"立刻回"的体验；`noteInbound` 刷新 contextToken 避免旧 token 触发 stale-session |
| `ret:-2` 也可能是"文本 > 16 KiB" | **已处理**：`splitMessageByBytes` 同时按字符数（4000）和 UTF-8 字节数（16384）切。中文 3 字节 = 12000 字节，emoji 4 字节 = 16000 字节，都在 16384 以内——但只有按字节切才真正有保证 |
| 配额闸门按 userId 计，但 auto-resume 用 `account.userId` + 空 contextToken | 两者是同一个人的 id，配额本就同一个池；auto-resume 不重置计数（没有用户消息来刷新） |
| 进程在 compact 生成中途被 kill | collector 还没落盘 → 这一轮内容全丢。缓解：collector 每收一块就增量追加写临时 md，崩溃后留下半成品。**首版不做**，先跑通；列为已知缺口 |
| `pending-queue.ts` legacy store | `appendPending` 从未被调用。调用点已替换为 `sender.noteInbound()`，legacy store 的 import 已删——避免"积压已补发"的假象。文件本身留着（无人引用，不会被加载） |
| `/stop` 绕过 `handleMessage`，收不到配额刷新 | **已处理**：见 6.4——`/stop` 里补一次 `noteInbound()`，回执改用 `enqueuePriority` |

**已知未解决（不在本次范围）**

- `restartReason` 仍是 `unknown`：`scripts/watchdog-v2.cjs` 是长驻进程，内存里还是旧的 `spawnChild`，`WCC_RESTART_REASON` 要等 watchdog-v2 自己重启才会生效。任务 #76 的确定性 override（C）在生产环境**尚未验证**。
- 任务 #68（provider.ts session-cleanup + 3221225794 重试）、#27（权限栈审计）、#36/#37/#38 仍然挂起。
