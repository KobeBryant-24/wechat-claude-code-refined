import { createInterface } from 'node:readline';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

import { WeChatApi } from './wechat/api.js';
import { saveAccount, loadLatestAccount, type AccountData } from './wechat/accounts.js';
import { startQrLogin, waitForQrScan } from './wechat/login.js';
import { createMonitor, type MonitorCallbacks } from './wechat/monitor.js';
import { createSender } from './wechat/send.js';
import { downloadImage, extractText, extractFirstImageUrl, extractFirstFileItem, downloadFile } from './wechat/media.js';
import { createSessionStore, type Session } from './session.js';
import { routeCommand, type CommandContext, type CommandResult } from './commands/router.js';
import { claudeQuery, type QueryOptions } from './claude/provider.js';
import { TurnRouter } from './claude/turn-router.js';
import { cleanupExpiredSnippets } from './claude/snippet-store.js';
import { createNormalSink, createCompactSink, type TurnSink, type SinkOptions } from './claude/turn-sink.js';
import { loadConfig, saveConfig, type Config } from './config.js';
import { logger } from './logger.js';
import { DATA_DIR } from './constants.js';
import { MessageType, type WeixinMessage } from './wechat/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


// Extensions eligible for auto-push when detected in Claude's response
const AUTO_PUSH_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico',
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.rtf',
  '.txt', '.md',
  '.csv', '.xlsx', '.xls',
  '.mp3', '.wav', '.m4a', '.mp4', '.mov',
]);

