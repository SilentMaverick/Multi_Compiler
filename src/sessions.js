'use strict';

/**
 * Interactive sessions (#7).
 *
 * A normal run is batch: stdin is written up front, the process is waited on.
 * That cannot serve programs that prompt and wait for a reply. A session keeps
 * the process alive and streams output as it appears, so the UI can behave like
 * a terminal: type a line, press Enter, see the reply.
 *
 * Output is pushed over Server-Sent Events and input arrives by POST, which
 * keeps the server dependency-free (no WebSocket handshake to hand-roll).
 *
 * Tradeoff: sessions run under a plain spawn with a hard tree-kill, so they get
 * the time limit but not the kernel memory cap the job object provides.
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const executor = require('./executor');
const toolchains = require('./toolchains');
const { withPath } = require('./runner');

const MAX_SESSIONS = 3;
const MAX_LIFETIME_MS = 180000;
const MAX_BUFFER_BYTES = 200 * 1024;
const CLEANUP_DELAY_MS = 60000;
const PTY_HELPER = require('path').join(__dirname, '..', 'native', 'bin', 'ptyhost.exe');

const sessions = new Map();

let counter = 0;
function nextId() {
  counter += 1;
  return `s${Date.now().toString(36)}${counter.toString(36)}`;
}

class Session {
  constructor({ id, proc, dir }) {
    this.id = id;
    this.proc = proc;
    this.dir = dir;
    this.subs = new Set();
    this.buffer = [];
    this.buffered = 0;
    this.closed = false;
    this.exitCode = null;
    this.signal = null;
    this.startedAt = Date.now();
    this.lifetimeTimer = null;
    this.cleanupTimer = null;
  }

  emit(event) {
    if (event.t === 'o' || event.t === 'e') {
      this.buffered += event.d.length;
      this.buffer.push(event);
      while (this.buffered > MAX_BUFFER_BYTES && this.buffer.length > 1) {
        const dropped = this.buffer.shift();
        this.buffered -= dropped.d.length;
      }
    }
    for (const fn of this.subs) {
      try {
        fn(event);
      } catch {
        /* a dead subscriber must not break the session */
      }
    }
  }

  subscribe(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  write(data) {
    if (this.closed || !this.proc.stdin.writable) return false;
    try {
      this.proc.stdin.write(data);
      return true;
    } catch {
      return false;
    }
  }

  kill() {
    if (this.closed) return;
    killTree(this.proc.pid);
  }

  dispose() {
    if (this.lifetimeTimer) clearTimeout(this.lifetimeTimer);
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }
}

/** Compile the program, then keep it running with pipes attached. */
async function start(body) {
  const live = [...sessions.values()].filter((s) => !s.closed);
  if (live.length >= MAX_SESSIONS) {
    throw new executor.HttpError(429, `Too many live sessions (${MAX_SESSIONS}). Stop one first.`);
  }

  // compileOnly keeps the build directory so the process can run from it.
  const prepared = await executor.execute(body, { compileOnly: true, keepArtifacts: true });
  if (!prepared.compile || !prepared.compile.ok) {
    cleanupDir(prepared.meta && prepared.meta.launch && prepared.meta.launch.dir);
    return { ok: false, compile: prepared.compile || null, error: 'Compilation failed.' };
  }

  const launch = prepared.meta.launch;
  const tc = await toolchains.detect();
  const env = withPath({ ...process.env, LANG: 'C', LC_ALL: 'C' }, tc.runtimePathDirs);

  // A pseudo console gives the program a real terminal: echo, line editing and
  // ANSI colour. Without it stdin is a plain pipe and prompts never appear.
  const ptyAvailable = process.platform === 'win32' && fs.existsSync(PTY_HELPER);
  const usePty = Boolean(body.pty) && ptyAvailable;

  let command = launch.command;
  let args = launch.args;
  if (usePty) {
    command = PTY_HELPER;
    args = [
      '--cwd', launch.dir,
      '--cols', String(Number(body.cols) > 0 ? Math.min(400, Number(body.cols)) : 120),
      '--rows', String(Number(body.rows) > 0 ? Math.min(200, Number(body.rows)) : 32),
      '--timeout', String(MAX_LIFETIME_MS),
      '--', launch.command, ...launch.args,
    ];
  }

  const id = nextId();
  let proc;
  try {
    proc = spawn(command, args, {
      cwd: launch.dir,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    cleanupDir(launch.dir);
    throw new executor.HttpError(500, `Could not start the program: ${err.message}`);
  }

  const session = new Session({ id, proc, dir: launch.dir });
  sessions.set(id, session);

  proc.stdout.on('data', (chunk) => session.emit({ t: 'o', d: chunk.toString('utf8') }));
  proc.stderr.on('data', (chunk) => session.emit({ t: 'e', d: chunk.toString('utf8') }));

  proc.on('error', (err) => {
    session.emit({ t: 'e', d: `\n[launcher] ${err.message}\n` });
  });

  proc.on('close', (code, signal) => {
    session.closed = true;
    session.exitCode = code;
    session.signal = signal;
    if (session.lifetimeTimer) clearTimeout(session.lifetimeTimer);
    session.emit({ t: 'x', code, signal });
    session.cleanupTimer = setTimeout(() => {
      sessions.delete(id);
      session.dispose();
    }, CLEANUP_DELAY_MS);
    session.cleanupTimer.unref?.();
  });

  session.lifetimeTimer = setTimeout(() => {
    session.emit({ t: 'e', d: `\n[session] lifetime limit (${MAX_LIFETIME_MS / 1000}s) reached - stopping.\n` });
    session.kill();
  }, MAX_LIFETIME_MS);
  session.lifetimeTimer.unref?.();

  return {
    ok: true,
    sessionId: id,
    pty: usePty,
    compile: {
      ok: true,
      cached: prepared.compile.cached,
      ms: prepared.compile.ms,
      warnings: prepared.compile.warnings,
      errors: prepared.compile.errors,
      diagnostics: prepared.compile.diagnostics,
    },
    language: prepared.language,
    limits: prepared.limits,
    maxLifetimeMs: MAX_LIFETIME_MS,
  };
}

function get(id) {
  return sessions.get(id) || null;
}

function stop(id) {
  const session = sessions.get(id);
  if (!session) return false;
  session.kill();
  return true;
}

function input(id, data) {
  const session = sessions.get(id);
  if (!session) return false;
  return session.write(data);
}

function list() {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    closed: s.closed,
    startedAt: s.startedAt,
    exitCode: s.exitCode,
  }));
}

function cleanupDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Shut every session down (server exit). */
function shutdown() {
  for (const s of sessions.values()) {
    try {
      killTree(s.proc.pid);
    } catch {
      /* ignore */
    }
    s.dispose();
  }
  sessions.clear();
}

module.exports = { start, get, stop, input, list, shutdown, MAX_SESSIONS, MAX_LIFETIME_MS };
