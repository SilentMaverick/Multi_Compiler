'use strict';

/**
 * Compiler output -> structured diagnostics.
 *
 * g++  : main.cpp:10:5: error: 'x' was not declared in this scope
 * javac: Main.java:10: error: ';' expected
 *
 * The raw text is always kept so nothing is lost, but the UI gets file/line/col,
 * severity, a subject line, plus javac's multi-line "symbol/location" detail
 * blocks and any linker diagnostics.
 */

const path = require('path');

const MAX_DIAGNOSTICS = 200;

const SEVERITY = {
  'fatal error': 'error',
  error: 'error',
  warning: 'warning',
  note: 'info',
  info: 'info',
};

function normalizeName(p, workDir, known) {
  if (!p) return '';
  let name = String(p).replace(/\\/g, '/');

  // Absolute (or drive-rooted) paths come back from #include chains; map them
  // onto the project's own file list by basename before falling back.
  if (/^[A-Za-z]:\//.test(name) || name.startsWith('/')) {
    try {
      const rel = path.relative(workDir, name.replace(/\//g, path.sep));
      if (rel && !rel.startsWith('..') && known && known.has(rel.replace(/\\/g, '/'))) {
        return rel.replace(/\\/g, '/');
      }
    } catch {
      /* fall through */
    }
  }

  if (known) {
    const base = name.split('/').pop();
    if (known.has(base)) return base;
  }

  if (name.startsWith('/') || /^[A-Za-z]:\//.test(name)) return name.split('/').pop();
  return name;
}

/** Split a compiler's text output into candidate diagnostic blocks. */
function explodeLines(raw) {
  return String(raw || '')
    .replace(/\r\n/g, '\n')
    .split('\n');
}

// main.cpp:10:5: error: message
// Accepts drive-letter paths (C:\src\main.cpp:10:5:) as well as relative ones.
const GCC_RE = /^(?<file>[A-Za-z]:[\\/][^:\n]*|[^:\n]+?):(?<line>\d+):(?:(?<col>\d+):)?\s*(?<sev>fatal error|error|warning|note):\s*(?<msg>.*)$/;

// Main.java:10: error: message
const JAVAC_RE = /^(?<file>[A-Za-z]:[\\/][^:\n]*\.java|[^:\n]+?\.java):(?<line>\d+):\s*(?<sev>error|warning):\s*(?<msg>.*)$/;

// error: something failed (global, no file)
const BARE_RE = /^(?<sev>error|warning):\s*(?<msg>.*)$/;

// ld.exe: main.o:main.cpp:(.text+0x1a): undefined reference to `foo()'
const LINKER_RE = /^(?<file>[^\s:][^:]*?):(?<obj>[^:]*):(?<ref>\([^)]*\)):\s*(?<msg>undefined reference.*|multiple definition.*)$/;

function isNoise(line) {
  const t = line.trim();
  if (!t) return false;
  if (/^\d+ (error|warning)s?$/.test(t)) return false; // "2 errors" - useful, keep
  return (
    /^In file included from/.test(t) ||
    /^collect2(\.exe)?:/.test(t) ||
    /^\s*\|/.test(t) ||
    /^\s*\^+\s*$/.test(t) ||
    /^Note: /.test(t) ||
    /^Note:\s/.test(t)
  );
}

/**
 * @param {string} raw         combined compiler stdout+stderr
 * @param {object} opts        { workDir, sources: Map<name, content>, language }
 * @returns {{diagnostics: Array, errors: number, warnings: number}}
 */
function parse(raw, opts = {}) {
  const workDir = opts.workDir || process.cwd();
  const sources = opts.sources || new Map();
  const known = new Set(sources.keys());
  const lines = explodeLines(raw);

  const diagnostics = [];
  const seen = new Set();
  let current = null;

  const flush = () => {
    if (!current) return;
    const key = `${current.file}:${current.line}:${current.col}:${current.severity}:${current.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      diagnostics.push(current);
    }
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    let m = GCC_RE.exec(line) || JAVAC_RE.exec(line);
    if (m) {
      flush();
      const g = m.groups;
      const fileName = normalizeName(g.file, workDir, known);
      const lineNo = Number(g.line);
      const col = g.col ? Number(g.col) : 0;
      const severity = SEVERITY[g.sev] || 'error';
      const src = sources.get(fileName);
      current = {
        file: fileName,
        line: lineNo,
        col,
        severity,
        message: g.msg.trim(),
        source: src ? (src.split(/\r?\n/)[lineNo - 1] ?? '').replace(/\t/g, '    ').replace(/\s+$/, '') : null,
        details: [],
      };
      // javac continuation lines ("symbol:", "location:") belong to this diagnostic.
      // gcc also echoes the source line and a caret ruler, which we re-render from
      // the real source, so those are skipped rather than duplicated.
      let j = i + 1;
      while (j < lines.length && j - i <= 8) {
        const nxt = lines[j];
        if (!nxt.trim()) break;
        if (GCC_RE.test(nxt) || JAVAC_RE.test(nxt)) break;
        const trimmed = nxt.trim();
        // Skip the compiler's echo of the offending source line (both gcc and javac
        // print it) and the caret ruler under it - the UI re-renders those itself.
        const sourceTrim = current.source ? current.source.trim() : null;
        const isEcho =
          /^\d+\s*\|/.test(trimmed) ||
          /^\|/.test(trimmed) ||
          /^\^+$/.test(trimmed) ||
          (sourceTrim !== null && trimmed === sourceTrim);
        if (isEcho) {
          j++;
          continue;
        }
        if (/^(symbol|location|required|found|reason|note):/i.test(trimmed) || /^\s{2,}\S/.test(nxt)) {
          current.details.push(trimmed);
          j++;
          continue;
        }
        break;
      }
      i = j - 1;
      continue;
    }

    m = LINKER_RE.exec(line);
    if (m) {
      flush();
      const g = m.groups;
      diagnostics.push({
        file: normalizeName(g.file, workDir, known),
        line: 0,
        col: 0,
        severity: 'error',
        message: `${g.msg.trim()} (${g.obj.trim()})`,
        source: null,
        details: [],
        linker: true,
      });
      continue;
    }

    m = BARE_RE.exec(line);
    if (m) {
      const msg = m.groups.msg.trim();
      // "collect2: error: ld returned 1 exit status" is a consequence, not a cause.
      if (/ld returned/.test(msg)) continue;
      if (current) current.details.push(`${m.groups.sev}: ${msg}`);
      else
        diagnostics.push({
          file: '',
          line: 0,
          col: 0,
          severity: SEVERITY[m.groups.sev] || 'error',
          message: msg,
          source: null,
          details: [],
        });
      continue;
    }

    if (current && !isNoise(line) && /^\s+\S/.test(line)) {
      // indented follow-up of a javac/gcc message
      const d = line.trim();
      if (!/^\^+\s*$/.test(d)) current.details.push(d);
      continue;
    }

    if (/^\d+ (error|warning)s?$/.test(line.trim())) {
      // trailing summary; ignore
      continue;
    }

    if (current && !isNoise(line)) current.details.push(line.trim());
  }
  flush();

  // Errors first: when a build fails, the reason should be the first thing shown,
  // not an incidental warning that happens to sit on an earlier line.
  const rank = { error: 0, warning: 1, info: 2 };
  diagnostics.sort((a, b) => {
    const ra = rank[a.severity] ?? 3;
    const rb = rank[b.severity] ?? 3;
    if (ra !== rb) return ra - rb;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.line - b.line;
  });

  const trimmed = diagnostics.slice(0, MAX_DIAGNOSTICS);
  return {
    diagnostics: trimmed,
    truncated: diagnostics.length > trimmed.length,
    errors: diagnostics.filter((d) => d.severity === 'error').length,
    warnings: diagnostics.filter((d) => d.severity === 'warning').length,
  };
}

module.exports = { parse, normalizeName, MAX_DIAGNOSTICS };
