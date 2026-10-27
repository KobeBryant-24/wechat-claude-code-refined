#!/usr/bin/env node
// wechat-claude-code watchdog v2 — HTTP-controlled
//
// New design: this process becomes the parent of dist/main.js, and exposes
// a tiny HTTP API on 127.0.0.1 so npm scripts (and humans with curl) can
// control the child lifecycle without going through sc.exe / SCM.
//
// Coexists with the existing production watchdog (scripts/watchdog.cjs)
// and bridge service. They are unaffected — this script is just a sibling
// we run during development to validate the new design before swapping it
// into windows-service.cjs.
//
// Endpoints (all require Authorization: Bearer <token>):
//
//   GET  /status           → JSON { state, child_pid, uptime_ms, ... }
//   POST /restart          → kill current child (graceful), spawn new
//   POST /pause            → kill child, stop respawning
//   POST /resume           → spawn child again
//   POST /shutdown         → graceful exit of watchdog itself (test helper)
//
// State machine:
//
//   idle ──spawn──→ running ──child exit clean──→ running (restart)
//                     │                            ↑
//                     ├─child exit crash──→ backoff ┘
//                     │              (3 in 30s → circuit_broken)
//                     │
//                     ├─POST /pause──→ paused (no respawn)
//                     │ ↑↓
//                     └─POST /resume────┘
//
// Crash circuit breaker: 3 child exits (non-zero, non-signal) within 30 s
// transitions to circuit_broken — no further respawn until human ack via
// POST /resume. This stops a bad build from thrashing the child and spamming
// death-trace logs.
//
// CLI:
//
//   node scripts/watchdog-v2.cjs                       # spawn real main.js
//   node scripts/watchdog-v2.cjs --child-cmd "node ..." # spawn custom child
//   node scripts/watchdog-v2.cjs --port 9922            # override HTTP port
//   node scripts/watchdog-v2.cjs --project-dir /x/y     # where dist/main.js lives

'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// -------- configuration --------

const DATA_DIR = path.join(os.homedir(), '.wechat-claude-code');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'watchdog-v2.log');
const TOKEN_FILE = path.join(DATA_DIR, 'watchdog-v2.token');

function getArg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const HTTP_PORT = parseInt(getArg('--port', process.env.WCC_WATCHDOG_PORT || '9921'), 10);
const HTTP_HOST = '127.0.0.1';
const PROJECT_DIR = getArg('--project-dir', path.resolve(__dirname, '..'));

const CRASH_WINDOW_MS = 30 * 1000;
const CRASH_THRESHOLD = 3;
const SHUTDOWN_GRACE_MS = 8000; // how long to wait for child to exit cleanly
const RESTART_BACKOFF_BASE_MS = 1000;
const RESTART_BACKOFF_MAX_MS = 30 * 1000;

// Default child: the real main.js. Override via --child-cmd for tests.
const CHILD_CMD = getArg('--child-cmd')
  ? getArg('--child-cmd').split(/\s+/).filter(Boolean)
  : [process.execPath, path.join(PROJECT_DIR, 'dist', 'main.js'), 'start'];

// Set at module load so it's available before the first spawnChild() call.
let childCmdString = CHILD_CMD.join(' ');

// -------- runtime state --------

let state = 'idle';        // idle | running | paused | circuit_broken
let child = null;
let childPid = null;
let childStartedAt = null;
let childCmd = null;
// childCmdString is declared at module load (above) so console.log at startup
// can show it before spawnChild() runs.
let restartCount = 0;
let totalRestarts = 0;
let crashTimes = [];       // timestamps (ms) of recent non-zero child exits
let backoffMs = RESTART_BACKOFF_BASE_MS;
let pendingRestartTimer = null;
let shuttingDown = false;
const startedAt = Date.now();

// -------- helpers --------

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
}

