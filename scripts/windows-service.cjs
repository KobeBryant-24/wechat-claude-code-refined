#!/usr/bin/env node
// wechat-claude-code Windows service helper
//
// Wraps the node-windows Service class to install/uninstall/start/stop both
// the main wechat-claude-code bridge and the watchdog that keeps it alive
// across `sc stop` / redeploy events. Both are registered as real Windows
// Services with the Service Control Manager. This script is invoked by
// scripts/daemon.sh on MINGW/MSYS/CYGWIN Git Bash environments.
//
// Important caveat about node-windows 1.0.0-beta.8: the Service class exposes
// an `exists` getter that checks ONLY local files (the wrapper .exe and .xml
// config), NOT whether the service is registered with SCM. If a previous
// install was attempted without Administrator privileges, the SCM
// registration fails but the local files remain, and subsequent calls to
// install() see `svc.exists === true` and short-circuit with
// 'alreadyinstalled'. To avoid that trap, we use `sc.exe query` as the
// source of truth for whether the service is actually installed, and clean
// up stale local files before re-installing.

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { execSync } = require('child_process');
const { Service } = require('node-windows');

// Resolve paths from this script's location so the script works regardless
// of the current working directory it is invoked from.
const PROJECT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(os.homedir(), '.wechat-claude-code');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const WATCHDOG_TOKEN_FILE = path.join(DATA_DIR, 'watchdog-v2.token');
const WATCHDOG_HTTP_PORT = parseInt(process.env.WCC_WATCHDOG_PORT || '9921', 10);

// How long `restart` waits for watchdog-v2 to hand back a fresh child pid, and
// how often it polls. The respawn path is a same-process async hop (child
// 'exit' → onChildExit → spawnChild), so this is normally sub-second; the
// budget only covers a cold Node start under load.
const RESTART_TIMEOUT_MS = 30000;
const RESTART_POLL_MS = 250;

// ── Main bridge service ───────────────────────────────────────────────────
const SERVICE_NAME = 'WeChatClaudeCodeBridge';
// node-windows registers the SCM service under the `id` field of the
// Service object. The id has `.exe` appended automatically (visible in the
// generated wrapper .xml as `<id>wechatclaudecodebridge.exe</id>`), so the
// SCM registry key is `wechatclaudecodebridge.exe` — NOT the display name
// `WeChatClaudeCodeBridge`. Verified via `Get-Service` and `sc query`:
//
//   Get-Service wechatclaudecodebridge.exe   → Running
//   sc query    wechatclaudecodebridge.exe   → STATE: 4 RUNNING
//   Get-Service WeChatClaudeCodeBridge       → not found (1060)
//
// The previous comment claiming `WeChatClaudeCodeBridge` was the SCM key
// was wrong — that error caused npm run daemon:reinstall to silently fail
// at `sc stop`, leaving the service running and locking the wrapper .exe.
const SCM_SERVICE_NAME = 'wechatclaudecodebridge.exe';
const DISPLAY_NAME = 'WeChat Claude Code Bridge';
//
// The wrapper's `script` is now watchdog-v2.cjs, not dist/main.js.
// watchdog-v2 owns the lifetime of dist/main.js and exposes an HTTP API on
// 127.0.0.1:9921 for pause/resume/restart. The wrapper stays as a thin SCM
// glue: SCM lifecycle → wrapper → watchdog-v2 → dist/main.js.
const WATCHDOG_V2_SCRIPT = path.join(PROJECT_DIR, 'scripts', 'watchdog-v2.cjs');
const DAEMON_DIR = path.join(path.dirname(WATCHDOG_V2_SCRIPT), 'daemon');

// ── Watchdog service ──────────────────────────────────────────────────────
//
// Companion service that polls the main service every 5s and re-starts it
// via `sc.exe start` whenever it is not RUNNING. Required because
// node-windows's child.on('exit') handler exits the wrapper on `sc stop`
// (forcekill branch), and the wrapper's own restart counter is bypassed in
// that path. So after every `npm run daemon -- stop` (which is what
// `redeploy` ultimately does), the service stays STOPPED until something
// external kicks it. This watchdog is that something.
//
// watchdog.cjs itself only depends on sc.exe — no Anthropic credentials
// needed, so we deliberately do NOT propagate ANTHROPIC_* env vars.
const WATCHDOG_NAME = 'WeChatClaudeCodeWatchdog';
const WATCHDOG_SCM_NAME = 'wechatclaudecodewatchdog.exe';
const WATCHDOG_DISPLAY_NAME = 'WeChat Claude Code Watchdog';
const WATCHDOG_SCRIPT = path.join(PROJECT_DIR, 'scripts', 'watchdog.cjs');

