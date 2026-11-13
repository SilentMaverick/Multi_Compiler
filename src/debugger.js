'use strict';

/**
 * Step debugger (#2) for C and C++, driven through gdb's machine interface.
 *
 * gdb is already shipped with the MinGW toolchain, and `--interpreter=mi2` gives
 * a stable line protocol: `^done`/`^error` replies are matched to commands by a
 * numeric token, while `*stopped` events arrive asynchronously. Each UI command is
 * a request/response pair, so the front-end just polls state after every step
 * instead of holding a stream open.
 *
 * Java is not supported here: its equivalent (jdb/JDWP) is a different protocol
 * and is deliberately out of scope for this version.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const executor = require('./executor');
const toolchains = require('./toolchains');
const { withPath } = require('./runner');

const MAX_SESSIONS = 2;
const CMD_TIMEOUT_MS = 20000;
const LIFETIME_MS = 10 * 60 * 1000;

const sessions = new Map();
let counter = 0;

// ---------------------------------------------------------------- MI parsing

/** Decode a C-style escaped string body (without the surrounding quotes). */
function decodeCString(body) {
  return body.replace(/\\(.)/g, (m, c) => {
    const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', "'": "'", 0: '\0' };
    return map[c] !== undefined ? map[c] : c;
  });
}

/** Parse the `key=value,...` tail of an MI record into a plain object. */
function parseMiResults(text) {
  let i = 0;

  function parseString() {
    i++; // opening quote
    let out = '';
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') {
        out += text[i] + (text[i + 1] || '');
        i += 2;
      } else {
        out += text[i];
        i++;
      }
    }
    i++;
    return decodeCString(out);
  }

  function parseBare() {
    const start = i;
    while (i < text.length && text[i] !== ',' && text[i] !== '}' && text[i] !== ']') i++;
    // never leave the cursor where it was: that would spin the caller forever
    if (i === start && i < text.length) i++;
    return text.slice(start, i);
  }

  function parseValue() {
    const c = text[i];
    if (c === '"') return parseString();
    if (c === '{') return parseTuple();
    if (c === '[') return parseList();
    return parseBare();
  }

  function parseTuple() {
    i++; // {
    const obj = {};
    while (i < text.length && text[i] !== '}') {
      if (text[i] === ',') {
        i++;
        continue;
      }
      const before = i;
      const eq = text.indexOf('=', i);
      if (eq < 0) break;
      const key = text.slice(i, eq);
      i = eq + 1;
      obj[key] = parseValue();
      if (i === before) i++;
    }
    if (text[i] === '}') i++;
    return obj;
  }

  // A list may hold plain values, tuples, or "result" pairs like frame={...}.
  function parseElement() {
    const c = text[i];
    if (c === '{') return parseTuple();
    if (c === '[') return parseList();
    if (c === '"') return parseString();

    const eq = text.indexOf('=', i);
    if (eq >= 0) {
      const stops = [text.indexOf(',', i), text.indexOf(']', i), text.indexOf('}', i)].filter((n) => n >= 0);
      const stop = stops.length ? Math.min(...stops) : text.length;
      if (eq < stop) {
        const key = text.slice(i, eq);
        if (/^[A-Za-z_][\w-]*$/.test(key)) {
          i = eq + 1;
          return { [key]: parseValue() };
        }
      }
    }
    return parseBare();
  }

  function parseList() {
    i++; // [
    const arr = [];
    let guard = 0;
    while (i < text.length && text[i] !== ']') {
      if (text[i] === ',') {
        i++;
        continue;
      }
      const before = i;
      arr.push(parseElement());
      if (i === before) i++;
      if (++guard > 100000) break;
    }
    if (text[i] === ']') i++;
    return arr;
  }

  const out = {};
  let guard = 0;
  while (i < text.length) {
    if (text[i] === ',') {
      i++;
      continue;
    }
    const before = i;
    const eq = text.indexOf('=', i);
    if (eq < 0) break;
    const key = text.slice(i, eq);
    i = eq + 1;
    out[key] = parseValue();
    if (i === before) i++;
    if (++guard > 100000) break;
  }
  return out;
}

