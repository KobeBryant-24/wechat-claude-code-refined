/**
 * Turn sinks — where a finished turn's text goes.
 *
 * A sink has two jobs: accept text as the turn produces it, and deliver
 * whatever it accepted once the turn is over. Two implementations exist:
 *
 *   - `createNormalSink` streams. Each piece goes out as it arrives, which
 *     is what makes an agent loop feel alive.
 *   - `createCompactSink` holds everything until the turn ends and then
 *     sends it as one unit — either the messages themselves, or a summary
 *     plus a file. This is the mode that survives a 10-message budget.
 *
 * The split lives here rather than in the caller so the normal turn path and
 * the auto-resume path cannot drift apart: they used to carry near-identical
 * copies of the same emit/deliver logic.
 */

import { classifyToolNoise, filterToolNoise } from './tool-noise-filter.js';
import { saveSnippet, type SavedSnippet } from './snippet-store.js';
import { claudeQuery } from './provider.js';
import { logger } from '../logger.js';
import { splitMessageByBytes } from '../wechat/split.js';
import {
  CompactCollector,
  buildCompactMarkdown,
  decideCompactDelivery,
  type TurnRole,
} from './compact-collector.js';

export interface SinkOptions {
  sender: {
    enqueue: (toUserId: string, contextToken: string, text: string, role: 'interstitial' | 'final') => void;
    enqueueFile: (toUserId: string, contextToken: string, filePath: string) => void;
  };
  toUserId: string;
  contextToken: string;
  cwd: string;
  model?: string;
  abortController?: AbortController;
  /** Called once per accepted message, before any async work — lets the caller
   *  keep its "did anything get sent" flag accurate without awaiting. */
  onAccepted?: () => void;
}

export interface DeliverContext {
  /** The turn's final text, used when the stream produced nothing at all. */
  finalText?: string;
  /** How long the generation took, in milliseconds. */
  elapsedMs: number;
  /** True when the turn was interrupted before it finished. */
  aborted?: boolean;
}

export interface TurnSink {
  /** Accept a piece of the turn's output. */
  emit(text: string, role: TurnRole): void;
  /** Deliver what was accepted. Called exactly once, after the turn settles. */
  deliver(ctx: DeliverContext): Promise<void>;
}

/** Upper bound on the body handed to the summarizer. Beyond this the summary
 *  gets unreliable and the call gets slow; the full text is in the file anyway. */
const SUMMARY_INPUT_LIMIT = 8000;

/**
 * Summarize a message body that the tool-noise filter flagged.
 *
 * Uses the session's own model, per user preference. Fresh session (no
 * `resume`) so the summarizer can't pollute or be confused by the conversation
 * it's summarizing. If the call fails we still have the file — a missing
 * summary degrades to the filter's original one-line stand-in.
 */
export async function summarizeSnippet(
  text: string,
  opts: { cwd: string; model?: string; abortController?: AbortController },
): Promise<string> {
  const body = text.length > SUMMARY_INPUT_LIMIT
    ? text.slice(0, SUMMARY_INPUT_LIMIT) + '\n…（原文已截断）'
    : text;

  const result = await claudeQuery({
    prompt: [
      '下面这段内容被系统判定为「工具调用噪音」，需要在微信里用很短的篇幅呈现。',
      '请用不超过 200 字的中文概括它的实质：结论、做了什么、关键数据。',
      '不要描述格式，不要复述原话，不要输出 JSON，不要加评价。直接写摘要正文。',
      '',
      '=== 内容开始 ===',
      body,
      '=== 内容结束 ===',
    ].join('\n'),
    cwd: opts.cwd,
    model: opts.model,
    abortController: opts.abortController,
  });

  const summary = result.text?.trim();
  if (result.error || !summary) {
    logger.warn('Snippet summarization failed, falling back to filter tail', {
      error: result.error,
      textLength: text.length,
    });
    return '';
  }
  return summary;
}

/**
 * Summarize a whole turn for the compact delivery path.
 *
 * Fresh session — no `resume` — for the same reason as above, and for one
 * more: the working session is the user's actual conversation, and a
 * "summarize yourself" turn written into it would steer every later
 * /continue down a summarization-shaped path.
 */