function log(level, msg, data) {
  try {
    ensureDir(LOG_DIR);
    const ts = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
    const line = data !== undefined
      ? `${ts} ${level} ${msg} ${JSON.stringify(data)}\n`
      : `${ts} ${level} ${msg}\n`;
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch { /* never let logging crash the watchdog */ }
}

function writeDeathRecord(kind, info) {
  try {
    ensureDir(LOG_DIR);
    if (!childPid) return;
    const date = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const file = path.join(LOG_DIR, `death-${date}-${childPid}.log`);
    const payload = {
      ts: new Date().toISOString(),
      ts_local: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
      kind,
      pid: childPid,
      monitor_pid: process.pid,
      monitor_uptime_s: Math.round((Date.now() - startedAt) / 1000),
      watchdog_state: state,
      restart_count: restartCount,
      total_restarts: totalRestarts,
      child_cmd: childCmdString,
      ...info,
    };
    fs.appendFileSync(file, JSON.stringify(payload) + '\n', 'utf8');
  } catch (err) {
    log('WARN', 'Failed to write death record', { error: err.message });
  }
}

// -------- token management --------
//
// On first run, generate a 32-byte random token, store in TOKEN_FILE with
// restrictive permissions (0600 on POSIX; Windows ignores mode but the file is
// under the user's homedir which is ACL-protected). Subsequent runs read the
// same file so the token survives restarts.

function ensureToken() {
  ensureDir(DATA_DIR);
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    const tok = crypto.randomBytes(32).toString('hex');
    try {
      fs.writeFileSync(TOKEN_FILE, tok, { mode: 0o600 });
      log('INFO', 'Generated new watchdog token');
    } catch (err) {
      log('ERROR', 'Failed to persist token', { error: err.message });
    }
    return tok;
  }
}

const TOKEN = ensureToken();

// -------- HTTP server --------

function unauthorized(res) {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized' }));
}

function jsonOk(res, body) {
  const buf = JSON.stringify(body);
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(buf),
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 4096) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function authOk(req) {
  const h = req.headers['authorization'] || '';
  return h === `Bearer ${TOKEN}`;
}

const server = http.createServer(async (req, res) => {
  // /status is intentionally unauthenticated so /status output in WeChat
  // can be relayed without exposing the token. The risk is that anyone
  // on 127.0.0.1 can read state — acceptable for a desktop service.
  if (req.method === 'GET' && req.url === '/status') {
    return jsonOk(res, {
      state,
      child_pid: childPid,
      child_started_at: childStartedAt ? new Date(childStartedAt).toISOString() : null,
      child_uptime_s: childStartedAt ? Math.round((Date.now() - childStartedAt) / 1000) : null,
      child_cmd: childCmdString,
      restart_count: restartCount,
      total_restarts: totalRestarts,
      crash_count_in_window: crashTimes.length,
      watchdog_pid: process.pid,
      watchdog_uptime_s: Math.round((Date.now() - startedAt) / 1000),
      config: {
        http_port: HTTP_PORT,
        project_dir: PROJECT_DIR,
        crash_threshold: CRASH_THRESHOLD,
        crash_window_ms: CRASH_WINDOW_MS,
      },
    });
  }

  // Everything else requires auth.
  if (!authOk(req)) return unauthorized(res);

  if (req.method === 'POST' && req.url === '/restart') {
    await doRestart('manual_restart');
    return jsonOk(res, { ok: true, action: 'restart', state });
  }
  if (req.method === 'POST' && req.url === '/pause') {
    await doPause('manual_pause');
    return jsonOk(res, { ok: true, action: 'pause', state });
  }
  if (req.method === 'POST' && req.url === '/resume') {
    await doResume('manual_resume');
    return jsonOk(res, { ok: true, action: 'resume', state });
  }
  if (req.method === 'POST' && req.url === '/shutdown') {
    log('INFO', 'Shutdown requested via HTTP');
    scheduleExit(0);
    return jsonOk(res, { ok: true, action: 'shutdown_initiated' });
  }
  if (req.method === 'POST' && req.url === '/ack-circuit') {
    // Acknowledge a circuit_broken state and reset the counter.
    crashTimes = [];
    backoffMs = RESTART_BACKOFF_BASE_MS;
    if (state === 'circuit_broken') state = 'paused';
    log('INFO', 'Circuit breaker acknowledged');
    return jsonOk(res, { ok: true, action: 'ack_circuit', state });
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found', method: req.method, url: req.url }));
});

// -------- child lifecycle --------

function spawnChild(reason) {
  if (shuttingDown) return;
  if (state === 'paused' || state === 'circuit_broken') {
    log('INFO', `Refusing to spawn: state=${state}`, { reason });
    return;
  }

  childCmd = CHILD_CMD;
  childCmdString = childCmd.join(' ');
  childStartedAt = Date.now();
  log('INFO', `Spawning child: ${childCmdString}`, { reason });

  try {
    child = spawn(childCmd[0], childCmd.slice(1), {
      cwd: PROJECT_DIR,
      stdio: 'inherit',
      windowsHide: true,
      // WCC_RESTART_REASON lets the child tell *why* it exists. The startup
      // consultation used to have to infer this from the transcript, which it
      // reliably got wrong: a `npm run redeploy` that restarts the bridge
      // kills the process before its tool_result is written, so the transcript
      // looks identical whether the deploy succeeded or never ran.
      env: { ...process.env, WCC_WATCHDOG_CHILD: '1', WCC_RESTART_REASON: reason },
    });
  } catch (err) {
    log('ERROR', 'spawn() failed', { error: err.message });
    state = 'circuit_broken';
    return;
  }

  childPid = child.pid;
  state = 'running';

  child.on('exit', (code, signal) => onChildExit(code, signal, reason));
  child.on('error', (err) => {
    log('ERROR', 'child process error event', { error: err.message });
  });
}

function killChildGracefully() {
  if (!child || !childPid) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };

    child.once('exit', finish);
    try {
      // SIGTERM first — main.js has SIGTERM handler that does clean shutdown.
      child.kill('SIGTERM');
    } catch (err) {
      log('WARN', 'SIGTERM failed; falling back to SIGKILL', { error: err.message });
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }

    // Hard timeout — TerminateProcess the child if it doesn't exit cleanly.
    setTimeout(() => {
      if (done) return;
      log('WARN', 'child did not exit within grace, force-killing');
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      setTimeout(finish, 1000); // give SIGKILL 1s to settle
    }, SHUTDOWN_GRACE_MS).unref();
  });
}

