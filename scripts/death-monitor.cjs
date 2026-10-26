#!/usr/bin/env node
// wechat-claude-code death monitor
//
// Sibling process spawned by main.js (dist/main.js) at startup. Its only job
// is to detect when the parent main.js has exited for any reason — clean
// shutdown, SIGKILL from node-windows wrapper after `sc stop` timeout, hard
// TerminateProcess from Task Manager, crash, OOM, etc. — and write a
// forensic record to disk synchronously before exiting.
//
// The reason this exists as a SEPARATE PROCESS rather than as Node.js signal
// handlers inside main.js: on Windows the node-windows wrapper's stop path
// is `SIGINT child → SIGINT self → TerminateProcess(child) → exit wrapper`.
// TerminateProcess bypasses ALL signal handlers and the `exit` event — the
// main.js process is simply killed mid-instruction, with no chance to flush
// anything. The sibling, on a different process tree branch, survives the
// parent's death and can synchronously appendFileSync() the forensic line.
//
// Filename convention: `death-YYYY-MM-DD-{parentPid}.log` so it's obvious
// which process died even years later. Each parent writes to its own file
// keyed by PID — if the bridge gets stuck in a multi-instance pathology we
// can see the per-PID death trail.
//
// Invocation from main.js (after the parent PID is known):
//
//   const monitor = spawn(
//     process.execPath,
//     [join(__dirname, '..', 'scripts', 'death-monitor.cjs')],
//     {
//       detached: true, stdio: 'ignore', windowsHide: true,
//       env: { ...process.env, WCC_PARENT_PID: String(process.pid) },
//     },
//   );
//   monitor.unref();   // do not keep the event loop alive on monitor's behalf
//
// Note on lifetime: with `detached: true` and `monitor.unref()`, the monitor
// inherits no handle from the parent and is its own process group leader.
// When the parent dies, the monitor keeps running until it explicitly exits
// after writing the death log.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const POLL_INTERVAL_MS = 1000;
const LOG_DIR = path.join(os.homedir(), '.wechat-claude-code', 'logs');

// -------- helpers --------

function nowLocalISO() {
  // Beijing time (+08:00) for consistency with the other wechat-claude-code logs
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
}

function localDateStr() {
  return nowLocalISO().slice(0, 10);
}

function getCmdLine(pid) {
  // Best-effort: wmic prints nothing if the process is already gone, or if
  // we don't have permission. Caller should have captured this BEFORE the
  // parent died, but we re-fetch as a sanity check at startup too.
  try {
    const r = spawnSync('wmic', [
      'process', 'where', `ProcessId=${pid}`,
      'get', 'ProcessId,ParentProcessId,CommandLine', '/format:list',
    ], { encoding: 'utf8', timeout: 2000, windowsHide: true });
    if (r.status === 0 && r.stdout) {
      const out = {};
      for (const line of r.stdout.split(/\r?\n/)) {
        const m = line.match(/^(\w+)=(.*)$/);
        if (m) out[m[1]] = m[2];
      }
      return {
        command_line: (out.CommandLine || '').trim() || '<unknown>',
        reported_pid: out.ProcessId ? parseInt(out.ProcessId, 10) : null,
        reported_ppid: out.ParentProcessId ? parseInt(out.ParentProcessId, 10) : null,
      };
    }
  } catch { /* fallthrough */ }
  return { command_line: '<unavailable>', reported_pid: null, reported_ppid: null };
}

function isAlive(pid) {
  // Signal 0: doesn't actually send a signal, just checks if we can.
  // Throws ESRCH if process is gone. Returns true on success.
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'ESRCH') return false;
    // EPERM means it exists but we don't own it — still alive from our POV.
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

function writeDeath(parentPid, info) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const date = localDateStr();
    const file = path.join(LOG_DIR, `death-${date}-${parentPid}.log`);
    const payload = {
      ts: new Date().toISOString(),
      ts_local: nowLocalISO(),
      kind: 'parent_dead',
      parent_pid: parentPid,
      monitor_pid: process.pid,
      monitor_ppid: process.ppid,
      monitor_started: monitorStartedAt,
      last_alive_at: lastAliveAt,
      first_alive_at: firstAliveAt,
      info,
    };
    fs.appendFileSync(file, JSON.stringify(payload) + '\n', 'utf8');
  } catch {
    // Never let the monitor die of its own logging failure.
  }
}

// -------- main --------

const parentPid = parseInt(process.env.WCC_PARENT_PID || '', 10);
if (!parentPid || Number.isNaN(parentPid)) {
  process.stderr.write(`death-monitor: missing WCC_PARENT_PID env\n`);
  process.exit(2);
}

// Capture parent info while it's definitely alive (this script is spawned
// right after the parent sets up — but capture anyway so the forensic
// record has the cmdline even if the parent dies before its first poll).
const monitorStartedAt = nowLocalISO();
const firstAliveAt = null;     // filled on first successful poll
let lastAliveAt = null;        // updated each successful poll
let observedParentInfo = null; // captured on first poll
let lastSeenAlive = false;     // did the previous poll see parent alive?

function tick() {
  const alive = isAlive(parentPid);
  if (alive) {
    if (!firstAliveAt) {
      const ts = nowLocalISO();
      observedParentInfo = getCmdLine(parentPid);
      // Set firstAliveAt and lastAliveAt together on the first observation
      // (using the closure variable to share the timestamp).
      firstAliveAtRef = ts;
      lastAliveAt = ts;
    } else {
      lastAliveAt = nowLocalISO();
    }
    lastSeenAlive = true;
    return;
  }

  // Parent is gone. We only write the death record on the EDGE — i.e. the
  // first poll that observes it gone, after we'd previously seen it alive.
  // This prevents writing a spurious death on monitor startup if the env
  // was misconfigured (parent never existed).
  if (lastSeenAlive) {
    writeDeath(parentPid, {
      reason: 'parent_process_vanished',
      last_observed_parent: observedParentInfo,
    });
    process.exit(0);
  } else {
    // Parent was already dead before our first poll completed. Still write
    // a record so the absence isn't silent — but tag it so we can tell.
    writeDeath(parentPid, {
      reason: 'parent_never_alive_in_monitor',
      last_observed_parent: null,
    });
    process.exit(0);
  }
}

// We need `firstAliveAt` to be visible inside tick() before assignment. Hoist
// the variable and use a parallel local since `firstAliveAt` is declared with
// `let` above but the polling logic writes to it from inside tick().
let firstAliveAtRef = null;

// First poll fires immediately so we don't wait POLL_INTERVAL_MS to discover
// the parent is gone.
tick();
const handle = setInterval(tick, POLL_INTERVAL_MS);
// unref isn't strictly needed because we call process.exit() above, but
// doesn't hurt.
handle.unref();