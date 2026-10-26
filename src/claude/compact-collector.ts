/**
 * Compact mode — collect a whole turn, then decide how to deliver it.
 *
 * The problem this solves is the outbound budget. iLink allows a bot 10
 * messages per user message, and a long agent run produces far more than
 * that: the 2026-06-20 trace measured 59 pushes for one tool-using turn.
 * Streaming them out spends the budget on intermediate progress and the
 * final answer never arrives.
 *
 * Compact mode inverts that. Nothing goes out while the turn runs. When it
 * finishes, the whole thing is judged once:
 *
 *   - A short, quick turn (at most 4 messages, under 30 seconds) is sent
 *     directly, in the order it was produced. The user sees it arrive
 *     slightly later than a stream, and gets all of it.
 *   - Anything longer or slower is written to a markdown file, summarized,
 *     and delivered as "summary + attachment" — two messages, regardless of
 *     how much was produced.
 *
 * The threshold is a budget decision, not a formatting one. Four messages
 * cost 4 of the turn's 10; a file costs 2.
 */

import { splitMessageByBytes } from '../wechat/split.js';

export type TurnRole = 'interstitial' | 'final';

export interface CollectedMessage {
  text: string;
  role: TurnRole;
}

/**
 * One deliverable message. A collected message may split into several
 * blocks if it is long — the blocks are what WeChat would receive, and
 * therefore what the budget is counted in.
 */
export interface CompactBlock {
  text: string;
  role: TurnRole;
}

/** Most blocks a turn may contain and still be sent directly. */
export const DIRECT_SEND_MAX_BLOCKS = 4;

/** Longest a turn may take and still be sent directly. */
export const DIRECT_SEND_MAX_MS = 30_000;

/**
 * Collects a turn's output without sending any of it.
 *
 * Order matters: the direct path promises "the original reply order", and
 * the file path promises blocks separated by dividers. Both need the same
 * ordering, so it is preserved here rather than reconstructed later.
 */
export class CompactCollector {
  private readonly messages: CollectedMessage[] = [];

  add(text: string, role: TurnRole): void {
    if (!text.trim()) return;
    this.messages.push({ text, role });
  }

  get isEmpty(): boolean {
    return this.messages.length === 0;
  }

  /** How many messages the turn produced, before splitting. */
  get messageCount(): number {
    return this.messages.length;
  }

  /**
   * The blocks that would be delivered, in order.
   *
   * Split with the same function the sender uses, so "how many messages is
   * this" means the same thing to the threshold check as it does to the
   * budget.
   */
  toBlocks(): CompactBlock[] {
    const blocks: CompactBlock[] = [];
    for (const message of this.messages) {
      for (const text of splitMessageByBytes(message.text)) {
        blocks.push({ text, role: message.role });
      }
    }
    return blocks;
  }

  /** The whole turn as plain text, in order — the input to the summarizer. */
  toPlainText(): string {
    return this.messages.map(m => m.text).join('\n\n');
  }
}

export type CompactDecision =
  | { mode: 'direct'; blocks: CompactBlock[] }
  | { mode: 'file'; blocks: CompactBlock[] };

/**
 * Decide how to deliver a finished turn.
 *
 * Direct when the turn is both short and quick; file otherwise. Both
 * branches are "all of it, in order" — the difference is how many messages
 * it costs the user.
 */
export function decideCompactDelivery(
  blocks: CompactBlock[],
  elapsedMs: number,
  maxBlocks: number = DIRECT_SEND_MAX_BLOCKS,
  maxMs: number = DIRECT_SEND_MAX_MS,
): CompactDecision {
  const mode = blocks.length <= maxBlocks && elapsedMs <= maxMs ? 'direct' : 'file';
  return { mode, blocks };
}

export interface CompactMarkdownMeta {
  /** When the turn finished. */
  generatedAt: number;
  /** How long the generation took. */
  elapsedMs: number;
  /** Whether the turn was interrupted before it finished. */
  aborted: boolean;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const ROLE_LABELS: Record<TurnRole, string> = {
  final: '最终回答',
  interstitial: '过程说明',
};

/**
 * Render the turn as a markdown document.
 *
 * The blocks are separated by a horizontal rule, which is the only thing
 * distinguishing "two messages in one file" from "one long message" — the
 * file is what the user reads when the summary is not enough.
 */
export function buildCompactMarkdown(blocks: CompactBlock[], meta: CompactMarkdownMeta): string {
  const lines: string[] = [
    `# 微信对话记录 · ${formatTime(meta.generatedAt)}`,
    '',
    `- 生成耗时：${Math.round(meta.elapsedMs / 1000)} 秒`,
    `- 消息块数：${blocks.length}`,
    meta.aborted ? '- 状态：⚠️ 被中断，以上为已生成的部分' : '- 状态：完整',
    '',
    '---',
    '',
  ];

  blocks.forEach((block, index) => {
    lines.push(`## 块 ${index + 1} · ${ROLE_LABELS[block.role]}`);
    lines.push('');
    lines.push(block.text);
    lines.push('');
    if (index < blocks.length - 1) {
      lines.push('---');
      lines.push('');
    }
  });

  return lines.join('\n');
}
