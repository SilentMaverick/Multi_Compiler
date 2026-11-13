'use strict';

/**
 * Process launcher.
 *
 * Preferred path is native/bin/jobrunner.exe, which puts the child in a Windows
 * Job Object: kernel-enforced memory cap, whole-tree teardown, and reporting of
 * peak memory. If that helper is unavailable (non-Windows, or not built yet) we
 * fall back to plain spawn + a timeout that kills the tree.
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HELPER = path.join(ROOT, 'native', 'bin', 'jobrunner.exe');
const OUT_CAP = 512 * 1024; // per stream

function pathKey(env) {
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
}

function withPath(env, dirs) {
  if (!dirs || !dirs.length) return env;
  const key = pathKey(env);
  const sep = path.delimiter;
  return { ...env, [key]: [...dirs, env[key] || ''].filter(Boolean).join(sep) };
}

function cap(text) {
  if (typeof text !== 'string') return { text: '', truncated: false };
  if (text.length <= OUT_CAP) return { text, truncated: false };
  return { text: text.slice(0, OUT_CAP), truncated: true };
}

function readIf(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function helperAvailable() {
  try {
    return fs.statSync(HELPER).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.command
 * @param {string[]} opts.args
 * @param {string} opts.cwd
 * @param {string} [opts.stdin]
 * @param {number} opts.timeoutMs
 * @param {number} [opts.memoryBytes]   0 = unlimited
 * @param {boolean} [opts.hardMemory]   enforce with the kernel rather than advisory
 * @param {object} opts.env
 * @param {string} opts.scratch        dir for in/out/err/result files
 */
async function run(opts) {
  if (process.platform === 'win32' && helperAvailable()) {
    try {
      return await runWithHelper(opts);
    } catch (err) {
      const fallback = await runFallback(opts);
      fallback.error = `job-object helper failed (${err.message}); used fallback launcher`;
      return fallback;
    }
  }
  return runFallback(opts);
}

async function runWithHelper(opts) {
  const { command, args, cwd, stdin, timeoutMs, memoryBytes, hardMemory, env, scratch } = opts;
  const inFile = path.join(scratch, 'stdin.txt');
  const outFile = path.join(scratch, 'stdout.txt');
  const errFile = path.join(scratch, 'stderr.txt');
  const resultFile = path.join(scratch, 'result.json');

  fs.writeFileSync(inFile, stdin || '', 'utf8');
  for (const f of [outFile, errFile, resultFile]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }

  const helperArgs = [
    '--timeout', String(Math.max(1, Math.round(timeoutMs))),
    '--mem', String(memoryBytes || 0),
    '--stdin', inFile,
    '--stdout', outFile,
    '--stderr', errFile,
    '--result', resultFile,
    '--cwd', cwd,
  ];
  if (hardMemory) helperArgs.push('--mem-hard');
  helperArgs.push('--', command, ...args);

  await new Promise((resolve, reject) => {
    // env matters: the MinGW bin dir has to be on PATH so the child can find
    // libstdc++-6.dll / libwinpthread-1.dll.
    const child = spawn(HELPER, helperArgs, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env,
    });
    let errBuf = '';
    child.stderr.on('data', (d) => {
      if (errBuf.length < 8192) errBuf += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && !fs.existsSync(resultFile)) {
        reject(new Error(`helper exited ${code}: ${errBuf.trim()}`));
      } else resolve();
    });
  });

  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  } catch {
    meta = {};
  }

  const out = cap(readIf(outFile));
  const err = cap(readIf(errFile));

  for (const f of [inFile, outFile, errFile, resultFile]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }

  return {
    stdout: out.text,
    stderr: err.text,
    stdoutTruncated: out.truncated,
    stderrTruncated: err.truncated,
    exitCode: meta.exitCode ?? -1,
    timedOut: Boolean(meta.timedOut),
    memoryExceeded: Boolean(meta.memoryExceeded),
    peakMemoryBytes: typeof meta.peakMemoryBytes === 'number' ? meta.peakMemoryBytes : null,
    wallMs: typeof meta.wallMs === 'number' ? meta.wallMs : 0,
    error: meta.error || null,
    launcher: 'jobobject',
  };
}

function runFallback(opts) {
  const { command, args, cwd, stdin, timeoutMs, env } = opts;
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    let child;
    try {
      child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({
        stdout: '',
        stderr: '',
        exitCode: -1,
        timedOut: false,
        memoryExceeded: false,
        peakMemoryBytes: null,
        wallMs: 0,
        error: err.message,
        launcher: 'fallback',
      });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, Math.max(1, timeoutMs));

    child.stdout.on('data', (d) => {
      if (stdout.length < OUT_CAP) stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < OUT_CAP) stderr += d.toString();
    });

    if (stdin) child.stdin.write(stdin);
    child.stdin.end();

    const finish = (code, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        stdoutTruncated: stdout.length >= OUT_CAP,
        stderrTruncated: stderr.length >= OUT_CAP,
        exitCode: timedOut ? -1 : code ?? -1,
        timedOut,
        memoryExceeded: false,
        peakMemoryBytes: null,
        wallMs: Date.now() - started,
        error: err || null,
        launcher: 'fallback',
      });
    };

    child.on('error', (err) => finish(-1, err.message));
    child.on('close', (code) => finish(code));
  });
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

module.exports = { run, helperAvailable, withPath, cap, HELPER };