async function summarizeCompact(
  text: string,
  opts: { cwd: string; model?: string; abortController?: AbortController },
): Promise<string> {
  const body = text.length > SUMMARY_INPUT_LIMIT
    ? text.slice(0, SUMMARY_INPUT_LIMIT) + '\n…（原文已截断）'
    : text;

  const result = await claudeQuery({
    prompt: [
      '下面是一次微信对话中 AI 的完整回复。回复已经太长，无法直接发到微信。',
      '请用不超过 200 字的中文概括它的实质：做了什么、结论是什么、用户接下来需要知道什么。',
      '不要描述格式，不要复述原话，不要输出 JSON，不要加评价。直接写摘要正文。',
      '',
      '=== 内容开始 ===',
      body,
      '=== 内容结束 ===',
    ].join('\n'),
    cwd: opts.cwd,
    model: opts.model,
    abortController: opts.abortController,
  });

  const summary = result.text?.trim();
  if (result.error || !summary) {
    logger.warn('Compact summarization failed', {
      error: result.error,
      textLength: text.length,
    });
    return '';
  }
  return summary;
}

/**
 * The streaming sink: each piece goes out as it arrives.
 *
 * Delivery is fire-and-forget (`sender.enqueue` hands off to the per-user
 * worker), so `emit` returns immediately. What makes this non-trivial is the
 * tool-noise fallback: on a hit the body is persisted, summarized via an LLM
 * call, and pushed as a file. That awaits, so without serialization two hits
 * could resolve out of order and their summary/file pairs would arrive
 * swapped. `chain` makes each emission start only after the previous one has
 * fully resolved.
 */
