'use strict';

/**
 * Stress testing (#3).
 *
 * The classic competitive-programming loop: generate random cases, solve them
 * with a slow-but-obvious reference, and compare against the fast solution until
 * they disagree. The IDE then shows the exact counterexample.
 *
 * Three programs are compiled once and executed many times:
 *   generator  reads a seed on stdin, prints one test case
 *   solution   the program being checked
 *   reference  reads a test case, prints the expected answer
 */

const fs = require('fs');

const executor = require('./executor');
const toolchains = require('./toolchains');
const { run, withPath } = require('./runner');

const MAX_ITERATIONS = 200;
const DEFAULT_ITERATIONS = 25;

function cleanup(...programs) {
  for (const p of programs) {
    if (!p || !p.dir) continue;
    try {
      fs.rmSync(p.dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

function normalize(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

async function prepare(files, language, label) {
  if (!Array.isArray(files) || !files.length) {
    throw new executor.HttpError(400, `${label} has no files.`);
  }
  const prepared = await executor.execute({ files, language }, { compileOnly: true, keepArtifacts: true });
  if (!prepared.compile || !prepared.compile.ok) {
    const dir = prepared.meta && prepared.meta.launch && prepared.meta.launch.dir;
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    const err = new executor.HttpError(400, `${label} does not compile.`);
    err.compile = prepared.compile || null;
    err.label = label;
    throw err;
  }
  return {
    label,
    dir: prepared.meta.launch.dir,
    launch: prepared.meta.launch,
    language: prepared.language,
  };
}

function execProgram(program, input, limits, env, scratch) {
  return run({
    command: program.launch.command,
    args: program.launch.args,
    cwd: program.launch.dir,
    stdin: input,
    timeoutMs: limits.timeMs,
    memoryBytes: 0,
    hardMemory: false,
    env,
    scratch,
  });
}

async function stress(body) {
  const iterations = clamp(body && body.iterations, 1, MAX_ITERATIONS, DEFAULT_ITERATIONS);
  const limits = {
    timeMs: clamp(body && body.limits && body.limits.timeMs, 100, 30000, 5000),
    memoryMB: clamp(body && body.limits && body.limits.memoryMB, 16, 4096, 256),
    compileTimeMs: 60000,
  };

  const requested = body && body.language && body.language !== 'auto' ? body.language : 'auto';

  let solution = null;
  let generator = null;
  let reference = null;
  try {
    solution = await prepare(body.solution && body.solution.files, requested, 'Solution');
    const lang = solution.language;
    generator = await prepare(body.generator && body.generator.files, lang, 'Generator');
    reference = await prepare(body.reference && body.reference.files, lang, 'Reference');

    const tc = await toolchains.detect();
    const env = withPath({ ...process.env, LANG: 'C', LC_ALL: 'C' }, tc.runtimePathDirs);
    const scratch = solution.dir;

    let ran = 0;
    let counterexample = null;

    for (let seed = 1; seed <= iterations; seed++) {
      const gen = await execProgram(generator, String(seed), limits, env, scratch);
      if (gen.exitCode !== 0 || gen.timedOut) {
        counterexample = {
          seed,
          stage: 'generator',
          input: null,
          expected: null,
          actual: null,
          stderr: gen.stderr,
          message: gen.timedOut ? 'the generator timed out' : `the generator exited ${gen.exitCode}`,
        };
        break;
      }

      const input = gen.stdout;
      const got = await execProgram(solution, input, limits, env, scratch);
      const want = await execProgram(reference, input, limits, env, scratch);
      ran++;

      const same = normalize(got.stdout) === normalize(want.stdout);
      if (!same || got.exitCode !== 0 || got.timedOut) {
        counterexample = {
          seed,
          stage: got.timedOut ? 'solution-timeout' : got.exitCode !== 0 ? 'solution-crash' : 'mismatch',
          input,
          expected: want.stdout,
          actual: got.stdout,
          exitCode: got.exitCode,
          stderr: got.stderr,
          message: got.timedOut
            ? 'the solution timed out'
            : got.exitCode !== 0
              ? `the solution exited ${got.exitCode}`
              : 'outputs differ',
        };
        break;
      }
    }

    return {
      ok: true,
      language: solution.language,
      iterations,
      ran,
      verdict: counterexample ? 'FAIL' : 'PASS',
      counterexample,
      limits,
    };
  } finally {
    cleanup(solution, generator, reference);
  }
}

module.exports = { stress, MAX_ITERATIONS, DEFAULT_ITERATIONS };