// No credential env vars are propagated into the service.
//
// The bridge never talks to Anthropic itself: it spawns the Claude Code CLI
// (`claude -p ...`) once per WeChat message, and the CLI resolves its own
// credentials from ~/.claude/settings.json (the `env` block) or from the
// user's own shell environment. Propagating ANTHROPIC_AUTH_TOKEN here would
// only write the secret in clear text into the generated wrapper XML and
// into the SCM registry — which is exactly how a token ended up in this
// repository's git history before.
//
// Consequence: rotating the token is an edit to ~/.claude/settings.json.
// It takes effect on the next WeChat message — the daemon spawns a fresh
// `claude` per message — with no service reinstall.

// --- SCM (Service Control Manager) queries ---------------------------------

function isInstalledInScm(scmName) {
  // `sc.exe query <name>` returns exit code 0 when the service is registered
  // and 1060 (ERROR_SERVICE_DOES_NOT_EXIST) otherwise. We treat any non-zero
  // exit as "not installed". Must use the SCM registry key name, not the
  // friendly display name.
  try {
    execSync(`sc.exe query "${scmName}"`, { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function hasStaleLocalFiles(dir, exeBaseName) {
  // `exists` getter is local-files-only, so we mirror it directly to detect
  // the "orphan" state where local files exist but SCM has no service.
  try {
    const exePath = path.join(dir, `${exeBaseName}.exe`);
    const xmlPath = path.join(dir, `${exeBaseName}.xml`);
    return fs.existsSync(exePath) && fs.existsSync(xmlPath);
  } catch {
    return false;
  }
}

function removeStaleLocalFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch (err) {
      console.warn(`Warning: could not remove stale file ${f}: ${err.message}`);
    }
  }
}

// --- Service construction --------------------------------------------------

function buildBaseEnv() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const nodeDir = path.dirname(process.execPath);
  const basePath = process.env.PATH || '';
  // The installing user's home directory. Everything below is derived from
  // it or from PROJECT_DIR — never a hardcoded absolute path, so that a
  // fresh `git clone` on another machine installs a working service.
  const userHome = os.homedir();
  // PATH entries the service must have to find user-installed tools. The
  // service runs as LocalSystem, whose default PATH does NOT include any
  // user-installed binaries. Missing `claude` from PATH causes main.js to
  // spawn-fail with NTSTATUS 0xC0000002 (STATUS_NOT_IMPLEMENTED) and
  // every WeChat message gets "Claude 处理请求时出错".
  //
  // Prepend these so they win over the system's default PATH. Each entry
  // is added only if not already present.
  const requiredDirs = [
    nodeDir,
    path.join(userHome, 'AppData', 'Roaming', 'npm'),  // npm-global bins (claude.cmd etc.)
    path.join(userHome, '.local', 'bin'),               // Claude Code install location (claude.exe)
    path.join(PROJECT_DIR, 'node_modules', '.bin'),     // this checkout's local bins
  ];
  const existing = basePath.split(path.delimiter);
  const merged = [...requiredDirs.filter((d) => d && !existing.includes(d)), ...existing]
    .filter(Boolean)
    .join(path.delimiter);
  const env = [{ name: 'PATH', value: merged }];
  // Force USERPROFILE / HOME to the installing user's home directory. The
  // service runs as LocalSystem by default, whose `os.homedir()` resolves to
  // C:\Windows\System32\config\systemprofile — a different path from where
  // `npm run setup` (running as the user) wrote the account credentials.
  // Setting these here makes Node.js inside the service resolve the same
  // data directory as the user, so saved accounts and config are found.
  env.push({ name: 'USERPROFILE', value: userHome });
  env.push({ name: 'HOME', value: userHome });
  // APPDATA / LOCALAPPDATA: LocalSystem defaults these to
  // C:\Windows\System32\config\systemprofile\AppData\Roaming and .../Local.
  // Native modules bundled inside `claude.exe` (better-sqlite3, keytar)
  // resolve cache / credential dirs from %APPDATA% during DllMain. If
  // APPDATA points at the system profile while HOME/USERPROFILE point at
  // C:\Users\Administrator, the native binding reads/writes split state,
  // DllMain returns FALSE, and the process aborts with NTSTATUS 0xC0000142
  // (STATUS_DLL_INIT_FAILED) — observed as exit code 3221225794 from the
  // Node.js spawn in src/claude/provider.ts.
  //
  // Pin APPDATA / LOCALAPPDATA / TEMP / TMP to the user-relative paths so
  // claude.exe's native bindings see a single coherent %USERPROFILE%.
  env.push({ name: 'APPDATA',     value: path.join(userHome, 'AppData', 'Roaming') });
  env.push({ name: 'LOCALAPPDATA', value: path.join(userHome, 'AppData', 'Local') });
  env.push({ name: 'TEMP',        value: path.join(userHome, 'AppData', 'Local', 'Temp') });
  env.push({ name: 'TMP',         value: path.join(userHome, 'AppData', 'Local', 'Temp') });
  // No USERDOMAIN / USERNAME here. Nothing in src/ reads them (os.userInfo()
  // on Windows reads the process token, not the env var), and pinning them
  // would bake this machine's account name into the service config.
  return env;
}

function buildService() {
  return new Service({
    name: SERVICE_NAME,
    description: DISPLAY_NAME,
    // watchdog-v2 owns the lifetime of dist/main.js. The wrapper becomes
    // a thin SCM glue; on SCM stop the wrapper exits, watchdog-v2 dies
    // (which kills main.js), and SCM marks the service STOPPED.
    script: WATCHDOG_V2_SCRIPT,
    scriptOptions: `--port ${WATCHDOG_HTTP_PORT}`,
    workingDirectory: PROJECT_DIR,
    logpath: LOG_DIR,
    env: buildBaseEnv(),
    wait: 2,
    grow: 0.5,
    // node-windows wrapper translates `maxRetries: N` to `--maxretries N`,
    // and its wrapper.js exits the wrapper process when `attempts > N && N >= 0`.
    // Pass -1 so the wrapper's internal restart counter never trips. The
    // HTTP API on watchdog-v2 is the recovery mechanism for crashes; SCM
    // FAILURE_ACTIONS covers unexpected wrapper death.
    maxRetries: -1,
    // node-windows always emits `--stopparentfirst <value>` into the wrapper
    // arguments, and its wrapper.js treats ANY non-empty string as truthy
    // (`if (argv.s) child.send('shutdown')`). Leaving this unset renders the
    // literal string "undefined" into the wrapper XML.
    //
    // 'true' is the intended value ("Allow the service to shutdown
    // cleanly"): winsw gets a valid <stopparentprocessfirst>true</...> and
    // the wrapper keeps its current semantics (detached child, stopped via
    // the 'shutdown' IPC message). watchdog-v2 handles that message — see
    // scripts/watchdog-v2.cjs — so the graceful path now actually runs.
    stopparentfirst: 'true',
  });
}

function buildWatchdogService() {
  // No env propagation — watchdog only calls sc.exe, doesn't need API keys.
  return new Service({
    name: WATCHDOG_NAME,
    description: WATCHDOG_DISPLAY_NAME,
    script: WATCHDOG_SCRIPT,
    scriptOptions: '',
    workingDirectory: PROJECT_DIR,
    logpath: LOG_DIR,
    env: buildBaseEnv(),
    // Watchdog itself should never give up. node-windows wrapper's
    // `attempts > argv.m` exit is bypassed when forcekill=true (sc stop),
    // so this maxRetries only matters for *unexpected* wrapper exits.
    // 100 is enough buffer; the real protection is the watchdog's own
    // logic which doesn't depend on the wrapper surviving.
    wait: 2,
    grow: 0,
    maxRetries: 100,
    // Same reason as the bridge service: keep node-windows from writing
    // the literal string "undefined" into the watchdog's wrapper XML.
    stopparentfirst: 'true',
  });
}

// Wraps a Service operation with a shared error handler and an exit guard so
// we always terminate exactly once even if multiple events fire.
function withService(svc, action) {
  let exited = false;
  const exit = (code) => {
    if (exited) return;
    exited = true;
    process.exit(code);
  };
  svc.on('error', (err) => {
    const msg = err && err.message ? err.message : String(err);
    console.error(`Service error: ${msg}`);
    if (/access is denied|requires elevation|administrator/i.test(msg)) {
      console.error('');
      console.error('Hint: installing or modifying a Windows service requires');
      console.error('Administrator privileges. Re-run from an Administrator Git Bash.');
    }
    exit(1);
  });
  action(svc, exit);
}

// --- Subcommands: main bridge service --------------------------------------

function install() {
  if (isInstalledInScm(SCM_SERVICE_NAME)) {
    console.log(`Service '${SERVICE_NAME}' is already installed in SCM.`);
    console.log(`Use 'npm run daemon -- start' to start it, or 'uninstall' to remove.`);
    process.exit(0);
  }
  // Pre-cleanup wrapper files with retry. node-windows's install() will
  // overwrite these via fs.writeFile / winsw.createExe, but if the .exe is
  // still locked by the SCM (after a failed uninstall, or when the user runs
  // install without uninstall first), the write fails with EBUSY.
  // Rename-to-trash first is more reliable than unlink on Windows, because
  // rename only requires modify-permission on the parent dir, not on the
  // file itself. The OS will release the file handle eventually.
  console.log('Pre-cleanup wrapper files (with retry on lock)...');
  rotateStaleWrapperFiles();

  const svc = buildService();
  withService(svc, (s, exit) => {
    s.on('install', () => {
      console.log(`Installed service '${SERVICE_NAME}' (wrapper → watchdog-v2 → dist/main.js).`);
      console.log('Starting service...');
      s.start();
    });
    s.on('start', () => {
      console.log(`Service started.`);
      console.log(`Logs: ${LOG_DIR}`);
      console.log(`Watchdog-v2 HTTP API: http://127.0.0.1:${WATCHDOG_HTTP_PORT}/status`);
      console.log(`Token file: ${WATCHDOG_TOKEN_FILE}`);
      exit(0);
    });
    console.log('Installing Windows service (requires Administrator)...');
    s.install();
  });
}

// Rename any pre-existing wrapper files to .old with retry. This unblocks
// node-windows's install() which would otherwise fail with EBUSY on
// scripts\daemon\wechatclaudecodebridge.exe (file still locked by SCM).
// Renaming requires modify permission on the parent dir only, not on the
// file, so it succeeds even when the file is open.
function rotateStaleWrapperFiles() {
  const baseNoExt = SCM_SERVICE_NAME.replace(/\.exe$/, '');
  const candidates = [
    path.join(DAEMON_DIR, `${SCM_SERVICE_NAME}`),
    path.join(DAEMON_DIR, `${baseNoExt}.xml`),
    path.join(DAEMON_DIR, `${baseNoExt}.wrapper.log`),
    path.join(DAEMON_DIR, `${baseNoExt}.out.log`),
    path.join(DAEMON_DIR, `${baseNoExt}.err.log`),
    path.join(DAEMON_DIR, `${baseNoExt}.exe.config`),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const backup = `${file}.old-${Date.now()}`;
    try {
      fs.renameSync(file, backup);
      console.log(`  rotated: ${path.basename(file)} → ${path.basename(backup)}`);
    } catch (err) {
      // Fallback to unlink with retry.
      let removed = false;
      for (let i = 0; i < 5; i++) {
        try { fs.unlinkSync(file); removed = true; break; }
        catch (e) {
          if (e.code === 'ENOENT') { removed = true; break; }
          syncSleep(1000);
        }
      }
      if (removed) {
        console.log(`  removed: ${path.basename(file)}`);
      } else {
        console.warn(`  could not remove ${path.basename(file)} (${err.code || err.message}); install may fail with EBUSY`);
      }
    }
  }
}

// Internal: install the watchdog without recursing back through the CLI
// dispatcher. Kept for backward compatibility with `npm run daemon -- install-watchdog`
// — but no longer auto-called from install() since watchdog-v2 is now in-process.
// Best-effort: any failure is logged and the callback is still fired.
function installWatchdogInternal(onInstalled) {
  console.warn('installWatchdogInternal is deprecated — watchdog-v2 replaces the standalone watchdog service.');
  if (typeof onInstalled === 'function') onInstalled();
}

function uninstall() {
  if (!isInstalledInScm(SCM_SERVICE_NAME)) {
    if (hasStaleLocalFiles(DAEMON_DIR, 'wechatclaudecodebridge')) {
      console.log('Service not in SCM, removing stale local wrapper files...');
      removeStaleLocalFiles(DAEMON_DIR);
    }
    console.log(`Service '${SERVICE_NAME}' is not installed.`);
    process.exit(0);
  }
  const svc = buildService();
  withService(svc, (s, exit) => {
    s.on('uninstall', () => {
      console.log(`Uninstalled service '${SERVICE_NAME}'.`);
      exit(0);
    });
    console.log('Uninstalling Windows service...');
    s.uninstall();
  });
}

function start() {
  scStart(SCM_SERVICE_NAME, SERVICE_NAME);
}

function stop() {
  if (!isInstalledInScm(SCM_SERVICE_NAME)) {
    console.log(`Service '${SERVICE_NAME}' is not installed.`);
    process.exit(0);
  }
  const svc = buildService();
  withService(svc, (s, exit) => {
    s.on('stop', () => {
      console.log(`Stopped service '${SERVICE_NAME}'.`);
      exit(0);
    });
    console.log(`Stopping service '${SERVICE_NAME}'...`);
    s.stop();
  });
}

// --- Subcommands: watchdog service ----------------------------------------

// node-windows derives its working directory from path.dirname(script) and
// appends 'daemon'. The watchdog script lives in scripts/, not dist/, so its
// wrapper files land in scripts/daemon/.
const WATCHDOG_DAEMON_DIR = path.join(path.dirname(WATCHDOG_SCRIPT), 'daemon');

function installWatchdog() {
  if (isInstalledInScm(WATCHDOG_SCM_NAME)) {
    console.log(`Service '${WATCHDOG_NAME}' is already installed in SCM.`);
    process.exit(0);
  }
  if (hasStaleLocalFiles(WATCHDOG_DAEMON_DIR, 'wechatclaudecodewatchdog')) {
    console.log('Found stale local watchdog wrapper files. Cleaning up...');
    removeStaleLocalFiles(WATCHDOG_DAEMON_DIR);
  }
  // Build the watchdog Service first so node-windows generates the wrapper
  // .exe + .xml locally (needed for SCM registration binPath). node-windows's
  // own s.install() calls winsw install which fails on this Windows host
  // with WMI.WmiException: UnknownFailure (known node-windows 1.0.0-beta.8
  // winsw issue). We then bypass winsw and register with sc.exe create
  // directly, pointing binPath at the winsw binary node-windows just
  // produced — that binary already knows how to be a ServiceMain host,
  // SCM accepts it, and start fires immediately.
  const svc = buildWatchdogService();
  withService(svc, (s, exit) => {
    s.on('install', () => {
      console.log(`Generated watchdog wrapper files at ${WATCHDOG_DAEMON_DIR}.`);
      console.log('Registering watchdog service with SCM via sc.exe create...');
      const wrapperExe = path.join(WATCHDOG_DAEMON_DIR, `${WATCHDOG_SCM_NAME}`);
      try {
        execSync(
          `sc.exe create "${WATCHDOG_SCM_NAME}" binPath= "${wrapperExe}" start= auto displayname= "WeChat Claude Code Watchdog"`,
          { stdio: 'inherit' },
        );
      } catch (err) {
        console.error(`sc.exe create failed: ${err.message}`);
        exit(1);
        return;
      }
      console.log('Setting FAILURE_ACTIONS (restart after 5s)...');
      try {
        execSync(
          `sc.exe failure "${WATCHDOG_SCM_NAME}" reset= 30 actions= restart/5000`,
          { stdio: 'inherit' },
        );
      } catch (err) {
        console.warn(`sc.exe failure config failed (non-fatal): ${err.message}`);
      }
      console.log('Starting service...');
      try {
        execSync(`sc.exe start "${WATCHDOG_SCM_NAME}"`, { stdio: 'inherit' });
      } catch {
        // sc start returns non-zero if already starting; ignore.
      }
      // Poll until RUNNING (winsw takes ~5s to report ServiceMain ready).
      let running = false;
      for (let i = 0; i < 30; i++) {
        try {
          const out = execSync(`sc.exe query "${WATCHDOG_SCM_NAME}"`, { encoding: 'utf8' });
          if (/RUNNING/.test(out)) { running = true; break; }
        } catch { /* transient */ }
        syncSleep(500);
      }
      if (!running) {
        console.error('Service did not reach RUNNING in time; check Event Viewer.');
        exit(1);
        return;
      }
      console.log(`Installed + started service '${WATCHDOG_NAME}'.`);
      console.log(`Logs: ${LOG_DIR}`);
      exit(0);
    });
    console.log('Generating watchdog wrapper files (requires Administrator for SCM, but local file generation works in non-elevated too)...');
    s.install();
  });
}

function uninstallWatchdog() {
  if (!isInstalledInScm(WATCHDOG_SCM_NAME)) {
    if (hasStaleLocalFiles(WATCHDOG_DAEMON_DIR, 'wechatclaudecodewatchdog')) {
      console.log('Watchdog not in SCM, removing stale local wrapper files...');
      removeStaleLocalFiles(WATCHDOG_DAEMON_DIR);
    }
    console.log(`Service '${WATCHDOG_NAME}' is not installed.`);
    process.exit(0);
  }
  const svc = buildWatchdogService();
  withService(svc, (s, exit) => {
    s.on('uninstall', () => {
      console.log(`Uninstalled service '${WATCHDOG_NAME}'.`);
      exit(0);
    });
    console.log('Uninstalling watchdog service...');
    s.uninstall();
  });
}

function startWatchdog() {
  scStart(WATCHDOG_SCM_NAME, WATCHDOG_NAME);
}

function stopWatchdog() {
  if (!isInstalledInScm(WATCHDOG_SCM_NAME)) {
    console.log(`Service '${WATCHDOG_NAME}' is not installed.`);
    process.exit(0);
  }
  const svc = buildWatchdogService();
  withService(svc, (s, exit) => {
    s.on('stop', () => {
      console.log(`Stopped service '${WATCHDOG_NAME}'.`);
      exit(0);
    });
    console.log(`Stopping service '${WATCHDOG_NAME}'...`);
    s.stop();
  });
}

// --- Shared helpers --------------------------------------------------------

// Read the watchdog-v2 token from disk. watchdog-v2 generates this on first
// run and stores it in WATCHDOG_TOKEN_FILE; if it doesn't exist yet, the
// watchdog-v2 process hasn't started at least once. We surface a helpful
// error in that case.
function readWatchdogToken() {
  try {
    return fs.readFileSync(WATCHDOG_TOKEN_FILE, 'utf8').trim();
  } catch {
    console.error(`Watchdog-v2 token not found at ${WATCHDOG_TOKEN_FILE}.`);
    console.error('Has watchdog-v2 started at least once? Check that the service is RUNNING.');
    process.exit(2);
  }
}

// HTTP call to the watchdog-v2 control API on 127.0.0.1. Used by pause /
// resume / restart. Returns the parsed JSON body, or throws on network error.
//
// `/status` is deliberately unauthenticated on the watchdog side
// (watchdog-v2.cjs:201); we send the token anyway so every call shares one
// code path.
function watchdogHttp(method, urlPath) {
  return new Promise((resolve, reject) => {
    const token = readWatchdogToken();
    const req = http.request({
      hostname: '127.0.0.1',
      port: WATCHDOG_HTTP_PORT,
      path: urlPath,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Length': 0,
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data)); }
          catch { resolve({ raw: data }); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => {
      req.destroy(new Error('HTTP request timeout'));
    });
    req.end();
  });
}