function onChildExit(code, signal, spawnReason) {
  const uptimeMs = childStartedAt ? (Date.now() - childStartedAt) : 0;
  // Defense against tight crash loops: a child that exits within 1s of start
  // is almost certainly a startup bug, not a healthy restart. Treat as crash
  // even if exit code is 0, so we back off instead of hot-looping.
  const isInstantExit = uptimeMs < 1000;
  const exitKind = (code === 0 && !isInstantExit) || signal === 'SIGTERM' || signal === 'SIGINT'
    ? 'clean' : 'crash';
  const wasRunning = state === 'running';
  const exitInfo = {
    code, signal, spawn_reason: spawnReason,
    uptime_s: Math.round(uptimeMs / 1000),
    instant_exit: isInstantExit,
  };
  writeDeathRecord(exitKind, exitInfo);
  log('INFO', `child exited (${exitKind})`, exitInfo);

  child = null;
  childPid = null;
  childStartedAt = null;

  if (shuttingDown) return;

  if (state === 'paused') {
    log('INFO', 'paused; not respawning');
    return;
  }
  if (state === 'circuit_broken') {
    log('INFO', 'circuit_broken; not respawning');
    return;
  }

  // Decide: respawn immediately, with backoff, or trip circuit breaker.
  if (exitKind === 'clean') {
    restartCount += 1;
    totalRestarts += 1;
    backoffMs = RESTART_BACKOFF_BASE_MS;
    log('INFO', 'Clean exit — respawning immediately', { restart_count: restartCount });
    spawnChild('clean_exit_respawn');
  } else {
    crashTimes.push(Date.now());
    crashTimes = crashTimes.filter((t) => Date.now() - t <= CRASH_WINDOW_MS);
    if (crashTimes.length >= CRASH_THRESHOLD) {
      state = 'circuit_broken';
      log('ERROR', 'Circuit breaker tripped — stopping respawns', {
        crashes_in_window: crashTimes.length,
        window_ms: CRASH_WINDOW_MS,
        last_codes: crashTimes,
      });
      return;
    }
    backoffMs = Math.min(backoffMs * 2, RESTART_BACKOFF_MAX_MS);
    log('WARN', `Crash — backing off ${backoffMs}ms before respawn`, {
      crash_count_in_window: crashTimes.length,
    });
    pendingRestartTimer = setTimeout(() => {
      pendingRestartTimer = null;
      if (state === 'running' || state === 'idle') spawnChild('crash_backoff_respawn');
    }, backoffMs);
    pendingRestartTimer.unref();
  }
}

