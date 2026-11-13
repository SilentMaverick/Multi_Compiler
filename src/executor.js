'use strict';

/**
 * Compile + run orchestration for the supported languages.
 *
 * One request produces:
 *   - a compile phase (with parsed diagnostics)
 *   - one or more executions (a single run with user stdin, or N test cases)
 */

const fs = require('fs');
const path = require('path');
const { run, withPath } = require('./runner');
const diagnostics = require('./diagnostics');
const toolchains = require('./toolchains');

const ROOT = path.resolve(__dirname, '..');
const BUILD_ROOT = path.join(ROOT, '.build');

const DEFAULT_LIMITS = {
  timeMs: 5000,
  memoryMB: 256,
  compileTimeMs: 60000,
};

const MAX_FILES = 64;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_TESTS = 50;

const EXT = {
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.c++': 'cpp',
  '.c': 'c',
  '.java': 'java',
};
const HEADERS = new Set(['.h', '.hpp', '.hh', '.hxx']);

// ---------------------------------------------------------------- validation

function safeFileName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 96) return null;
  if (trimmed.includes('..') || /[\\/:*?"<>|]/.test(trimmed)) return null;
  if (!/^[A-Za-z0-9_.\- ()+]+$/.test(trimmed)) return null;
  if (!/^[A-Za-z0-9_]/.test(trimmed)) return null;
  return trimmed;
}

function validateRequest(body) {
  const rawFiles = Array.isArray(body?.files) ? body.files : [];
  if (!rawFiles.length) throw new HttpError(400, 'No source files supplied.');
  if (rawFiles.length > MAX_FILES) throw new HttpError(400, `Too many files (max ${MAX_FILES}).`);

  const files = [];
  const seen = new Set();
  let total = 0;
  for (const f of rawFiles) {
    const name = safeFileName(f?.name);
    if (!name) throw new HttpError(400, `Invalid file name: ${JSON.stringify(f?.name)}`);
    const lower = name.toLowerCase();
    if (seen.has(lower)) throw new HttpError(400, `Duplicate file name: ${name}`);
    seen.add(lower);
    const content = typeof f?.content === 'string' ? f.content : '';
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_FILE_BYTES) throw new HttpError(400, `${name} is larger than ${MAX_FILE_BYTES / 1024} KB.`);
    total += bytes;
    files.push({ name, content });
  }
  if (total > MAX_TOTAL_BYTES) throw new HttpError(400, 'Total source size exceeds 1 MB.');

  const ext = path.extname(files[0].name).toLowerCase();
  if (!EXT[ext.toLowerCase()] && !HEADERS.has(ext)) {
    throw new HttpError(400, `Unsupported file type "${ext}". Use .cpp, .cc, .cxx, .c or .java.`);
  }

  const stdin = typeof body?.stdin === 'string' ? body.stdin.slice(0, 512 * 1024) : '';
  const limits = {
    timeMs: clampInt(body?.limits?.timeMs, 100, 30000, DEFAULT_LIMITS.timeMs),
    memoryMB: clampInt(body?.limits?.memoryMB, 16, 4096, DEFAULT_LIMITS.memoryMB),
    compileTimeMs: DEFAULT_LIMITS.compileTimeMs,
  };

  const tests = Array.isArray(body?.tests)
    ? body.tests.slice(0, MAX_TESTS).map((t) => ({
        input: typeof t?.input === 'string' ? t.input.slice(0, 256 * 1024) : '',
        expected: typeof t?.expected === 'string' ? t.expected.slice(0, 256 * 1024) : '',
      }))
    : [];

  return { files, stdin, limits, tests, requestedLanguage: body?.language };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- detection

function detectLanguage(files, requested) {
  if (requested && requested !== 'auto') {
    if (!['cpp', 'c', 'java'].includes(requested)) throw new HttpError(400, `Unknown language "${requested}".`);
    return requested;
  }
  const kinds = new Set();
  for (const f of files) {
    const kind = EXT[path.extname(f.name).toLowerCase()];
    if (kind) kinds.add(kind);
  }
  if (!kinds.size) throw new HttpError(400, 'Cannot detect a language from the file extensions.');
  if (kinds.size > 1) {
    throw new HttpError(
      400,
      `Mixed languages (${[...kinds].join(', ')}) cannot be compiled together. Pick one language.`
    );
  }
  return [...kinds][0];
}

function javaMainClass(files) {
  const candidates = [];
  for (const f of files) {
    if (path.extname(f.name).toLowerCase() !== '.java') continue;
    const base = path.basename(f.name, path.extname(f.name));
    const hasMain = /static\s+(?:public\s+)?void\s+main\s*\(|(?:public\s+)?static\s+void\s+main\s*\(/.test(f.content);
    const declares = new RegExp(`\\b(?:class|enum|record|interface)\\s+${escapeRe(base)}\\b`).test(f.content);
    if (hasMain) candidates.push({ name: base, score: declares ? 3 : 2 });
    else if (declares) candidates.push({ name: base, score: 1 });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.length ? candidates[0].name : null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------- compile

function cppPlan({ language, files, dir, tc }) {
  const sources = files
    .map((f) => f.name)
    .filter((n) => {
      const e = path.extname(n).toLowerCase();
      return language === 'c' ? e === '.c' : ['.cpp', '.cc', '.cxx', '.c++'].includes(e);
    });
  if (!sources.length)
    throw new HttpError(
      400,
      `No ${language === 'c' ? 'C' : 'C++'} source files found. Files present: ${files.map((f) => f.name).join(', ')}.`
    );

  const compiler = language === 'c' ? tc.c.compiler || tc.cpp.compiler : tc.cpp.compiler;
  if (!compiler) throw new HttpError(503, `${language === 'c' ? 'gcc' : 'g++'} not found. Run: npm run setup`);

  const exe = path.join(dir, process.platform === 'win32' ? 'main.exe' : 'main.out');
  const isC = language === 'c';
  // If only a C++ driver is available we can still honour C mode with -x c.
  const needsXc = isC && !tc.c.compiler;
  const args = [
    isC ? '-std=c17' : '-std=c++17',
    ...(needsXc ? ['-x', 'c'] : []),
    '-O2',
    '-pipe',
    '-Wall',
    '-Wextra',
    // Static runtime: the produced binary then runs anywhere, with no dependency
    // on libstdc++-6.dll / libwinpthread-1.dll being on PATH.
    '-static',
    '-fdiagnostics-color=never',
    '-fmessage-length=0',
    '-I', dir,
    '-o', exe,
    ...sources,
  ];
  return { command: compiler, args, artifact: exe, sourceNames: sources };
}

function javaPlan({ files, dir, tc }) {
  if (!tc.java.javac) throw new HttpError(503, 'javac not found. Run: npm run setup');
  const sources = files.map((f) => f.name).filter((n) => path.extname(n).toLowerCase() === '.java');
  if (!sources.length) throw new HttpError(400, 'No .java source files to compile.');
  const classesDir = path.join(dir, 'classes');
  fs.mkdirSync(classesDir, { recursive: true });
  const mainClass = javaMainClass(files);
  const args = [
    '-encoding', 'UTF-8',
    '-d', classesDir,
    '-J-Duser.language=en',
    '-J-Duser.country=US',
    '-Xlint:-options',
    ...sources,
  ];
  return { command: tc.java.javac, args, classesDir, mainClass, sourceNames: sources };
}

// ---------------------------------------------------------------- compare

function normalizeOutput(s) {
  return String(s || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

function firstDiff(expected, actual) {
  const e = normalizeOutput(expected).split('\n');
  const a = normalizeOutput(actual).split('\n');
  const n = Math.max(e.length, a.length);
  for (let i = 0; i < n; i++) {
    if ((e[i] ?? '') !== (a[i] ?? '')) {
      return { line: i + 1, expected: e[i] ?? null, actual: a[i] ?? null };
    }
  }
  return null;
}

function verdictOf(result, expected, hasExpected) {
  const stderr = String(result.stderr || '');
  const oom = /OutOfMemoryError|std::bad_alloc|bad allocation|Cannot allocate memory/i.test(stderr);
  if (result.timedOut) return 'TLE';
  if (result.memoryExceeded) return 'MLE';
  if (oom && result.exitCode !== 0) return 'MLE';
  if (result.error) return 'RE';
  if (result.exitCode !== 0) return 'RE';
  if (!hasExpected) return 'OK';
  return normalizeOutput(result.stdout) === normalizeOutput(expected) ? 'AC' : 'WA';
}

// ---------------------------------------------------------------- execute

async function execute(body, ctx = {}) {
  const { files, stdin, limits, tests, requestedLanguage } = validateRequest(body);
  const language = detectLanguage(files, requestedLanguage);

  const tc = await toolchains.detect();
  const startedAt = Date.now();

  const runId = `run-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  fs.mkdirSync(BUILD_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(BUILD_ROOT, runId));
  const scratch = path.join(dir, '_scratch');
  fs.mkdirSync(scratch, { recursive: true });

  const sources = new Map();
  for (const f of files) {
    const target = path.join(dir, f.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.content, 'utf8');
    sources.set(f.name, f.content);
  }

  const env = { ...process.env, LANG: 'C', LC_ALL: 'C', PYTHONIOENCODING: 'utf-8' };
  const runtimeEnv = withPath(env, tc.runtimePathDirs);

  const response = {
    ok: true,
    runId,
    language,
    limits,
    compile: null,
    run: null,
    tests: [],
    meta: { durationMs: 0 },
  };

  try {
    const plan = language === 'java' ? javaPlan({ files, dir, tc }) : cppPlan({ language, files, dir, tc });

    const compileResult = await run({
      command: plan.command,
      args: plan.args,
      cwd: dir,
      stdin: '',
      timeoutMs: limits.compileTimeMs,
      memoryBytes: 0,
      env: runtimeEnv,
      scratch,
    });

    const raw = `${compileResult.stdout}${compileResult.stderr}`;
    const parsed = diagnostics.parse(raw, { workDir: dir, sources, language });
    const compileOk = compileResult.exitCode === 0 && !compileResult.timedOut;

    response.compile = {
      ok: compileOk,
      ms: compileResult.wallMs,
      command: [plan.command, ...plan.args].join(' '),
      raw,
      truncated: Boolean(compileResult.stdoutTruncated || compileResult.stderrTruncated),
      errors: parsed.errors,
      warnings: parsed.warnings,
      diagnostics: parsed.diagnostics,
      truncatedDiagnostics: parsed.truncated,
      timedOut: compileResult.timedOut,
    };

    if (!compileOk) {
      response.ok = false;
      if (!parsed.errors && !compileResult.timedOut) {
        response.compile.diagnostics = [
          {
            file: '',
            line: 0,
            col: 0,
            severity: 'error',
            message: raw.trim().split('\n').slice(-3).join(' ') || 'Compilation failed.',
            source: null,
            details: [],
          },
        ];
      }
      return response;
    }

    // ------------------------------------------------------------ run phase
    let command;
    let args;
    let memoryBytes = 0;
    let hardMemory = false;

    if (language === 'java') {
      if (!plan.mainClass) {
        response.ok = false;
        response.run = {
          verdict: 'RE',
          stdout: '',
          stderr:
            'No class with `public static void main(String[] args)` was found.\n' +
            'Add one, and make sure the file name matches the public class name.',
          exitCode: -1,
          wallMs: 0,
          peakMemoryBytes: 0,
          timedOut: false,
          memoryExceeded: false,
          error: 'no main class',
        };
        return response;
      }
      // The JVM needs room for metaspace/code on top of the heap, so the heap cap
      // is the user-visible limit and the job object only acts as a backstop.
      const heapMB = Math.max(16, Math.floor(limits.memoryMB * 0.8));
      memoryBytes = limits.memoryMB * 1024 * 1024 * 4;
      hardMemory = false;
      command = tc.java.java;
      args = [
        `-Xmx${heapMB}m`,
        '-Xss8m',
        '-XX:+UseSerialGC',
        '-Dfile.encoding=UTF-8',
        '-Dstdout.encoding=UTF-8',
        '-Dstderr.encoding=UTF-8',
        '-cp', plan.classesDir,
        plan.mainClass,
      ];
      response.meta.mainClass = plan.mainClass;
      response.meta.heapMB = heapMB;
    } else {
      memoryBytes = limits.memoryMB * 1024 * 1024;
      hardMemory = true;
      command = plan.artifact;
      args = [];
    }

    const execOne = async (input) => {
      const result = await run({
        command,
        args,
        cwd: dir,
        stdin: input || '',
        timeoutMs: limits.timeMs,
        memoryBytes,
        hardMemory,
        env: runtimeEnv,
        scratch,
      });
      return result;
    };

    if (tests.length) {
      for (let i = 0; i < tests.length; i++) {
        const t = tests[i];
        const result = await execOne(t.input);
        const hasExpected = typeof t.expected === 'string' && t.expected.length > 0;
        response.tests.push({
          index: i + 1,
          verdict: verdictOf(result, t.expected, hasExpected),
          input: t.input,
          expected: t.expected,
          actual: result.stdout,
          stderr: result.stderr,
          stdoutTruncated: Boolean(result.stdoutTruncated),
          exitCode: result.exitCode,
          ms: result.wallMs,
          peakMemoryBytes: result.peakMemoryBytes,
          timedOut: result.timedOut,
          memoryExceeded: result.memoryExceeded,
          diff: hasExpected ? firstDiff(t.expected, result.stdout) : null,
          error: result.error || null,
        });
      }
      const passed = response.tests.filter((t) => t.verdict === 'AC' || t.verdict === 'OK').length;
      response.testsSummary = { total: response.tests.length, passed, failed: response.tests.length - passed };
      response.ok = passed === response.tests.length;
    } else {
      const result = await execOne(stdin);
      response.run = {
        verdict: verdictOf(result, '', false),
        stdout: result.stdout,
        stderr: result.stderr,
        stdoutTruncated: Boolean(result.stdoutTruncated),
        stderrTruncated: Boolean(result.stderrTruncated),
        exitCode: result.exitCode,
        ms: result.wallMs,
        peakMemoryBytes: result.peakMemoryBytes,
        timedOut: result.timedOut,
        memoryExceeded: result.memoryExceeded,
        launcher: result.launcher,
        error: result.error || null,
      };
      response.ok = response.run.verdict === 'OK';
    }

    return response;
  } finally {
    response.meta.durationMs = Date.now() - startedAt;
    if (!ctx.keepArtifacts) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

module.exports = {
  execute,
  HttpError,
  DEFAULT_LIMITS,
  normalizeOutput,
  detectLanguage,
  javaMainClass,
};
