/**
 * Outbound quota — how many messages this user can still receive.
 *
 * iLink gives a bot a budget of 10 outbound messages per user message. It is
 * a *quota*, not a rate limit: waiting does not refill it, and only a new
 * message from the user does. That single fact drives this whole module —
 * there is no timer, no refill rate, and no "try again later" semantics.
 * The only thing that changes the count is the user speaking again.
 *
 * Two consequences that shaped the API:
 *
 * 1. The budget is keyed by **user**, not by (user, contextToken). A new
 *    inbound message carries a fresh contextToken, but the budget follows the
 *    person, not the token.
 * 2. Counting happens on **successful send**, not on enqueue. A message that
 *    was queued and then dropped (by `/stop`, or by a crash) never reached
 *    the user and must not be charged against their budget.
 *
 * The counter lives here, apart from the sender, because it is pure logic
 * and the rule that decides "may I send this?" is worth testing on its own.
 */

/** Default budget: 10 outbound messages per inbound user message. */
export const OUTBOUND_QUOTA = 10;

/**
 * Appended to the last message of a turn, when the turn's budget runs out.
 *
 * It rides on the 10th message rather than being sent as an 11th, because an
 * 11th message would be rejected by the server — the hint has to be free.
 */
export const QUOTA_EXHAUSTED_HINT =
  '⚠️ 本轮微信回复额度已用完（10/10）。剩余内容已暂存，回复 /continue 继续。';

export class OutboundQuota {
  private readonly used = new Map<string, number>();

  constructor(private readonly limit: number = OUTBOUND_QUOTA) {}

  /** Messages already sent to this user during the current turn. */
  usedFor(userId: string): number {
    return this.used.get(userId) ?? 0;
  }

  /**
   * The 1-based slot the next send to this user would occupy.
   *
   * Peaks at `limit + 1` once the budget is gone, which is the signal to
   * attach the exhaustion hint to the last message that still fits.
   */
  nextSlot(userId: string): number {
    return this.usedFor(userId) + 1;
  }

  /** True when this turn's budget is spent — no further message may be sent. */
  exhausted(userId: string): boolean {
    return this.usedFor(userId) >= this.limit;
  }

  /** The limit. */
  get budget(): number {
    return this.limit;
  }

  /** Record one successful send. */
  consume(userId: string): void {
    this.used.set(userId, this.usedFor(userId) + 1);
  }

  /**
   * Give the user a fresh budget.
   *
   * Called when a message arrives from them: their message is what refills
   * the quota, so it is also what resets the count.
   */
  reset(userId: string): void {
    this.used.delete(userId);
  }
}

/**
 * Append the exhaustion hint to `text` if this send is the last one the
 * turn's budget allows.
 *
 * Returns the text unchanged for every send but the final one, so the caller
 * can use it unconditionally.
 */
export function withQuotaHint(text: string, slot: number, limit: number = OUTBOUND_QUOTA): string {
  if (slot !== limit) return text;
  return `${text}\n\n${QUOTA_EXHAUSTED_HINT}`;
}
