'use strict';

/**
 * Java debugging (#2, Java half), driven through `jdb`.
 *
 * Unlike gdb's MI, jdb is a plain REPL: it prints a prompt (`> ` before the VM
 * starts, `main[1] ` while stopped) and has no request tokens. So every command is
 * a write followed by "wait for the prompt to come back", and the transcript
 * between two prompts is parsed for the interesting bits.
 *
 * The state shape returned here is identical to the gdb path's, so the UI does not
 * care which debugger is behind it.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CMD_TIMEOUT_MS = 25000;

const PROMPT = /(?:^|\n)\s*(?:[\w-]+\[\d+\]|>)\s*$/;
const STOP_LINE = /"thread=[^"]+",\s*([\w.$]+)\.([\w$<>]+)\(\),\s*line=(\d+)/;
const FRAME_LINE = /^\s*\[\d+\]\s+([\w.$]+)\.([\w$<>]+)\s+\(([^:()]+):(\d+)\)/;
const VAR_LINE = /^\s*([A-Za-z_$][\w$]*)\s*=\s*(.*)$/;

class JdbSession {
  constructor(proc, dir) {
    this.kind = 'jdb';
    this.proc = proc;
    this.dir = dir;
    this.log = '';
    this.pending = null;
    this.status = 'starting';
    this.exitCode = null;
    this.breakpoints = [];
    this.location = null;
    this.lastOutput = '';

    proc.stdout.on('data', (d) => this.onData(d.toString('utf8')));
    proc.stderr.on('data', (d) => this.onData(d.toString('utf8')));
    proc.on('close', (code) => {
      this.status = 'exited';
      this.exitCode = code;
      this.resolvePrompt();
    });
  }

  onData(chunk) {
    this.log += chunk;
    if (this.log.length > 400000) this.log = this.log.slice(-200000);
    this.resolvePrompt();
  }

  resolvePrompt() {
    if (!this.pending) return;
    // Only output produced *after* the command started counts; otherwise the
    // prompt left over from the previous command resolves this one instantly.
    const segment = this.log.slice(this.pending.from);
    const exited = /The application exited|VM disconnected|application exited/i.test(segment);
    if (exited || PROMPT.test(segment)) {
      const { resolve } = this.pending;
      this.pending = null;
      resolve();
    }
  }

  waitForPrompt(timeoutMs = CMD_TIMEOUT_MS, from = 0) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error('jdb did not answer'));
      }, timeoutMs);
      this.pending = {
        from,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      this.resolvePrompt();
    });
  }

  /** Send one command; resolves with the transcript it produced. */
  async send(cmd, timeoutMs) {
    const from = this.log.length;
    this.proc.stdin.write(`${cmd}\n`);
    await this.waitForPrompt(timeoutMs, from);
    return this.log.slice(from);
  }

  /**
   * For resume/step commands the first prompt after the write is *not* the stop:
   * jdb returns control while the VM boots, then prints the breakpoint later. So
   * wait for the stopped prompt (`main[N] `) or an exit message instead.
   */
  async sendStop(cmd, timeoutMs = 40000) {
    const from = this.log.length;
    this.proc.stdin.write(`${cmd}\n`);
    const deadline = Date.now() + timeoutMs;
    let segment = '';
    do {
      await new Promise((r) => setTimeout(r, 50));
      segment = this.log.slice(from);
      if (/The application exited|application exited|VM disconnected/i.test(segment)) break;
      if (/main\[\d+\]\s*$/.test(segment)) break;
    } while (Date.now() < deadline);
    return segment;
  }
}

function clean(text) {
  return String(text)
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^(>|[\w-]+\[\d+\])$/.test(l))
    .join('\n');
}

function parseLocation(segment) {
  const m = STOP_LINE.exec(segment);
  if (!m) return null;
  return { class: m[1], func: m[2], line: Number(m[3]) };
}

function parseFrames(segment, fallbackFile) {
  const frames = [];
  for (const line of segment.split('\n')) {
    const m = FRAME_LINE.exec(line);
    if (!m) continue;
    frames.push({
      level: frames.length,
      func: m[2],
      file: m[3].trim() || fallbackFile,
      line: Number(m[4]),
    });
  }
  return frames;
}

function parseLocals(segment) {
  const variables = [];
  const lines = segment.split('\n');
  let inLocals = false;

  for (const line of lines) {
    if (/^Method arguments:/.test(line) || /^Local variables:/.test(line)) {
      inLocals = true;
      continue;
    }
    if (!inLocals) continue;
    const m = VAR_LINE.exec(line);
    if (!m) continue;
    const name = m[1];
    let raw = m[2].trim();
    if (/^instance of /.test(raw)) {
      const typeMatch = /^instance of ([\w.$]+)\[(\d+)\]/.exec(raw);
      variables.push({
        name,
        type: typeMatch ? `${typeMatch[1]}[]` : raw.replace(/^instance of /, '').replace(/\s*\(id=\d+\)$/, ''),
        value: typeMatch ? `array[${typeMatch[2]}]` : null,
        isArray: Boolean(typeMatch),
        length: typeMatch ? Number(typeMatch[2]) : 0,
      });
      continue;
    }
    if (/ = /.test(raw)) raw = raw.slice(raw.lastIndexOf(' = ') + 3).trim();
    variables.push({ name, type: '', value: raw, isArray: false, length: 0 });
  }
  return variables;
}

/** `dump arr` prints the elements across several lines, wrapped in braces. */
function parseDump(name, segment) {
  const start = segment.indexOf('{');
  const end = segment.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const inner = segment.slice(start + 1, end).replace(/\r/g, '');
  const values = inner
    .split(',')
    .map((v) => v.replace(/\s+/g, ' ').trim())
    .filter((v) => v !== '')
    .slice(0, 48);
  if (!values.length) return null;
  return { name, kind: 'array', length: values.length, values };
}