// Inferior output shares gdb's console stream, so drop gdb's own chatter.
const CONSOLE_NOISE = [
  /^\[New Thread/i,
  /^\[Thread .* exited/i,
  /^\[Inferior .* (exited|process)/i,
  /^\[Switching to Thread/i,
  /^Breakpoint \d+[ ,]/,
  /^Temporary breakpoint/,
  /^Reading symbols/,
  /^\d+\t/,
  /^\[.*exited with code/i,
];

function isNoise(line) {
  return CONSOLE_NOISE.some((re) => re.test(line));
}

// ---------------------------------------------------------------- gdb process

class GdbSession {
  constructor(id, proc, dir) {
    this.id = id;
    this.proc = proc;
    this.dir = dir;
    this.buf = '';
    this.token = 0;
    this.tokenWaiters = new Map();
    this.stops = [];
    this.stopWaiter = null;
    this.console = '';
    this.status = 'starting';
    this.exitCode = null;
    this.breakpoints = [];
    this.lastState = null;
    this.lifetime = null;
  }

  _write(cmd) {
    this.proc.stdin.write(`${cmd}\n`);
  }

  send(cmd) {
    const token = ++this.token;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.tokenWaiters.delete(token);
        reject(new Error(`gdb did not answer "${cmd}"`));
      }, CMD_TIMEOUT_MS);
      this.tokenWaiters.set(token, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
      this._write(`${token}${cmd}`);
    });
  }

  waitStop(timeoutMs = CMD_TIMEOUT_MS) {
    if (this.stops.length) return Promise.resolve(this.stops.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stopWaiter = null;
        reject(new Error('gdb did not stop'));
      }, timeoutMs);
      this.stopWaiter = (ev) => {
        clearTimeout(timer);
        resolve(ev);
      };
    });
  }

  _handleLine(rawLine) {
    const line = rawLine.replace(/\r$/, '');
    if (!line || line === '(gdb)' || line.startsWith('(gdb) ')) return;

    const m = /^(\d*)([\^*=+~@&])(.*)$/.exec(line);
    if (!m) {
      // Not an MI record: the inferior inherits gdb's stdout, so this is the
      // program's own output arriving raw.
      this.console += `${line}\n`;
      if (this.console.length > 200000) this.console = this.console.slice(-200000);
      return;
    }

    const token = m[1] ? Number(m[1]) : null;
    const kind = m[2];
    const body = m[3];

    if (kind === '~' || kind === '&') {
      if (body.startsWith('"')) {
        const text = decodeCString(body.slice(1, body.lastIndexOf('"')));
        if (kind === '~') {
          this.console += text;
          // a chatty program must not grow this without bound
          if (this.console.length > 200000) this.console = this.console.slice(-200000);
          if (this.onConsole) this.onConsole(text);
        }
      }
      return;
    }

    const commaAt = body.indexOf(',');
    const cls = commaAt < 0 ? body : body.slice(0, commaAt);
    const results = commaAt < 0 ? {} : parseMiResults(body.slice(commaAt));

    if (kind === '^') {
      const waiter = this.tokenWaiters.get(token);
      if (waiter) {
        this.tokenWaiters.delete(token);
        waiter({ cls, results });
      }
      return;
    }

    if (kind === '*') {
      if (cls === 'stopped') {
        const ev = { cls, results };
        if (this.stopWaiter) {
          const fn = this.stopWaiter;
          this.stopWaiter = null;
          fn(ev);
        } else {
          this.stops.push(ev);
        }
      }
    }
  }

  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      this._handleLine(line);
    }
  }

  /** Program output since the last drain, with gdb's own lines removed. */
  drainOutput() {
    const text = this.console;
    this.console = '';
    return text
      .split('\n')
      .filter((l) => !isNoise(l))
      .join('\n');
  }

  dispose() {
    if (this.lifetime) clearTimeout(this.lifetime);
    try {
      this._write('-gdb-exit');
    } catch {
      /* ignore */
    }
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    sessions.delete(this.id);
  }
}

// ---------------------------------------------------------------- state

/**
 * Turn gdb's printed form into cells the UI can draw.
 *   {3, 1, 4}                                        -> array
 *   std::vector of length 4, capacity 4 = {10, 20}   -> array
 *   {{1, 2}, {3, 4}}                                 -> matrix
 *   "hello"                                          -> string
 */
function parsePrintable(name, printed) {
  if (printed == null) return null;
  const text = String(printed).replace(/^=\s*/, '').trim();
  if (!text) return null;

  if (/^".*"$/.test(text)) {
    const inner = text.slice(1, -1).replace(/\\"/g, '"');
    const chars = Array.from(inner).slice(0, 48);
    return { name, kind: 'string', length: Array.from(inner).length, values: chars };
  }

  // Every innermost brace group is one row; a single group means a 1-D array.
  // This copes with both raw arrays and pretty-printed nested std::vectors,
  // where rows read "std::vector of length 2, capacity 2 = {1, 2}".
  const groups = [];
  const re = /\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(text)) !== null) groups.push(m[1].trim());
  if (!groups.length) return null;

  const splitCells = (row) =>
    row
      .split(',')
      .map((v) => v.trim().replace(/^"|"$/g, ''))
      .filter((v) => v !== '');

  if (groups.length === 1) {
    const values = splitCells(groups[0]).slice(0, 48);
    const lenMatch = /length (\d+)/.exec(text);
    return { name, kind: 'array', length: lenMatch ? Number(lenMatch[1]) : values.length, values };
  }

  const rows = groups.map((g) => splitCells(g).slice(0, 48));
  const width = Math.max(...rows.map((r) => r.length));
  return { name, kind: 'matrix', length: rows.length, width, values: rows };
}