/** Extract local file paths from Claude's response text. */
function extractFilePathsFromText(text: string, cwd: string): string[] {
  const paths: string[] = [];
  // Match absolute paths (macOS/Linux), tilde paths, and Windows paths with a file extension
  const regex = /(?:\/(?:Users|home|tmp|var|etc)\/[^\s`'"()\[\]{}|<>]+\.\w+|~\/[^\s`'"()\[\]{}|<>]+\.\w+|[A-Za-z]:[\\\/][^\s`'"()\[\]{}|<>]+\.\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[0];
    const resolved = raw.startsWith('~')
      ? raw.replace(/^~/, homedir())
      : raw;
    paths.push(resolved);
  }
  return paths;
}

/**
 * Message splitting lives in `wechat/split.ts`.
 *
 * The copy that used to live here split on paragraph boundaries only. That
 * was not enough: iLink's limit is on *bytes*, and 4000 characters of
 * Chinese or emoji crosses it — a chunk that does is rejected with the same
 * `ret:-2` an exhausted quota produces, so the two are indistinguishable at
 * the send site. The shared splitter cuts on both characters and bytes, and
 * the compact path uses the same one so "how many messages is this" means
 * the same thing to the threshold check as it does to the budget.
 */

function promptUser(question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const display = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(display, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

/** Open a file using the platform's default application (secure: uses spawnSync) */
function openFile(filePath: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];

  if (platform === 'darwin') {
    cmd = 'open';
    args = [filePath];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', filePath];
  } else {
    // Linux: try xdg-open
    cmd = 'xdg-open';
    args = [filePath];
  }

  const result = spawnSync(cmd, args, { stdio: 'ignore' });
  if (result.error) {
    logger.warn('Failed to open file', { cmd, filePath, error: result.error.message });
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function runSetup(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  const QR_PATH = join(DATA_DIR, 'qrcode.png');

  console.log('正在设置...\n');

  // Loop: generate QR → display → poll for scan → handle expiry → repeat
  while (true) {
    const { qrcodeUrl, qrcodeId } = await startQrLogin();

    const isHeadlessLinux = process.platform === 'linux' &&
      !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

    if (isHeadlessLinux) {
      // Headless Linux: display QR in terminal using qrcode-terminal
      try {
        const qrcodeTerminal = await import('qrcode-terminal');
        console.log('请用微信扫描下方二维码：\n');
        qrcodeTerminal.default.generate(qrcodeUrl, { small: true });
        console.log();
        console.log('二维码链接：', qrcodeUrl);
        console.log();
      } catch {
        logger.warn('qrcode-terminal not available, falling back to URL');
        console.log('无法在终端显示二维码，请访问链接：');
        console.log(qrcodeUrl);
        console.log();
      }
    } else {
      // macOS / Windows / GUI Linux: generate QR PNG and open with system viewer
      const QRCode = await import('qrcode');
      const pngData = await QRCode.toBuffer(qrcodeUrl, { type: 'png', width: 400, margin: 2 });
      writeFileSync(QR_PATH, pngData);

      openFile(QR_PATH);
      console.log('已打开二维码图片，请用微信扫描：');
      console.log(`图片路径: ${QR_PATH}\n`);
    }

    console.log('等待扫码绑定...');

    try {
      await waitForQrScan(qrcodeId);
      console.log('✅ 绑定成功!');
      break;
    } catch (err: any) {
      if (err.message?.includes('expired')) {
        console.log('⚠️ 二维码已过期，正在刷新...\n');
        continue;
      }
      throw err;
    }
  }

  // Clean up QR image
  try { unlinkSync(QR_PATH); } catch {
    logger.warn('Failed to clean up QR image', { path: QR_PATH });
  }

  const workingDir = await promptUser('请输入工作目录', join(homedir(), 'Documents', 'ClaudeCode'));
  const config = loadConfig();
  config.workingDirectory = workingDir;
  saveConfig(config);

  console.log('运行 npm run daemon -- start 启动服务');
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

async function runDaemon(): Promise<void> {
  const config = loadConfig();
  const account = loadLatestAccount();

  if (!account) {
    console.error('未找到账号，请先运行 node dist/main.js setup');
    process.exit(1);
  }

  const api = new WeChatApi(account.botToken, account.baseUrl);
  const sessionStore = createSessionStore();
  const session: Session = sessionStore.load(account.accountId);
  const sender = createSender(api, account.accountId);
  // Restore any chunks/files that were persisted to disk by a previous
  // daemon run. Each restored record is re-pushed onto the per-user queue
  // with its original uuid — iLink's clientId dedup keeps the user from
  // seeing duplicates when a chunk was already delivered but the delete
  // didn't reach disk before the crash.
  const restoredCount = sender.restorePending();
  if (restoredCount > 0) {
    logger.info('Restored pending messages on startup', { count: restoredCount });
  }

  // Fix: backfill session workingDirectory from config if it's still the default process.cwd()
  if (config.workingDirectory && session.workingDirectory === process.cwd()) {
    session.workingDirectory = config.workingDirectory;
    sessionStore.save(account.accountId, session);
  }

  // Fix: reset stale non-idle state on startup (e.g. after crash)
  if (session.state !== 'idle') {
    logger.warn('Resetting stale session state on startup', { state: session.state });
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
  }

  const sharedCtx = { lastContextToken: '' };
  const activeControllers = new Map<string, AbortController>();

  // -- Message queue for serial processing --
  const messageQueue: WeixinMessage[] = [];
  let processingQueue = false;

  async function drainQueue(): Promise<void> {
    if (processingQueue) return;
    processingQueue = true;
    logger.info('drainQueue starting', { queueLength: messageQueue.length });
    while (messageQueue.length > 0) {
      const msg = messageQueue.shift()!;
      await handleMessage(msg, account!, session, sessionStore, sender, config, sharedCtx, activeControllers, messageQueue);
    }
    processingQueue = false;
  }

  // -- Wire the monitor callbacks --

  /** Handle priority commands (/stop, /clear) immediately, bypassing the serial queue. */
  function handlePriorityCommand(msg: WeixinMessage): boolean {
    if (msg.message_type !== MessageType.USER || !msg.item_list) return false;
    const text = extractTextFromItems(msg.item_list);
    if (!text.startsWith('/stop') && !text.startsWith('/clear')) return false;
    if (session.state !== 'processing') return false;

    const ctrl = activeControllers.get(account!.accountId);
    if (ctrl) { ctrl.abort(); activeControllers.delete(account!.accountId); }
    session.state = 'idle';
    sessionStore.save(account!.accountId, session);

    if (text.startsWith('/stop')) {
      const toUserId = msg.from_user_id!;
      const contextToken = msg.context_token ?? '';
      // Drop the backlog first, then let the user's message refill the
      // budget. The order matters: /stop is most often sent *because* the
      // budget ran out, so without the refill the acknowledgement below
      // would be queued behind a spent budget and never arrive.
      sender.clearQueue(toUserId, contextToken);  // drop unsent chunks
      sender.stopTyping(toUserId, contextToken);  // cancel typing keepalive
      messageQueue.length = 0;
      sender.noteInbound(toUserId, contextToken);
      // Fire-and-forget acknowledgement — queued for delivery by worker.
      sender.enqueuePriority(toUserId, contextToken, '⏹ 已停止当前对话，排队中的消息已清空。', 'final');
    }
    return true;
  }

  const callbacks: MonitorCallbacks = {
    onMessage: async (msg: WeixinMessage) => {
      if (handlePriorityCommand(msg)) return;
      messageQueue.push(msg);
      drainQueue();
    },
    onSessionExpired: () => {
      logger.warn('Session expired, will keep retrying...');
      console.error('⚠️ 微信会话已过期，请重新运行 setup 扫码绑定');
    },
  };

  const monitor = createMonitor(api, callbacks);

  // -- Graceful shutdown --

  function shutdown(): void {
    logger.info('Shutting down...');
    monitor.stop();
    process.exit(0);
  }

  // Sweep snippets past their 7-day retention. Best-effort: a stale directory
  // must never keep the daemon from starting.
  try {
    const swept = cleanupExpiredSnippets();
    if (swept > 0) {
      logger.info('Snippet cleanup: removed expired snippets', { removed: swept });
    }
  } catch (err) {
    logger.warn('Snippet cleanup failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('Daemon started', { accountId: account.accountId });
  console.log(`已启动 (账号: ${account.accountId})`);

  await monitor.run();
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

async function handleMessage(
  msg: WeixinMessage,
  account: AccountData,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  sharedCtx: { lastContextToken: string },
  activeControllers: Map<string, AbortController>,
  messageQueue: WeixinMessage[],
): Promise<void> {
  // Filter: only user messages with required fields
  if (msg.message_type !== MessageType.USER) return;
  if (!msg.from_user_id || !msg.item_list) return;
  if (account.userId && msg.from_user_id !== account.userId) return;

  const contextToken = msg.context_token ?? '';
  const fromUserId = msg.from_user_id;
  sharedCtx.lastContextToken = contextToken;

  // A message from the user refills their outbound budget: the counter
  // restarts, the circuit breaker closes, and the previous turn's backlog
  // becomes sendable again. This is also what makes /continue work — the
  // stashed messages go out as soon as the user writes again.
  flushPending(fromUserId, contextToken, sender);

  // Extract text from items
  const userText = extractTextFromItems(msg.item_list);
  const imageItem = extractFirstImageUrl(msg.item_list);
  const fileItem = extractFirstFileItem(msg.item_list);

  // Drop non-command messages while processing (priority commands already handled upstream)
  if (session.state === 'processing' && !userText.startsWith('/')) {
    logger.warn('handleMessage dropped: session still processing', {
      message_id: msg.message_id,
      userText: userText.slice(0, 80),
      hint: 'previous sendToClaude may have crashed mid-turn — see finally block',
    });
    return;
  }

  // -- Command routing --

  if (userText.startsWith('/')) {
    const updateSession = (partial: Partial<Session>) => {
      Object.assign(session, partial);
      sessionStore.save(account.accountId, session);
    };

    const ctx: CommandContext = {
      accountId: account.accountId,
      session,
      updateSession,
      // Pass the current session so the settings that belong to the channel
      // rather than to the conversation — the delivery preference — survive
      // a /clear.
      clearSession: () => sessionStore.clear(account.accountId, session),
      getChatHistoryText: (limit?: number) => sessionStore.getChatHistoryText(session, limit),
      getPendingCount: () => sender.pendingCount(fromUserId),
      text: userText,
    };

    const result: CommandResult = routeCommand(ctx);

    if (result.handled && result.reply) {
      sessionStore.addChatMessage(session, 'assistant', result.reply);
      sessionStore.save(account.accountId, session);
      // A priority reply jumps the backlog: the user asked a question and is
      // waiting for the answer, not for the tail of the previous turn.
      if (result.priority) {
        sender.enqueuePriority(fromUserId, contextToken, result.reply, 'final');
      } else {
        sender.enqueue(fromUserId, contextToken, result.reply, 'final');
      }
      return;
    }

    if (result.handled && result.claudePrompt) {
      await sendToClaude(
        result.claudePrompt, imageItem, fileItem, fromUserId, contextToken,
        account, session, sessionStore, sender, config, activeControllers,
      );
      return;
    }

    if (result.handled && result.continueSession) {
      // /continue. The user's message already refilled the budget and
      // released the previous turn's backlog (see flushPending above); this
      // asks the assistant to carry on with the work it was doing.
      await runSessionContinuation({
        account, session, sessionStore, sender, config, activeControllers,
        trigger: 'manual',
        contextToken,
      });
      return;
    }

    if (result.handled && result.sendFile) {
      sender.enqueueFile(fromUserId, contextToken, result.sendFile);
      return;
    }

    if (result.handled) return;

    // Not handled, treat as normal message (fall through)
  }

  // -- Normal message -> Claude --

  if (!userText && !imageItem && !fileItem) {
    sender.enqueue(fromUserId, contextToken, '暂不支持此类型消息，请发送文字、语音、图片或文件', 'final');
    return;
  }

  await sendToClaude(
    userText, imageItem, fileItem, fromUserId, contextToken,
    account, session, sessionStore, sender, config, activeControllers,
  );
}

function extractTextFromItems(items: NonNullable<WeixinMessage['item_list']>): string {
  return items.map((item) => extractText(item)).filter(Boolean).join('\n');
}

/**
 * React to a new user message from this user.
 *
 * The message refills the user's outbound budget, so the counter restarts,
 * the circuit breaker closes, and whatever is still queued from the previous
 * turn becomes sendable again. Queued messages are re-stamped with the new
 * context token on the way — the one they carry may have gone stale while
 * they waited, and a stale token is rejected by the server in exactly the
 * same way an exhausted quota is.
 *
 * This used to drain `pending-queue.ts`, a disk file that nothing ever
 * wrote to (`appendPending` had no callers), so the file was always empty
 * and the "pending flushed on next user message" comment described a
 * mechanism that did not exist. The real backlog is the sender's in-memory
 * per-user queue plus the durable per-chunk records in `pending-store.ts`.
 */
function flushPending(
  toUserId: string,
  contextToken: string,
  sender: ReturnType<typeof createSender>,
): void {
  sender.noteInbound(toUserId, contextToken);
}

// ---------------------------------------------------------------------------
// Message emission
// ---------------------------------------------------------------------------
//
// The emission logic lives in `claude/turn-sink.ts` now. It used to sit
// here, duplicated between the normal turn path and the auto-resume path —
// two near-identical copies of the same emit/deliver behaviour, free to
// drift apart. The sinks keep one copy and make the choice between
// "stream it" and "collect it, then deliver as one unit" explicit.
//
//   createNormalSink  — each piece goes out as it arrives
//   createCompactSink — hold everything, then send it as one unit
//
/**
 * Pick the sink a turn should use.
 *
 * The normal sink streams each piece out as it arrives — that is what makes
 * an agent loop feel alive. The compact sink holds everything until the turn
 * ends and then delivers it as one unit: either the messages themselves, or
 * a summary plus a file. That is the mode that survives a 10-message
 * outbound budget, because it costs 2 messages instead of however many the
 * turn happened to produce.
 *
 * The choice is per session, and it is remembered per session: `/compact-msg
 * on` turns it on for the conversation you are in now, and it stays on for
 * that conversation.
 */
function createTurnSink(opts: SinkOptions & { compact: boolean }): TurnSink {
  return opts.compact ? createCompactSink(opts) : createNormalSink(opts);
}

/**
 * Whether this session delivers its replies through the compact sink.
 *
 * The setting is remembered per session — `/compact-msg on` turns it on for
 * the conversation you are in, and it stays on for that conversation. A
 * session that has never been told either way inherits the service-level
 * default, so the whole service can be switched over without rewriting
 * every session file. The default is off.
 */
function isCompactEnabled(session: Session, config: Config): boolean {
  return session.compactMsg ?? config.compactMsg ?? false;
}

// ---------------------------------------------------------------------------
// Session continuation
// ---------------------------------------------------------------------------

/**
 * Who asked for the continuation.
 *
 * `auto` — the startup consultation decided the previous turn was cut off
 *   and the user wanted it finished. Nobody is waiting for a reply.
 * `manual` — the user sent `/continue`, usually because the outbound budget
 *   ran out mid-answer and the tail of the reply is still queued.
 */
type ContinuationTrigger = 'auto' | 'manual';

interface ContinuationOptions {
  account: AccountData;
  session: Session;
  sessionStore: ReturnType<typeof createSessionStore>;
  sender: ReturnType<typeof createSender>;
  config: ReturnType<typeof loadConfig>;
  activeControllers: Map<string, AbortController>;
  trigger: ContinuationTrigger;
  /**
   * The context token to reply under.
   *
   * The startup path has no inbound message to borrow one from, so it
   * replies with an empty token. The manual path passes the token the
   * user's `/continue` arrived with.
   */
  contextToken?: string;
}

/**
 * Fire an SDK query that resumes the existing `sdkSessionId` and asks the
 * assistant to continue whatever was interrupted.
 *
 * Two callers:
 *
 *   - the startup consultation, when the LLM (after passing the safety
 *     guards) decides the previous turn was cut off mid-tool and the user
 *     clearly wanted it completed;
 *   - `/continue`, when the user asks for the rest of an answer the
 *     outbound budget cut short.
 *
 * The result is delivered through the same per-user worker queue as a normal
 * user reply, so the outbound budget, pacing, and chunk-splitting are
 * honored identically — and so is compact mode: the continuation goes
 * through whichever sink the session is configured for, which is what keeps
 * auto-resume working when compact-msg is on.
 *
 * No userText/imageItem/fileItem is involved — this is a synthetic follow-up
 * message ("请继续上次没做完的工作。") injected into the existing session. The
 * session's `lastUserQuery` is preserved untouched: it records what the user
 * actually asked, and a continuation is not an answer to anything.
 */
async function runSessionContinuation(opts: ContinuationOptions): Promise<void> {
  const { account, session, sessionStore, sender, config, activeControllers, trigger } = opts;
  const contextToken = opts.contextToken ?? '';
  const label = trigger === 'auto' ? 'Auto-resume' : 'Continue';

  if (!session.sdkSessionId) {
    logger.warn(`${label}: no sdkSessionId, skipping fire`, {
      accountId: account.accountId,
    });
    if (trigger === 'manual') {
      sender.enqueue(account.userId, contextToken, '⚠️ 当前没有可续接的会话，先发一条消息开始新会话。', 'final');
    }
    return;
  }

  // Mark processing so any user message that arrives during the resume
  // gets routed through the normal abort path (line 558: a new message
  // aborts the active controller before being processed itself).
  session.state = 'processing';
  sessionStore.save(account.accountId, session);

  const abortController = new AbortController();
  activeControllers.set(account.accountId, abortController);

  const stopTyping = sender.startTyping(account.userId, contextToken);

  try {
    let anySent = false;
    const sink = createTurnSink({
      sender,
      toUserId: account.userId,
      contextToken,
      cwd: (session.workingDirectory || config.workingDirectory).replace(/^~/, homedir()),
      model: session.model,
      abortController,
      compact: isCompactEnabled(session, config),
      onAccepted: () => { anySent = true; },
    });
    const router = new TurnRouter((msg) => sink.emit(msg.text, msg.role));

    const queryOptions: QueryOptions = {
      // Synthetic prompt. The SDK will append this to the existing JSONL
      // (because we pass `resume`) and the assistant sees its own previous
      // (incomplete) turn + this new "continue" message, which is the
      // standard continuation pattern.
      prompt: '请继续上次没做完的工作。',
      cwd: (session.workingDirectory || config.workingDirectory).replace(/^~/, homedir()),
      resume: session.sdkSessionId,
      model: session.model,
      systemPrompt: [
        '你正在通过微信与用户对话，不是在终端里。不要让用户去终端操作。如果用户需要文件，直接输出文件地址就行，会自动识别解析推送文件到用户的微信中。',
        config.systemPrompt,
      ].filter(Boolean).join('\n'),
      abortController,
      onText: (delta: string) => router.onText(delta),
      onTurnEnd: (stopReason: string) => router.onTurnEnd(stopReason),
    };

    logger.info(`${label}: firing SDK query`, {
      sessionId: session.sdkSessionId,
      cwd: queryOptions.cwd,
    });

    const startedAt = Date.now();
    let result = await claudeQuery(queryOptions);

    if (result.error && queryOptions.resume) {
      logger.warn(`${label}: resume failed, retrying without resume`, {
        error: result.error,
        sessionId: queryOptions.resume,
      });
      queryOptions.resume = undefined;
      session.sdkSessionId = undefined;
      sessionStore.save(account.accountId, session);
      const retryResult = await claudeQuery(queryOptions);
      Object.assign(result, retryResult);
    }
    const elapsedMs = Date.now() - startedAt;

    router.drain();

    if (result.text) {
      if (result.error) {
        logger.warn(`${label}: Claude query had error but returned text, using text`, {
          error: result.error,
        });
      }
      sessionStore.addChatMessage(session, 'assistant', result.text);
    }

    // The sink owns delivery: it knows whether anything was streamed, and
    // whether the turn has to be compacted instead of sent as-is.
    await sink.deliver({
      finalText: result.text,
      elapsedMs,
      aborted: abortController.signal.aborted,
    });

    if (!result.text) {
      if (result.error) {
        logger.error(`${label}: Claude query error`, { error: result.error });
        sender.enqueue(
          account.userId, contextToken,
          trigger === 'auto' ? '（自动续接失败，可回复"继续"再试一次）' : '（续接失败，可稍后重试）',
          'final',
        );
      } else if (!anySent) {
        sender.enqueue(
          account.userId, contextToken,
          trigger === 'auto' ? '（自动续接完成，没有新内容）' : '（续接完成，没有新内容）',
          'final',
        );
      }
    }

    // Update SDK session id in case it rotated (e.g. retry without resume).
    session.sdkSessionId = result.sessionId || undefined;
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
  } catch (err) {
    const isAbort = err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort'));
    if (isAbort) {
      logger.info(`${label}: aborted by new message`);
    } else {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`${label}: error`, { error: errorMsg });
      sender.enqueue(
        account.userId, contextToken,
        trigger === 'auto' ? '（自动续接出错，可回复"继续"手动续）' : '（续接出错，可稍后重试）',
        'final',
      );
    }
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
  } finally {
    stopTyping();
    if (session.state !== 'idle') {
      session.state = 'idle';
      sessionStore.save(account.accountId, session);
    }
    if (activeControllers.get(account.accountId) === abortController) {
      activeControllers.delete(account.accountId);
    }
  }
}


async function sendToClaude(
  userText: string,
  imageItem: ReturnType<typeof extractFirstImageUrl>,
  fileItem: ReturnType<typeof extractFirstFileItem>,
  fromUserId: string,
  contextToken: string,
  account: AccountData,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  activeControllers: Map<string, AbortController>,
): Promise<void> {
  // Set state to processing
  session.state = 'processing';
  sessionStore.save(account.accountId, session);

  // Create abort controller for this query so it can be cancelled by new messages
  const abortController = new AbortController();
  activeControllers.set(account.accountId, abortController);

  // Flush timer for streaming text to WeChat during query (declared here for finally cleanup)

  // Record user message in chat history
  sessionStore.addChatMessage(session, 'user', userText || '(图片)');

  // Start typing indicator (keepalive until stopTyping is called)
  const stopTyping = sender.startTyping(fromUserId, contextToken);

  try {
    // Download image if present
    let images: QueryOptions['images'];
    if (imageItem) {
      const base64DataUri = await downloadImage(imageItem);
      if (base64DataUri) {
        const matches = base64DataUri.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          images = [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: matches[1],
                data: matches[2],
              },
            },
          ];
        }
      }
    }

    // Download file if present
    let prompt = userText || '请分析这张图片';
    if (fileItem) {
      const filePath = await downloadFile(fileItem);
      if (filePath) {
        const fileName = fileItem.file_item?.file_name || basename(filePath);
        prompt = userText
          ? `${userText}\n\n用户发送了文件: ${fileName}\n文件已保存到: ${filePath}\n请先读取这个文件再回答。`
          : `用户发送了文件: ${fileName}\n文件已保存到: ${filePath}\n请读取这个文件并总结其内容。`;
      }
    }

    let anySent = false;

    // Replies flow through a sink. The normal sink streams each piece as it
    // arrives; the compact sink holds everything until the turn ends and
    // then delivers it as one unit — the messages themselves, or a summary
    // plus a file. The worker underneath owns send cadence, the outbound
    // budget, and chunk-level retry either way.
    //
    // The normal sink also carries the tool-noise fallback: when the filter
    // flags a body as provider tool I/O, the original is written to the
    // snippet store, summarized, and pushed as a file instead of being
    // collapsed to one lossy line.
    const sink = createTurnSink({
      sender,
      toUserId: fromUserId,
      contextToken,
      cwd: (session.workingDirectory || config.workingDirectory).replace(/^~/, homedir()),
      model: session.model,
      abortController,
      compact: isCompactEnabled(session, config),
      onAccepted: () => { anySent = true; },
    });

    const router = new TurnRouter((msg) => sink.emit(msg.text, msg.role));

    const queryOptions: QueryOptions = {
      prompt,
      cwd: (session.workingDirectory || config.workingDirectory).replace(/^~/, homedir()),
      resume: session.sdkSessionId,
      model: session.model,
      systemPrompt: [
        '你正在通过微信与用户对话，不是在终端里。不要让用户去终端操作。如果用户需要文件，直接输出文件地址就行，会自动识别解析推送文件到用户的微信中。',
        config.systemPrompt,
      ].filter(Boolean).join('\n'),
      abortController,
      images,
      onText: (delta: string) => {
        router.onText(delta);
      },
      onTurnEnd: (stopReason: string) => {
        router.onTurnEnd(stopReason);
      },
    };


    // Measured across the query (and its resume-failed retry), because the
    // compact path asks "was this turn short *and* quick?" — a turn that
    // took 40 seconds to produce four messages is worth compacting even
    // though four messages would fit in the budget.
    const startedAt = Date.now();
    let result = await claudeQuery(queryOptions);

    // If resume failed (e.g. corrupted session), retry without resume
    if (result.error && queryOptions.resume) {
      logger.warn('Resume failed, retrying without resume', { error: result.error, sessionId: queryOptions.resume });
      queryOptions.resume = undefined;
      session.sdkSessionId = undefined;
      sessionStore.save(account.accountId, session);
      const retryResult = await claudeQuery(queryOptions);
      Object.assign(result, retryResult);
    }
    const elapsedMs = Date.now() - startedAt;

    // Stop periodic flush, drain router (final 先于 interstitial). Per-user
    // worker in sender keeps running until the queue drains — no need to
    // await here because the next emission (or user message) will land in
    // the same per-user queue, preserving order.
    router.drain();

    // Send result back to WeChat
    if (result.text) {
      if (result.error) {
        logger.warn('Claude query had error but returned text, using text', { error: result.error });
      }
      sessionStore.addChatMessage(session, 'assistant', result.text);
    }

    // The sink owns delivery. It knows whether anything was streamed, and
    // whether the turn has to be compacted instead of sent as-is:
    //   - normal sink: nothing streamed → send the full text
    //   - compact sink: short and quick → send the blocks in order
    //                   long or slow   → write a file, summarize, attach
    await sink.deliver({
      finalText: result.text,
      elapsedMs,
      aborted: abortController.signal.aborted,
    });

    if (!result.text) {
      if (result.error) {
        logger.error('Claude query error', { error: result.error });
        sender.enqueue(fromUserId, contextToken, 'Claude 处理请求时出错，请稍后重试。', 'final');
      } else if (!anySent) {
        sender.enqueue(fromUserId, contextToken, 'Claude 无返回内容（可能因权限被拒而终止）', 'final');
      }
    }

    // Update session with new SDK session ID
    session.sdkSessionId = result.sessionId || undefined;
    session.state = 'idle';
    sessionStore.save(account.accountId, session);


    // Auto-push deliverable files mentioned in Claude's response. Each file goes
  // through the per-user worker queue so circuit-breaker and pacing are honored
  // without any caller-side coordination. The old 15s exponential retry block
  // is gone — the worker handles retriable failures itself.
  if (result.text) {
    const cwd = (session.workingDirectory || config.workingDirectory).replace(/^~/, homedir());
    const detectedPaths = extractFilePathsFromText(result.text, cwd);
    const { existsSync } = await import('node:fs');
    const { extname } = await import('node:path');
    const pushable = detectedPaths.filter(f => {
      const ext = extname(f).toLowerCase();
      return AUTO_PUSH_EXTENSIONS.has(ext) && existsSync(f);
    });
    for (const filePath of pushable) {
      sender.enqueueFile(fromUserId, contextToken, filePath);
    }
  }
  } catch (err) {
    const isAbort = err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort'));
    if (isAbort) {
      // Query was cancelled by a new incoming message — exit silently
      logger.info('Claude query aborted by new message');
    } else {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Error in sendToClaude', { error: errorMsg });
      sender.enqueue(fromUserId, contextToken, '处理消息时出错，请稍后重试。', 'final');
    }
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
  } finally {
    stopTyping();
    // Clean up the abort controller if it's still ours
    if (activeControllers.get(account.accountId) === abortController) {
      activeControllers.delete(account.accountId);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const command = process.argv[2];

if (command === 'setup') {
  runSetup().catch((err) => {
    logger.error('Setup failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('设置失败:', err);
    process.exit(1);
  });
} else {
  // 'start' or no argument
  runDaemon().catch((err) => {
    logger.error('Daemon start failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('启动失败:', err);
    process.exit(1);
  });
}
