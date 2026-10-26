/**
 * Bridge-side safety guards for the startup auto-resume decision.
 *
 * The consultation LLM decides from the transcript. These guards add the
 * signals it structurally cannot observe — how long the bridge has been up,
 * whether the service is crash-looping, whether the bridge has been talking to
 * itself — and downgrade `resume: "auto"` to `"ask"` so the user stays in the
 * loop whenever the operational picture says the model's confidence is not
 * warranted.
 *
 * This lives outside main.ts because importing main.ts runs the daemon
 * (module-level `runDaemon()` at the bottom), which is why the guard chain
 * shipped untested for as long as it was defined there.
 */

const DANGEROUS_RESUME_PATTERNS: RegExp[] = [
  // Filesystem destruction
  /\brm\s+(-[a-z]*f[a-z]*\s+)?-[a-z]*r[a-z]*\b/i,        // rm -rf / rm -fr
  /\brmdir\s+\/s/i,                                       // rmdir /s (windows recursive)
  /\bdel\s+\/[a-z]*s[a-z]*\b/i,                           // del /s /q
  /\bformat\s+[a-z]:/i,                                   // format c:
  // Git / package managers going destructive
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  // Force push. The flag token must start with "-" and contain an "f", so
  // `git push myfeature origin` (where "feature" contains an f) does not match
  // and plain `git push origin` is left alone. Requiring at least one flag is
  // also what makes `--force` parse: `-[a-z]*f` alone never matches a
  // double-dash long option.
  /\bgit\s+push\s+(?:-[\w-]*f[\w-]*\s+)+origin\b/i,
  /\bgit\s+branch\s+-D\b/i,
  /\bdrop\s+(database|table|schema)\b/i,
  /\bdropdb\b/i,
  /\btruncate\s+(table|database)\b/i,
  // System / network
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\biptables\s+-F\b/i,
  /\bnet\s+user\s+.*\s+\/delete\b/i,                      // net user ... /delete
  /\bRegDelete\b/i,
  // Generic delete / remove verbs in imperative form
  /^[^a-z]*(delete|remove|destroy|wipe|erase)\s+(all|every|the)/i,
];

const RECENTLY_REAPED_WINDOW_MS = 60_000;
const RECENTLY_QUERIED_WINDOW_MS = 5_000;

/**
 * Auto-resume loop breaker.
 *
 * The failure it exists to stop: auto-resume re-enters the session, the agent
 * redoes whatever it was doing, that work includes a restart, the process dies
 * again, and the next spawn consults again. Nothing in that cycle looks wrong
 * on any single pass — it just never terminates.
 *
 * The counter is per-session and resets on any real user message, so it only
 * trips when the bridge is talking to itself.
 */
const AUTO_RESUME_LOOP_WINDOW_MS = 15 * 60 * 1000;
const AUTO_RESUME_LOOP_LIMIT = 2;

export type ResumeDecision = {
  action: 'silent' | 'notify';
  message?: string;
  resume: 'auto' | 'ask' | 'none';
  /** If the guard downgraded the LLM's choice, this explains why. */
  downgradeReason?: string;
};

export interface LoopState {
  autoResumeCount?: number;
  lastAutoResumeAt?: number;
}

/**
 * Apply bridge-side safety guards to the LLM's consultation decision. If the
 * LLM said `resume: "auto"` but any guard fires, downgrade to `"ask"` so the
 * bridge only enqueues a notify-with-suggestion rather than auto-firing the
 * last query through the SDK. Always returns a fully-resolved decision.
 */
export function applyResumeSafetyGuards(
  llmDecision: { action: 'silent' | 'notify'; message?: string; resume?: 'auto' | 'ask' | 'none' },
  lastUserQuery: string | undefined,
  lastUserQueryAt: number | undefined,
  lastOrphanReapAt: number | undefined,
  now: number = Date.now(),
  loopState?: LoopState,
): ResumeDecision {
  if (llmDecision.action === 'silent') {
    return { action: 'silent', resume: 'none' };
  }

  const requested = llmDecision.resume ?? 'none';

  if (requested !== 'auto') {
    return {
      action: 'notify',
      message: llmDecision.message,
      resume: requested,
    };
  }

  // Guard 0: the loop breaker. Checked before everything else because when it
  // fires, the LLM's own message is describing a cycle it cannot perceive — we
  // replace it rather than trusting its read of the situation.
  if (
    loopState?.autoResumeCount !== undefined &&
    loopState.autoResumeCount >= AUTO_RESUME_LOOP_LIMIT &&
    loopState.lastAutoResumeAt !== undefined &&
    (now - loopState.lastAutoResumeAt) < AUTO_RESUME_LOOP_WINDOW_MS
  ) {
    return {
      action: 'notify',
      message:
        `⏸ 自动续接已连续触发 ${loopState.autoResumeCount} 次且每次都以重启收场，` +
        '判定为循环，已暂停。你回复"继续"我直接接着做，不再自动重试。',
      resume: 'ask',
      downgradeReason: `auto_resume_loop:${loopState.autoResumeCount}x`,
    };
  }

  // Guard 1: dangerous query keywords → downgrade to ask.
  if (lastUserQuery) {
    for (const pat of DANGEROUS_RESUME_PATTERNS) {
      if (pat.test(lastUserQuery)) {
        return {
          action: 'notify',
          message: llmDecision.message,
          resume: 'ask',
          downgradeReason: `dangerous_keyword:${pat.source}`,
        };
      }
    }
  }

  // Guard 2: bridge just reaped an orphan → crash loop window. Refuse auto
  // so we don't pile a Claude call onto an already-unstable service.
  if (lastOrphanReapAt && (now - lastOrphanReapAt) < RECENTLY_REAPED_WINDOW_MS) {
    return {
      action: 'notify',
      message: llmDecision.message,
      resume: 'ask',
      downgradeReason: `recent_orphan_reap:${now - lastOrphanReapAt}ms`,
    };
  }

  // Guard 3: user just sent the query < 5s before the crash → likely still at
  // the keyboard, manually restarted to stop something, or testing. Refuse
  // auto and let the next user message be the natural trigger.
  if (lastUserQueryAt && (now - lastUserQueryAt) < RECENTLY_QUERIED_WINDOW_MS) {
    return {
      action: 'notify',
      message: llmDecision.message,
      resume: 'ask',
      downgradeReason: `recent_user_query:${now - lastUserQueryAt}ms`,
    };
  }

  return {
    action: 'notify',
    message: llmDecision.message,
    resume: 'auto',
  };
}