export function createNormalSink(opts: SinkOptions): TurnSink {
  let chain: Promise<void> = Promise.resolve();
  let anySent = false;

  const emit = (text: string, role: TurnRole): void => {
    if (!text.trim()) return;
    opts.onAccepted?.();

    // Counted here, not inside the chain: the chain is asynchronous, and
    // `deliver` runs right after `router.drain()`. If the flag were set by
    // the chain step, `deliver` could still see "nothing sent" while a
    // step was in flight, and would send the final text a second time.
    anySent = true;

    chain = chain.then(async () => {
      const verdict = classifyToolNoise(text);
      if (!verdict.hit) {
        opts.sender.enqueue(opts.toUserId, opts.contextToken, text, role);
        return;
      }

      // Hit. The body is tool I/O the user doesn't want in their chat.
      //
      // How it is replaced depends on what the original would have cost.
      // The file route spends two messages of the user's budget — one for
      // the summary, one for the attachment — where the original text would
      // have cost one message per 4000 characters. So:
      //
      //   original fits in one message → summary only. Same cost as
      //     sending the raw text would have been, one message cheaper than
      //     the file route, and the summary carries the substance.
      //   original needs two or more   → summary + file. Equal or cheaper
      //     than sending the raw text, and the full content stays
      //     retrievable.
      //
      // Deciding this on the text's length rather than on a fixed character
      // threshold is the point: a fixed threshold charges the user a message
      // to save them nothing.
      const originalCost = splitMessageByBytes(text).length;
      const summary = await summarizeSnippet(text, {
        cwd: opts.cwd,
        model: opts.model,
        abortController: opts.abortController,
      });

      const header = summary
        ? summary
        : verdict.tail
          ? `🔧 [工具调用] — ${verdict.tail}`
          : '🔧 [工具调用]';

      if (originalCost <= 1) {
        opts.sender.enqueue(opts.toUserId, opts.contextToken, header, role);
        logger.info('Tool-noise hit; sent summary only', {
          originalChars: text.length,
          originalCost,
          summaryChars: summary.length,
          role,
        });
        return;
      }

      // Keep the original, stand in for it.
      let saved: SavedSnippet | undefined;
      try {
        saved = saveSnippet(text);
      } catch (err) {
        logger.error('Snippet save failed; sending filtered fallback', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (!saved) {
        // Couldn't persist, so the file route is gone — the summary alone is
        // the least-bad thing left to send.
        opts.sender.enqueue(
          opts.toUserId, opts.contextToken,
          filterToolNoise(text), role,
        );
        return;
      }

      const body =
        `${header}\n\n` +
        `📎 完整原文（${saved.charCount} 字）见附件\n` +
        `编号 ${saved.id}，7 天内可回复 \`/show ${saved.id}\` 重新获取`;

      opts.sender.enqueue(opts.toUserId, opts.contextToken, body, role);
      // File goes through the same worker queue, so it lands after the text.
      opts.sender.enqueueFile(opts.toUserId, opts.contextToken, saved.path);

      logger.info('Tool-noise hit; sent summary + snippet file', {
        snippetId: saved.id,
        originalChars: saved.charCount,
        originalCost,
        summaryChars: summary.length,
        role,
      });
    }).catch((err) => {
      // A failure here must not wedge the chain — the next emission still
      // needs to run, and the user should still get something.
      logger.error('Emitter chain step failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        opts.sender.enqueue(opts.toUserId, opts.contextToken, text, role);
      } catch { /* give up silently — nothing left to send */ }
    });
  };

  return {
    emit,
    deliver: async (ctx: DeliverContext) => {
      // Nothing was streamed at all (e.g. streaming not supported): push the
      // full text through the worker. The worker splits oversized text into
      // <=4000-char chunks; we just hand off the whole thing.
      if (!anySent && ctx.finalText) {
        opts.sender.enqueue(opts.toUserId, opts.contextToken, ctx.finalText, 'final');
      }
    },
  };
}

/**
 * The compact sink: hold everything, then deliver it as one unit.
 *
 * Nothing is sent while the turn runs. When it ends, the whole output is
 * judged once — a short, quick turn goes out as its own messages; anything
 * longer or slower goes out as a summary plus a file. The second path costs
 * two messages of the user's budget no matter how much was produced.
 */
export function createCompactSink(opts: SinkOptions): TurnSink {
  const collector = new CompactCollector();

  return {
    emit: (text: string, role: TurnRole) => {
      if (!text.trim()) return;
      opts.onAccepted?.();
      collector.add(text, role);
    },

    deliver: async (ctx: DeliverContext) => {
      if (collector.isEmpty && ctx.finalText) {
        collector.add(ctx.finalText, 'final');
      }

      const blocks = collector.toBlocks();
      if (blocks.length === 0) {
        logger.info('Compact turn produced no content', { toUserId: opts.toUserId });
        return;
      }

      const decision = decideCompactDelivery(blocks, ctx.elapsedMs);
      logger.info('Compact delivery decision', {
        toUserId: opts.toUserId,
        mode: decision.mode,
        blocks: blocks.length,
        elapsedMs: ctx.elapsedMs,
      });

      if (decision.mode === 'direct') {
        for (const block of blocks) {
          opts.sender.enqueue(opts.toUserId, opts.contextToken, block.text, block.role);
        }
        return;
      }

      // The file path. Write the turn to disk first — the file is the
      // durable copy, and the summary is a convenience on top of it.
      const aborted = ctx.aborted ?? opts.abortController?.signal.aborted ?? false;
      const markdown = buildCompactMarkdown(blocks, {
        generatedAt: Date.now(),
        elapsedMs: ctx.elapsedMs,
        aborted,
      });

      let saved: SavedSnippet | undefined;
      try {
        saved = saveSnippet(markdown);
      } catch (err) {
        logger.error('Compact file save failed; sending blocks directly', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (!saved) {
        // No file to point at. The blocks still have to reach the user, even
        // if that costs more of their budget than the file route would have.
        for (const block of blocks) {
          opts.sender.enqueue(opts.toUserId, opts.contextToken, block.text, block.role);
        }
        return;
      }

      // An aborted turn gets no summary: the abort controller is already
      // aborted, so a summary call would be killed before it produced
      // anything.
      const summary = aborted
        ? ''
        : await summarizeCompact(markdown, {
            cwd: opts.cwd,
            model: opts.model,
            abortController: opts.abortController,
          });

      const header = summary
        ? summary
        : aborted
          ? '⏹ 已中断，以下是已生成的部分'
          : '📄 本次回复内容较长，已整合为附件';

      const body =
        `${header}\n\n` +
        `📎 完整内容（${saved.charCount} 字）见附件\n` +
        `编号 ${saved.id}，7 天内可回复 \`/show ${saved.id}\` 重新获取`;

      opts.sender.enqueue(opts.toUserId, opts.contextToken, body, 'final');
      // File goes through the same worker queue, so it lands after the text.
      opts.sender.enqueueFile(opts.toUserId, opts.contextToken, saved.path);

      logger.info('Compact turn sent as summary + file', {
        snippetId: saved.id,
        blocks: blocks.length,
        originalChars: saved.charCount,
        summaryChars: summary.length,
        aborted,
      });
    },
  };
}