// Swap in a freshly built dist/main.js without touching the service wrapper
// or watchdog-v2.
//
// `reinstall` (stop → uninstall → install) is the wrong tool for a code-only
// deploy: it re-registers the SCM service, which regenerates the wrapper XML —
// re-snapshotting env from whatever shell invoked it — and bounces watchdog-v2
// along with the child. watchdog-v2 is already the direct parent of
// dist/main.js, so it owns the child's lifetime. POST /restart SIGTERMs the
// child; the clean exit trips watchdog's immediate-respawn path, which loads
// the new build. Wrapper and watchdog never observe a restart at all.
//
// Use `reinstall` only when the wrapper config itself changes: env vars,
// watchdog script path, service account, log destination.
async function restart() {
  console.log('=== restart (swap dist/main.js via watchdog-v2) ===');

  // Baseline first: we need the pre-restart child pid so we can distinguish
  // "a new child came up" from "the old one is somehow still there".
  let before;
  try {
    before = await watchdogHttp('GET', '/status');
  } catch (err) {
    console.error(`Cannot reach watchdog-v2 on 127.0.0.1:${WATCHDOG_HTTP_PORT}: ${err.message}`);
    console.error('Is the service running?  sc.exe query wechatclaudecodebridge.exe');
    process.exit(1);
  }
  const oldPid = before.child_pid;
  console.log(
    `watchdog: state=${before.state} child_pid=${oldPid} watchdog_pid=${before.watchdog_pid}`
  );

  if (before.state === 'circuit_broken') {
    console.error('ERROR: watchdog is circuit_broken — it will refuse to respawn a new build.');
    console.error('Clear it first:');
    console.error(
      `  curl -X POST http://127.0.0.1:${WATCHDOG_HTTP_PORT}/ack-circuit ` +
      `-H "Authorization: Bearer <token from ${WATCHDOG_TOKEN_FILE}>"`
    );
    process.exit(1);
  }

  console.log('POST /restart ...');
  try {
    const body = await watchdogHttp('POST', '/restart');
    console.log(`watchdog acknowledged: ${JSON.stringify(body)}`);
  } catch (err) {
    console.error(`restart failed: ${err.message}`);
    process.exit(1);
  }

  // /restart returns once the old child is dead, but the respawn is a separate
  // async hop (child 'exit' → onChildExit → spawnChild). Poll until a
  // *different* pid is running.
  const deadline = Date.now() + RESTART_TIMEOUT_MS;
  let after = null;
  while (Date.now() < deadline) {
    syncSleep(RESTART_POLL_MS);
    try {
      after = await watchdogHttp('GET', '/status');
    } catch {
      continue; // watchdog briefly busy; keep polling
    }
    if (after.state === 'circuit_broken') {
      console.error(`ERROR: the new build tripped the crash breaker: ${JSON.stringify(after)}`);
      process.exit(1);
    }
    if (after.state === 'running' && after.child_pid && after.child_pid !== oldPid) {
      console.log(`OK: child ${oldPid} -> ${after.child_pid}, uptime ${after.child_uptime_s}s`);
      console.log(
        `watchdog uptime ${after.watchdog_uptime_s}s — wrapper and watchdog were NOT restarted.`
      );
      process.exit(0);
    }
  }

  console.error(`ERROR: no new child within ${RESTART_TIMEOUT_MS}ms. Last status: ${JSON.stringify(after)}`);
  console.error(`Check ${path.join(LOG_DIR, 'watchdog-v2.log')}`);
  process.exit(1);
}

