#!/usr/bin/env node
// wechat-claude-code watchdog
//
// Polls the main wechat-claudecodebridge.exe service every N seconds and
// re-starts it via `sc.exe start` whenever it is not RUNNING. Registered as
// its own Windows Service so it runs under SCM with the same lifetime
// guarantees as the main service — but with maxRetries set high enough that
// the wrapper itself never gives up.
//
// Why this exists: node-windows wrapper treats `sc stop` as a "full shutdown"
// signal — its `child.on('exit')` handler exits the wrapper when
// `forcekill` is true. There is no SCM Recovery for planned stops, and the
// wrapper's own restart counter is bypassed. So after every `sc stop` (which
// is what `npm run redeploy` and `npm run daemon -- stop` both invoke), the
// service stays STOPPED until something external kicks it. This watchdog is
// that something.

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TARGET_SERVICE = 'WeChatClaudeCodeBridge';
// node-windows 1.0.0-beta.8 registers the SCM service under the `name`
// field (NOT `id`), so the SCM registry key is `WeChatClaudeCodeBridge` —
// verified via Get-CimInstance Win32_Service. The earlier assumption that
// `id` (`wechatclaudecodebridge.exe`) is the SCM key was wrong; using it
// caused `sc query` to return 1060 and the watchdog to exit in a loop.
const SCM_NAME = 'WeChatClaudeCodeBridge';
const POLL_INTERVAL_MS = 5000;
const LOG_DIR = path.join(os.homedir(), '.wechat-claude-code', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'watchdog.log');

function log(level, msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const ts = new Date(Date.now() + 8 * 60 * 60 * 1000)
      .toISOString()
      .replace('Z', '+08:00');
    fs.appendFileSync(LOG_FILE, `${ts} ${level} ${msg}\n`, 'utf8');
  } catch {
    // logging failures must not crash the watchdog
  }
}

function queryState() {
  try {
    const out = execSync(`sc.exe query "${SCM_NAME}"`, {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (/STOPPED/.test(out)) return 'STOPPED';
    if (/STOP_PENDING/.test(out)) return 'STOP_PENDING';
    if (/START_PENDING/.test(out)) return 'START_PENDING';
    if (/RUNNING/.test(out)) return 'RUNNING';
    return 'UNKNOWN';
  } catch (err) {
    // sc.exe query exits 1060 when the service is not installed. This can
    // happen briefly during `npm run redeploy` (when sc stop races with our
    // poll and the SCM registration is being rewritten). Treat as a soft
    // "not yet back" state — keep polling. Exiting here used to cause a
    // tight respawn loop with the SCM FAILURE_ACTIONS restart.
    if (err.status === 1060) {
      log('WARN', 'Service not in SCM (1060); will keep polling');
      return 'NOT_INSTALLED';
    }
    return 'UNKNOWN';
  }
}

function startService() {
  try {
    execSync(`sc.exe start "${SCM_NAME}"`, {
      stdio: 'ignore',
      windowsHide: true,
    });
    log('INFO', `Issued sc.exe start ${SCM_NAME}`);
    return true;
  } catch (err) {
    // sc.exe start exits 1056 if already running — that's fine.
    if (err.status === 1056) return true;
    log('WARN', `sc.exe start failed (exit ${err.status})`);
    return false;
  }
}

function tick() {
  const state = queryState();
  if (state === 'STOPPED' || state === 'STOP_PENDING') {
    log('INFO', `Service is ${state}; restarting`);
    startService();
  } else if (state === 'NOT_INSTALLED') {
    // Service registration missing. Try `sc start` anyway — if the wrapper
    // .exe + .xml are still on disk, SCM can re-register from the binPath
    // (re)install the entry. If `sc start` fails with 1058 / 1060, we keep
    // polling — the next redeploy or manual install will bring it back.
    log('INFO', 'Attempting sc.exe start to recover missing registration');
    startService();
  } else if (state === 'UNKNOWN') {
    log('WARN', 'sc.exe query returned UNKNOWN; will retry next tick');
  }
  // RUNNING / START_PENDING: nothing to do.
}

log('INFO', `Watchdog started; polling ${SCM_NAME} every ${POLL_INTERVAL_MS}ms`);

// First tick fires after the first interval so we don't immediately re-start
// a service that's still ramping up from our own boot.
setInterval(tick, POLL_INTERVAL_MS);

// Keep the process alive — node-windows Service expects the wrapper.js
// process to stay open. setInterval alone is enough; no need for an extra
// server-trick here because wrapper.js handles the lifetime.