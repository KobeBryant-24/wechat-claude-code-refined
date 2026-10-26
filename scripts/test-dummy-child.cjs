#!/usr/bin/env node
// Dummy child for watchdog-v2 testing.
// Stays alive, prints PID periodically, exits non-zero on SIGUSR1 (for crash test).

const start = Date.now();

process.on('SIGTERM', () => {
  console.log(`[dummy ${process.pid}] SIGTERM received, exiting 0`);
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log(`[dummy ${process.pid}] SIGINT received, exiting 0`);
  process.exit(0);
});
process.on('SIGUSR1', () => {
  console.log(`[dummy ${process.pid}] SIGUSR1 received, crashing (exit 1)`);
  process.exit(1);
});
process.on('SIGHUP', () => {
  console.log(`[dummy ${process.pid}] SIGHUP received, exiting 0`);
  process.exit(0);
});

const interval = setInterval(() => {
  const uptime = Math.round((Date.now() - start) / 1000);
  console.log(`[dummy ${process.pid}] alive, uptime=${uptime}s`);
}, 1000);

console.log(`[dummy ${process.pid}] started, parent=${process.ppid}`);