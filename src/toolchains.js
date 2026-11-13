'use strict';

/**
 * Toolchain discovery.
 *
 * Search order for each compiler:
 *   1. explicit override (env MULTICODER_CXX / MULTICODER_JAVA_HOME)
 *   2. the portable toolchains this repo downloads into tools/
 *   3. whatever is on PATH
 *
 * Probing runs a real `--version`, so a present-but-broken binary is reported
 * as broken instead of silently failing at the first compile.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(ROOT, 'tools');

const WIN = process.platform === 'win32';
const EXE = WIN ? '.exe' : '';

function firstExisting(candidates) {
  for (const c of candidates) {
    if (!c) continue;
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function fromPath(name) {
  // No shell involved: just test the usual PATH locations ourselves.
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, name + EXE);
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function probe(bin, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (!bin) return resolve(null);
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return resolve(null);
      const text = `${stdout || ''}${stderr || ''}`.trim();
      resolve(text.split(/\r?\n/)[0] || '');
    });
  });
}

const CXX_CANDIDATES = [
  process.env.MULTICODER_CXX,
  path.join(TOOLS, 'mingw64', 'bin', `g++${EXE}`),
  path.join(TOOLS, 'mingw64', 'bin', `c++${EXE}`),
  fromPath('g++'),
  fromPath('clang++'),
];

const CC_CANDIDATES = [
  process.env.MULTICODER_CC,
  path.join(TOOLS, 'mingw64', 'bin', `gcc${EXE}`),
  fromPath('gcc'),
  fromPath('clang'),
];

const JAVA_HOME_CANDIDATES = [
  process.env.MULTICODER_JAVA_HOME,
  path.join(TOOLS, 'jdk21'),
  process.env.JAVA_HOME,
];

function javaBin(tool) {
  for (const home of JAVA_HOME_CANDIDATES) {
    if (!home) continue;
    const p = path.join(home, 'bin', `${tool}${EXE}`);
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return fromPath(tool);
}

let cache = null;
let inflight = null;

async function detect(force = false) {
  if (cache && !force) return cache;
  if (inflight && !force) return inflight;

  inflight = (async () => {
    const cxx = firstExisting(CXX_CANDIDATES);
    const cc = firstExisting(CC_CANDIDATES) || cxx;
    const javac = javaBin('javac');
    const java = javaBin('java');

    const [cxxVersion, ccVersion, javacVersion, javaVersion] = await Promise.all([
      probe(cxx, ['--version']),
      probe(cc, ['--version']),
      probe(javac, ['-version']),
      probe(java, ['-version']),
    ]);

    // A MinGW installation needs its own bin dir on PATH at run time so the
    // produced .exe can find libstdc++-6.dll / libwinpthread-1.dll.
    const runtimePathDirs = [cxx && path.dirname(cxx), javac && path.dirname(javac)].filter(Boolean);

    cache = {
      platform: process.platform,
      arch: process.arch,
      root: ROOT,
      cpp: {
        id: 'cpp',
        compiler: cxx,
        version: cxxVersion,
        ok: Boolean(cxx && cxxVersion),
        label: cxxVersion ? cxxVersion.replace(/\s*\(.*\)$/, '') : 'not found',
      },
      c: {
        id: 'c',
        compiler: cc,
        version: ccVersion,
        ok: Boolean(cc && ccVersion),
        label: ccVersion ? ccVersion.replace(/\s*\(.*\)$/, '') : 'not found',
      },
      java: {
        id: 'java',
        javac,
        java,
        version: javacVersion,
        javaVersion,
        ok: Boolean(javac && java && javacVersion),
        label: javacVersion ? `javac ${javacVersion.replace(/^javac\s*/, '')}` : 'not found',
      },
      runtimePathDirs,
      detectedAt: Date.now(),
    };
    return cache;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

function invalidate() {
  cache = null;
}

module.exports = { detect, invalidate, probe, ROOT, TOOLS };
