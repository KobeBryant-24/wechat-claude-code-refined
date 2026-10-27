# WeChat Claude Code Bridge

<p align="center">
  <strong>Chat with Claude Code in WeChat, just like texting a friend</strong>
</p>

<p align="center">
  <a href="https://github.com/Wechat-ggGitHub/wechat-claude-code/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License: MIT"></a>
  <a href="https://skills.sh/Wechat-ggGitHub/wechat-claude-code"><img src="https://img.shields.io/badge/skills.sh-view_page-blue?style=flat-square" alt="skills.sh"></a>
  <a href="README.md"><img src="https://img.shields.io/badge/Lang-中文-lightgrey?style=flat-square" alt="中文"></a>
</p>

Scan a QR code to bind your WeChat, and a new "friend" appears in your contacts. Send it a message — it gets forwarded to Claude Code running on your computer, and the reply streams back to WeChat in real time. Supports text, images, voice, and files.

---

## Highlights

| | |
|---|---|
| **Scan and go** | No account signup, no server deployment. Scan a QR code and you're done in a minute. All data stays on your machine. |
| **Clean messages** | Only key info gets pushed — progress, results, key decisions. Tool calls and intermediate noise are filtered out automatically. |
| **"Typing..." indicator** | WeChat shows a typing indicator while Claude is working, so you always know it's on it. |
| **Consistent experience** | Mobile and desktop Claude Code behave identically — same orchestration, same output. Not two disconnected AIs. |
| **Two-way files** | Send images, Word docs, PDFs for Claude to analyze. Files Claude generates get pushed directly to WeChat — no need to go back to your computer. |
| **Timeout reassurance** | Task taking longer than 5 minutes? You'll get an automatic message letting you know it's still working. |

---

## Install

Code and skill docs live in two separate places:

| | Where | What |
|---|---|---|
| **Runtime dir** | wherever you cloned the code | source, `dist/` (build output), `node_modules/` (deps), the daemon |
| **Skill dir** | `~/.claude/skills/wechat-claude-code/` | docs only, via a **directory junction** pointing at the runtime dir's `skill/` |

> The Claude global dir can be changed with the `CLAUDE_CONFIG_DIR` env var; it defaults to `~/.claude`.
> The skill dir therefore contains no runnable code, and doc edits take effect immediately.

```bash
# 1. clone the code wherever you want it (e.g. ~/wechat-claude-code)
git clone https://github.com/KobeBryant-24/wechat-claude-code-refined.git ~/wechat-claude-code
cd ~/wechat-claude-code && npm install

# 2. bind WeChat by scanning a QR code
npm run setup

# 3. install the skill into Claude's global dir
npm run skill:install

# 4. register the daemon (auto-start on boot, auto-restart on crash)
npm run daemon -- start        # macOS / Linux — this writes the launchd / systemd config and starts it
npm run daemon:reinstall       # Windows (Administrator Git Bash)
```

Step 3 records the runtime dir in `~/.wechat-claude-code/install.json`, which is how the skill docs know where to run commands.

> Because the code and the docs are split, the `npx skills add` style install (whole repo into the skills dir) does not apply here — that would mix code and docs together.

## Quick Start

### 1. Bind WeChat

```bash
cd <runtime-dir>     # the directory you cloned the code into
npm run setup
```

A QR code will pop up — scan it with WeChat.

### 2. Start the service

```bash
npm run daemon -- start
```

On macOS this registers a launchd agent, on Linux a systemd user unit — auto-start on boot, auto-restart on crash. On Windows, use `npm run daemon:reinstall` (admin rights required).

### 3. Start chatting

Open WeChat and send a message to your new "friend".

### Manage the service

```bash
npm run daemon -- status   # Check if running
npm run daemon -- stop     # Stop the service
npm run daemon -- restart  # Restart (after code updates)
npm run daemon -- logs     # View recent logs
```

---

## WeChat Commands

Send these directly in the WeChat chat:

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/clear` | Clear current session, start fresh |
| `/stop` | Stop current task |
| `/model <name>` | Switch Claude model |
| `/prompt <text>` | Set a system prompt (e.g. "reply in Chinese") |
| `/cwd <path>` | Switch working directory |
| `/skills` | List installed Skills |
| `/status` | View current session state |
| `/history [n]` | View recent chat history |
| `/compact` | Compact context, start a new CLI session |
| `/reset` | Full reset including working directory |
| `/undo [n]` | Remove last N messages from history |
| `/<skill> [args]` | Trigger any installed Skill |

---

## How It Works

```
WeChat (phone) ←→ ilink Bot API ←→ Node.js daemon ←→ Claude Code CLI (local)
```

The daemon long-polls WeChat for new messages, forwards them to the local `claude` CLI, and streams replies back to WeChat. Everything runs on your own machine.

---

## Roadmap

- **Message queue optimization** — Consecutive messages can produce mixed-up replies. Working on a better queuing strategy. Ideas welcome.
- **Prevent sleep** — Use macOS `caffeinate` to keep the system awake, so closing the lid doesn't interrupt the service.
- **Resume desktop session** — Chat on your computer for a while, then continue the same session from WeChat on the go. Same workspace, same context.

---

## Prerequisites

- Node.js >= 18
- macOS / Linux / Windows
- A personal WeChat account
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed and authenticated

> **Note:** Claude Code supports third-party API providers (OpenRouter, AWS Bedrock, etc.) — set `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` accordingly.

## Data Directory

All data is stored in `~/.wechat-claude-code/`, **independent of the runtime dir** (move the code anywhere and your config and accounts come with it):

```
~/.wechat-claude-code/
├── accounts/       # WeChat account credentials
├── config.json     # Global config
├── sessions/       # Session data
├── install.json    # Where the runtime dir / skill dir live (written by npm run skill:install)
└── logs/           # Rotating logs (daily, 30-day retention)
```

## License

[MIT](LICENSE)