async function pause() {
  console.log('Sending pause to watchdog-v2 (HTTP /pause)...');
  try {
    const body = await watchdogHttp('POST', '/pause');
    console.log('paused:', JSON.stringify(body));
    process.exit(0);
  } catch (err) {
    console.error(`pause failed: ${err.message}`);
    process.exit(1);
  }
}

async function resume() {
  console.log('Sending resume to watchdog-v2 (HTTP /resume)...');
  try {
    const body = await watchdogHttp('POST', '/resume');
    console.log('resumed:', JSON.stringify(body));
    process.exit(0);
  } catch (err) {
    console.error(`resume failed: ${err.message}`);
    process.exit(1);
  }
}

// Atomic reinstall: stop the service, uninstall, install fresh, start. This
// is the deployment entry point — it swaps the wrapper's `script` field (which
// is captured at install time in the wrapper XML) without leaving a stale
// window where the SCM has no service. Done as a single command so the user
// doesn't have to chain `stop && uninstall && install && start` manually.
async function reinstall() {
  console.log('=== reinstall ===');
  console.log('Step 1/4: stopping service (this kills the wrapper → main.js chain)...');
  try {
    execSync(`sc.exe stop "${SCM_SERVICE_NAME}"`, { stdio: 'inherit' });
  } catch {
    // 1060 = not installed yet (first install) — that's fine.
  }
  // Wait for STATE:1 STOPPED (not just STOP_PENDING). The wrapper process
  // may keep the .exe file handle open for several seconds after the service
  // starts stopping — if we rush into uninstall we'll hit EPERM/EBUSY on
  // scripts\daemon\wechatclaudecodebridge.exe and the install will fail.
  console.log('Waiting for service to reach STOPPED (max 30s)...');
  let stopped = false;
  for (let i = 0; i < 30; i++) {
    try {
      const out = execSync(`sc.exe query "${SCM_SERVICE_NAME}"`, { encoding: 'utf8' });
      // Match the numeric state code: 1 = STOPPED. State name "STOP_PENDING"
      // has code 3 and must NOT match — we need the actual stop.
      if (/^\s*STATE\s*:\s*1\s/m.test(out)) { stopped = true; break; }
    } catch {
      // Service disappeared from SCM — also a valid stop signal.
      stopped = true;
      break;
    }
    syncSleep(1000);
  }
  if (!stopped) {
    console.warn('Service did not reach STOPPED in 30s; proceeding anyway.');
  } else {
    // Extra grace period so SCM fully releases the wrapper .exe file handle.
    // Empirically: 2s is enough on this host, but 3s is safer.
    console.log('Service STOPPED. Waiting 3s for SCM to release file handles...');
    syncSleep(3000);
  }

  console.log('Step 2/4: uninstalling old wrapper...');
  try {
    await uninstallInternal();
  } catch (err) {
    console.warn(`uninstall step: ${err.message} (continuing)`);
  }

  // One-time cleanup of the old watchdog.cjs SCM service from prior installs.
  // It is no longer needed — watchdog-v2 replaces it. Safe to run repeatedly
  // (idempotent: does nothing if not installed).
  try {
    if (isInstalledInScm(WATCHDOG_SCM_NAME)) {
      console.log('Removing obsolete watchdog.cjs SCM service...');
      execSync(`sc.exe stop "${WATCHDOG_SCM_NAME}"`, { stdio: 'ignore' });
      execSync(`sc.exe delete "${WATCHDOG_SCM_NAME}"`, { stdio: 'ignore' });
    }
  } catch {
    // Best-effort cleanup; don't block the main reinstall.
  }

  console.log('Step 3/4: installing new wrapper (points at scripts/watchdog-v2.cjs)...');
  install();
}