async function doRestart(reason) {
  log('INFO', `doRestart: ${reason}`);
  if (state === 'paused') {
    state = 'idle';
    spawnChild(reason);
    return;
  }
  if (child) {
    await killChildGracefully();
  }
  // child.on('exit') will trigger respawn via the clean-exit path.
}

async function doPause(reason) {
  log('INFO', `doPause: ${reason}`);
  if (state === 'paused') return;
  state = 'paused';
  if (pendingRestartTimer) { clearTimeout(pendingRestartTimer); pendingRestartTimer = null; }
  if (child) await killChildGracefully();
}

async function doResume(reason) {
  log('INFO', `doResume: ${reason}`);
  if (state !== 'paused' && state !== 'circuit_broken') return;
  crashTimes = [];
  backoffMs = RESTART_BACKOFF_BASE_MS;
  state = 'idle';
  spawnChild(reason);
}

function scheduleExit(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  state = 'shutting_down';
  (async () => {
    if (child) await killChildGracefully();
    server.close(() => process.exit(code));
    setTimeout(() => process.exit(code), 3000).unref();
  })();
}

// -------- signal handling --------
//
// node-windows wrapper (when this script is later wired in) translates SCM
// SERVICE_CONTROL_STOP into a SIGTERM. We treat SIGTERM/SIGHUP as graceful
// shutdown. SIGINT (Ctrl+C in a terminal) also does graceful shutdown.

function shutdownOnSignal(sig) {
  log('INFO', `received ${sig}; shutting down`);
  scheduleExit(0);
}
process.on('SIGTERM', () => shutdownOnSignal('SIGTERM'));
process.on('SIGINT', () => shutdownOnSignal('SIGINT'));
process.on('SIGHUP', () => shutdownOnSignal('SIGHUP'));

// The node-windows wrapper stops its child by sending it a 'shutdown' IPC
// message (that is what `child.send('shutdown')` in its wrapper.js does).
// Without this handler the message is silently dropped and the service
// process keeps running after SCM has already marked the service stopped.
// Treat it exactly like SIGTERM: shut the child down, then exit.
process.on('message', (msg) => {
  if (msg === 'shutdown') shutdownOnSignal('SHUTDOWN');
});

// Safety net for the case where the wrapper dies without getting the chance
// to send that message (e.g. it is force-killed by SCM). The IPC channel
// closes when the parent goes away, and an orphaned watchdog would keep
// holding the WeChat session and the :9921 port. Shutting down here makes
// "the service stopped" mean the whole chain stopped.
process.on('disconnect', () => {
  shutdownOnSignal('PARENT_EXIT');
});

// -------- bootstrap --------

server.listen(HTTP_PORT, HTTP_HOST, () => {
  log('INFO', `HTTP API listening on http://${HTTP_HOST}:${HTTP_PORT}`, {
    token_file: TOKEN_FILE,
  });
  // Print the token to stdout once so the user can curl from another shell.
  // We deliberately do this on startup, not on every request.
  console.log(`watchdog-v2 listening on http://${HTTP_HOST}:${HTTP_PORT}`);
  console.log(`token: ${TOKEN}`);
  console.log(`child: ${childCmdString}`);

  // Spawn the initial child.
  spawnChild('initial_startup');
});

server.on('error', (err) => {
  log('ERROR', 'HTTP server error', { error: err.message, code: err.code });
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${HTTP_PORT} already in use. Try --port <n>.`);
    process.exit(2);
  }
});