async function collectState(session, note) {
  const state = {
    kind: 'jdb',
    id: null,
    status: session.status,
    output: '',
    location: null,
    frames: [],
    variables: [],
    arrays: [],
    breakpoints: session.breakpoints,
    exitCode: session.exitCode,
    message: note || null,
  };

  if (session.status === 'exited') return state;

  try {
    const where = clean(await session.send('where'));
    state.frames = parseFrames(where, null);

    const loc = session.location;
    if (loc) {
      state.location = {
        file: (state.frames[0] && state.frames[0].file) || loc.file || null,
        line: loc.line,
        func: loc.func,
      };
      // keep the frame list aligned with the stop location
      if (state.frames.length) {
        state.frames[0].line = loc.line;
      }
    }

    const localsSeg = clean(await session.send('locals'));
    const raw = parseLocals(localsSeg);

    for (const v of raw) {
      state.variables.push({ name: v.name, type: v.type || '', value: v.isArray ? null : v.value });
      if (v.isArray && v.length > 0) {
        try {
          const dumped = await session.send(`dump ${v.name}`);
          const parsed = parseDump(v.name, dumped);
          if (parsed) state.arrays.push(parsed);
        } catch {
          /* unreadable array */
        }
      }
    }
  } catch {
    /* the VM may have ended mid-command */
  }

  return state;
}

async function start({ jdbBin, classesDir, mainClass, breakpoints, sourceFile }) {
  const proc = spawn(jdbBin || 'jdb', ['-classpath', classesDir, mainClass], {
    env: { ...process.env, LANG: 'C' },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const session = new JdbSession(proc, classesDir);
  session.mainClass = mainClass;
  session.sourceFile = sourceFile || `${mainClass}.java`;

  proc.on('error', (err) => {
    session.log += `\n[jdb] ${err.message}\n`;
    session.status = 'exited';
  });

  try {
    await session.waitForPrompt(CMD_TIMEOUT_MS);
  } catch (err) {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    throw new Error(`jdb did not start: ${err.message}`);
  }

  for (const bp of breakpoints || []) {
    const file = path.basename(String(bp.file || sourceFile || ''));
    const cls = file.replace(/\.java$/i, '');
    const line = Number(bp.line);
    if (!file || !Number.isFinite(line)) continue;
    await session.send(`stop at ${cls}:${line}`);
    session.breakpoints.push({ file, line });
  }

  const runSegment = await session.sendStop('run', 45000);
  const loc = parseLocation(runSegment);
  if (loc) {
    session.status = 'paused';
    session.location = { ...loc, file: `${loc.class}.java` };
  } else if (/The application exited|application exited/i.test(runSegment)) {
    session.status = 'exited';
    session.exitCode = 0;
  } else {
    // no breakpoint hit: it either finished or failed to start
    session.status = /VM start exception|Fatal error/i.test(runSegment) ? 'exited' : 'paused';
  }

  const state = await collectState(session, 'stopped at start');
  return { session, state };
}

async function command(session, action, options = {}) {
  if (session.status === 'exited') return collectState(session, 'program has exited');

  const commands = { next: 'next', step: 'step', finish: 'step up', continue: 'cont' };

  if (commands[action]) {
    const segment = await session.sendStop(commands[action], 45000);
    const loc = parseLocation(segment);

    if (/The application exited|application exited/i.test(segment)) {
      session.status = 'exited';
      session.exitCode = 0;
    } else if (loc) {
      session.status = 'paused';
      session.location = { ...loc, file: `${loc.class}.java` };
    } else if (/Breakpoint hit/i.test(segment)) {
      session.status = 'paused';
    }
    return collectState(session, action);
  }

  if (action === 'breakpoint-add') {
    const file = path.basename(String(options.file || ''));
    const line = Number(options.line);
    const cls = file.replace(/\.java$/i, '');
    const segment = await session.send(`stop at ${cls}:${line}`);
    if (!/error/i.test(segment)) session.breakpoints.push({ file, line });
    return collectState(session, 'breakpoint added');
  }

  if (action === 'breakpoint-remove') {
    const bp = session.breakpoints.find((b) => b.line === Number(options.line) && (!options.file || b.file === path.basename(String(options.file))));
    if (bp) {
      await session.send(`clear ${bp.file.replace(/\.java$/i, '')}:${bp.line}`);
      session.breakpoints = session.breakpoints.filter((b) => b !== bp);
    }
    return collectState(session);
  }

  if (action === 'frame') {
    await session.send(`up ${Math.max(0, Number(options.level) || 0)}`);
    return collectState(session, `frame ${Number(options.level) || 0}`);
  }

  if (action === 'evaluate') {
    const expr = String(options.expr || '').slice(0, 500);
    if (!expr.trim()) throw new Error('Nothing to evaluate.');
    const segment = await session.send(`print ${expr}`);
    const state = await collectState(session, `evaluate ${expr}`);
    const line = segment
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.includes('=') && !/^\[/.test(l));
    state.evaluation = {
      expr,
      value: line ? line.slice(line.indexOf('=') + 1).trim() : null,
      error: /error|exception/i.test(segment) && !line ? segment.trim().slice(0, 200) : null,
    };
    return state;
  }

  return collectState(session, action);
}

function dispose(session) {
  try {
    session.proc.stdin.write('quit\n');
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      session.proc.kill();
    } catch {
      /* ignore */
    }
  }, 300).unref?.();
  try {
    fs.rmSync(session.dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

module.exports = { start, command, dispose, collectState, parseLocals, parseDump };