// Internal uninstall that returns a Promise. Used by reinstall() to chain
// stop→uninstall→install in a single process without overlapping async events.
function uninstallInternal() {
  return new Promise((resolve, reject) => {
    if (!isInstalledInScm(SCM_SERVICE_NAME)) {
      if (hasStaleLocalFiles(DAEMON_DIR, 'wechatclaudecodebridge')) {
        removeStaleLocalFiles(DAEMON_DIR);
      }
      resolve();
      return;
    }
    const svc = buildService();
    let resolved = false;
    const finish = (err) => {
      if (resolved) return;
      resolved = true;
      if (err) reject(err); else resolve();
    };
    svc.on('error', (err) => {
      const msg = err && err.message ? err.message : String(err);
      console.error(`uninstall error: ${msg}`);
      finish(new Error(msg));
    });
    svc.on('uninstall', () => {
      console.log('Uninstalled old wrapper.');
      finish();
    });
    svc.uninstall();
  });
}

function scStart(scmName, friendlyName) {
  if (!isInstalledInScm(scmName)) {
    console.error(`Service '${friendlyName}' is not installed.`);
    process.exit(1);
  }
  // Direct sc.exe start. Bypasses node-windows's `svc.start()` because once
  // the wrapper's maxRetries is exhausted it won't auto-respawn, but SCM
  // still accepts sc.exe start. Going direct sidesteps that failure-counter
  // trap. Also avoids the false 'not installed' short-circuit that svc.exists
  // does when local files are present but SCM is empty.
  console.log(`Starting service '${friendlyName}'...`);
  try {
    execSync(`sc.exe start "${scmName}"`, { stdio: 'ignore' });
  } catch {
    // sc.exe start returns non-zero if the service is already running; ignore.
  }
  let running = false;
  for (let i = 0; i < 30; i++) {
    try {
      const out = execSync(`sc.exe query "${scmName}"`, { encoding: 'utf8' });
      if (/RUNNING/.test(out)) { running = true; break; }
    } catch {
      // transient; keep polling
    }
    syncSleep(500);
  }
  if (!running) {
    console.error(`Service did not reach RUNNING state in time; manual check recommended.`);
    process.exit(1);
  }
  console.log(`Started service '${friendlyName}'.`);
  process.exit(0);
}

// Synchronous ~500ms sleep without shelling out. Replaces `ping -n 2 >nul`
// which PowerShell ISE mis-parses (and which crashes the child process,
// taking the helper script down with it).
function syncSleep(ms) {
  const sab = new SharedArrayBuffer(4);
  const i32 = new Int32Array(sab);
  Atomics.wait(i32, 0, 0, ms);
}

// --- Dispatcher ------------------------------------------------------------

const actions = {
  install,
  uninstall,
  start,
  stop,
  reinstall,
  restart,
  pause,
  resume,
  'install-watchdog': installWatchdog,
  'uninstall-watchdog': uninstallWatchdog,
  'start-watchdog': startWatchdog,
  'stop-watchdog': stopWatchdog,
};

const cmd = process.argv[2];
if (!actions[cmd]) {
  console.error(`Usage: windows-service.cjs {install|uninstall|start|stop|reinstall|restart|pause|resume|install-watchdog|uninstall-watchdog|start-watchdog|stop-watchdog}`);
  console.error('Run via: npm run daemon -- <subcommand>');
  process.exit(1);
}
actions[cmd]();