async function collectArrays(session, variables) {
  const candidates = (variables || [])
    .filter((v) => /\[|vector|string|array/i.test(v.type || '') && /^[A-Za-z_]\w*$/.test(v.name))
    .slice(0, 4);

  const arrays = [];
  for (const v of candidates) {
    try {
      const res = await session.send(`-data-evaluate-expression ${JSON.stringify(v.name)}`);
      if (res.cls !== 'done') continue;
      const parsed = parsePrintable(v.name, String(res.results.value || ''));
      if (parsed) arrays.push(parsed);
    } catch {
      /* a variable may vanish between stops */
    }
  }
  return arrays;
}

function frameFrom(f) {
  return {
    level: Number(f.level || 0),
    func: f.func || '?',
    file: f.file ? path.basename(String(f.file).replace(/\\/g, '/')) : null,
    line: f.line ? Number(f.line) : null,
  };
}

async function collectState(session, note) {
  // gdb can report the stop before the last console bytes are flushed, so give
  // the stream a moment - more when the program has just exited.
  await new Promise((r) => setTimeout(r, session.status === 'exited' ? 140 : 20));

  const state = {
    id: session.id,
    status: session.status,
    output: session.drainOutput(),
    location: null,
    frames: [],
    variables: [],
    breakpoints: session.breakpoints,
    exitCode: session.exitCode,
    message: note || null,
  };

  if (session.status === 'exited') return state;

  try {
    const frames = await session.send('-stack-list-frames');
    const stack = frames.results.stack || [];
    state.frames = stack.map((el) => frameFrom(el && el.frame ? el.frame : el));
    state.location = state.frames[0] || null;
  } catch {
    /* not running */
  }

  try {
    const vars = await session.send('-stack-list-variables --simple-values');
    state.variables = (vars.results.variables || []).map((v) => ({
      name: v.name,
      type: v.type || '',
      value: v.value === undefined ? null : String(v.value),
    }));
  } catch {
    /* no frame */
  }

  // Data worth drawing: arrays, vectors and strings in this frame.
  try {
    state.arrays = session.status === 'exited' ? [] : await collectArrays(session, state.variables);
  } catch {
    state.arrays = [];
  }

  session.lastState = state;
  return state;
}

// ---------------------------------------------------------------- lifecycle

function applyStop(session, ev) {
  const reason = ev.results.reason;
  if (reason === 'exited-normally' || reason === 'exited') {
    session.status = 'exited';
    session.exitCode = ev.results['exit-code'] !== undefined ? Number(ev.results['exit-code']) : reason === 'exited-normally' ? 0 : null;
    return;
  }
  if (reason === 'signal-received') {
    session.status = 'exited';
    session.exitCode = null;
    return;
  }
  session.status = 'paused';
}

async function start(body) {
  const live = [...sessions.values()].filter((s) => s.status !== 'exited');
  if (live.length >= MAX_SESSIONS) throw new executor.HttpError(429, 'Too many debug sessions. Stop one first.');

  // NOTE: `body.language && body.language !== 'auto'` evaluates to a *boolean*,
  // not the string - so this has to be a conditional expression.
  const language = typeof body.language === 'string' && body.language !== 'auto' ? body.language : null;
  const requested = language || executor.detectLanguage(body.files || [], 'auto');
  if (requested === 'java') {
    throw new executor.HttpError(400, 'Debugging currently supports C and C++ only. Java runs use the Run button.');
  }
  if (requested === 'python' || requested === 'javascript') {
    throw new executor.HttpError(400, 'Debugging currently supports C and C++ only.');
  }

  const prepared = await executor.execute(
    { ...body, language: requested },
    { compileOnly: true, keepArtifacts: true, debugBuild: true }
  );
  if (!prepared.compile || !prepared.compile.ok) {
    const dir = prepared.meta && prepared.meta.launch && prepared.meta.launch.dir;
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    return { ok: false, compile: prepared.compile || null, error: 'Compilation failed.' };
  }

  const exe = prepared.meta.artifact;
  const dir = prepared.meta.launch.dir;
  const tc = await toolchains.detect();
  const gdb = path.join(path.dirname(tc.cpp.compiler || ''), process.platform === 'win32' ? 'gdb.exe' : 'gdb');
  if (!fs.existsSync(gdb)) {
    return { ok: false, error: 'gdb was not found next to the C++ compiler.' };
  }

  const env = withPath({ ...process.env, LANG: 'C' }, tc.runtimePathDirs);
  const proc = spawn(gdb, ['--interpreter=mi2', '-q', '--args', exe], {
    cwd: dir,
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  counter += 1;
  const id = `d${Date.now().toString(36)}${counter.toString(36)}`;
  const session = new GdbSession(id, proc, dir);
  sessions.set(id, session);

  proc.stdout.on('data', (d) => session._onData(d.toString('utf8')));
  proc.stderr.on('data', (d) => session._onData(d.toString('utf8')));
  proc.on('close', () => {
    if (session.status !== 'exited') {
      session.status = 'exited';
    }
  });

  session.lifetime = setTimeout(() => session.dispose(), LIFETIME_MS);
  session.lifetime.unref?.();

  // Handshake: this reply proves the interpreter is listening.
  await new Promise((r) => setTimeout(r, 700));
  try {
    await session.send('-gdb-set confirm off');
    await session.send('-gdb-set pagination off');
  } catch (err) {
    session.dispose();
    throw new executor.HttpError(500, `gdb did not start: ${err.message}`);
  }

  const requested_breaks = Array.isArray(body.breakpoints) ? body.breakpoints.slice(0, 50) : [];
  for (const bp of requested_breaks) {
    const file = path.basename(String(bp.file || ''));
    const line = Number(bp.line);
    if (!file || !Number.isFinite(line) || line < 1) continue;
    try {
      const res = await session.send(`-break-insert ${file}:${line}`);
      if (res.cls === 'done' && res.results.bkpt) {
        session.breakpoints.push({
          id: Number(res.results.bkpt.number),
          file,
          line,
        });
      }
    } catch {
      /* a bad location should not abort debugging */
    }
  }

  const stopPromise = session.waitStop();
  await session.send('-exec-run');
  const stop = await stopPromise;
  applyStop(session, stop);

  const state = await collectState(session, 'stopped at start');
  return {
    ok: true,
    sessionId: id,
    language: requested,
    compile: {
      ok: true,
      ms: prepared.compile.ms,
      warnings: prepared.compile.warnings,
      diagnostics: prepared.compile.diagnostics,
    },
    state,
  };
}

/** Run one debugger action and return the resulting state. */
async function command(id, action, options = {}) {
  const session = sessions.get(id);
  if (!session) throw new executor.HttpError(404, 'That debug session has ended.');
  if (session.status === 'exited' && action !== 'evaluate') {
    return collectState(session, 'program has exited');
  }

  const stepMap = {
    next: '-exec-next',
    step: '-exec-step',
    finish: '-exec-finish',
    continue: '-exec-continue',
  };

  if (stepMap[action]) {
    const stop = session.waitStop();
    await session.send(stepMap[action]);
    const ev = await stop;
    applyStop(session, ev);
    return collectState(session, ev.results.reason || null);
  }

  if (action === 'breakpoint-add') {
    const file = path.basename(String(options.file || ''));
    const line = Number(options.line);
    if (!file || !Number.isFinite(line)) throw new executor.HttpError(400, 'A breakpoint needs a file and a line.');
    const res = await session.send(`-break-insert ${file}:${line}`);
    if (res.cls === 'done' && res.results.bkpt) {
      session.breakpoints.push({ id: Number(res.results.bkpt.number), file, line });
    }
    return collectState(session);
  }

  if (action === 'breakpoint-remove') {
    const res = await session.send(`-break-delete ${Number(options.bpId)}`);
    if (res.cls === 'done') {
      session.breakpoints = session.breakpoints.filter((b) => b.id !== Number(options.bpId));
    }
    return collectState(session);
  }

  if (action === 'frame') {
    await session.send(`-stack-select-frame ${Number(options.level) || 0}`);
    return collectState(session, `frame ${Number(options.level) || 0}`);
  }

  if (action === 'evaluate') {
    const expr = String(options.expr || '').slice(0, 500);
    if (!expr.trim()) throw new executor.HttpError(400, 'Nothing to evaluate.');
    const res = await session.send(`-data-evaluate-expression ${JSON.stringify(expr)}`);
    const state = await collectState(session, `evaluate ${expr}`);
    state.evaluation = {
      expr,
      value: res.cls === 'done' ? String(res.results.value) : null,
      error: res.cls === 'error' ? String(res.results.msg || 'error') : null,
    };
    return state;
  }

  if (action === 'state') return collectState(session);

  throw new executor.HttpError(400, `Unknown debug action "${action}".`);
}

function stop(id) {
  const session = sessions.get(id);
  if (!session) return false;
  session.dispose();
  return true;
}

function list() {
  return [...sessions.values()].map((s) => ({ id: s.id, status: s.status }));
}

function shutdown() {
  for (const s of [...sessions.values()]) {
    try {
      s.dispose();
    } catch {
      /* ignore */
    }
  }
  sessions.clear();
}

module.exports = { start, command, stop, list, shutdown, parseMiResults, parsePrintable, MAX_SESSIONS };
