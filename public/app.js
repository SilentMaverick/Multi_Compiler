'use strict';

/* Multi-Coder front-end.
 * No framework, no build step. All user-supplied text goes into the DOM via
 * textContent so a program's output can never inject markup. */

(function () {
  const STORAGE_KEY = 'multicoder.state.v1';

  const $ = (id) => document.getElementById(id);

  const els = {
    lang: $('lang'),
    chipCpp: $('chip-cpp'),
    chipJava: $('chip-java'),
    fileList: $('file-list'),
    addFile: $('btn-add-file'),
    editorHost: $('editor'),
    panel: $('panel'),
    resizer: $('resizer'),
    panelTabs: $('panel-tabs'),
    problems: $('problems'),
    problemsSummary: $('problems-summary'),
    problemsToolbar: $('problems-toolbar'),
    btnPrevProblem: $('btn-prev-problem'),
    btnNextProblem: $('btn-next-problem'),
    railTabs: $('rail-tabs'),
    outlineList: $('outline-list'),
    outlineSummary: $('outline-summary'),
    outlineFilter: $('outline-filter'),
    badgeProblems: $('badge-problems'),
    badgeTests: $('badge-tests'),
    streams: $('streams'),
    runHeader: $('run-header'),
    testList: $('test-list'),
    stdin: $('stdin'),
    run: $('btn-run'),
    runTests: $('btn-run-tests'),
    addTest: $('btn-add-test'),
    clear: $('btn-clear'),
    examplesBtn: $('btn-examples'),
    limitsBtn: $('btn-limits'),
    popLimits: $('popover-limits'),
    popExamples: $('popover-examples'),
    exampleList: $('example-list'),
    limitTime: $('limit-time'),
    limitMem: $('limit-mem'),
    statusLeft: $('status-left'),
    statusPos: $('status-pos'),
    statusLang: $('status-lang'),
    statusLauncher: $('status-launcher'),
    toast: $('toast'),
    snippetsBtn: $('btn-snippets'),
    exportBtn: $('btn-export'),
    popSnippets: $('popover-snippets'),
    popExport: $('popover-export'),
    snipName: $('snip-name'),
    snipList: $('snip-list'),
    snipSave: $('btn-snip-save'),
    snipNote: $('snip-note'),
    exportTitle: $('export-title'),
    exportNotes: $('export-notes'),
    exportHtml: $('btn-export-html'),
    exportCopy: $('btn-export-copy'),
    termStart: $('btn-term-start'),
    termStop: $('btn-term-stop'),
    termStatus: $('term-status'),
    termOut: $('term-out'),
    termForm: $('term-form'),
    termLine: $('term-line'),
    termSend: $('btn-term-send'),
    termClear: $('btn-term-clear'),
    termEcho: $('term-echo'),
  };

  const DEFAULT_CPP = `#include <iostream>
#include <string>

int main() {
    std::string name;
    if (!(std::cin >> name)) name = "world";
    std::cout << "Hello, " << name << "!\\n";
    return 0;
}
`;

  const DEFAULT_JAVA = `import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String name = sc.hasNext() ? sc.next() : "world";
        System.out.println("Hello, " + name + "!");
    }
}
`;

  const EXT_LANG = {
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.cxx': 'cpp',
    '.c++': 'cpp',
    '.c': 'c',
    '.java': 'java',
    '.h': 'cpp',
    '.hpp': 'cpp',
  };

  const MODE = {
    cpp: 'text/x-c++src',
    c: 'text/x-csrc',
    java: 'text/x-java',
  };

  let state = loadState();
  let editor = null;
  let busy = false;
  let health = null;
  let testResults = null;
  let problemsCache = [];
  let markHandles = [];
  let lastResult = null;
  const session = { id: null, source: null, running: false };

  // ------------------------------------------------------------ state

  function defaults() {
    return {
      files: [{ name: 'main.cpp', content: DEFAULT_CPP }],
      activeFile: 0,
      language: 'auto',
      stdin: '',
      tests: [{ input: '', expected: '' }],
      limits: { timeMs: 5000, memoryMB: 256 },
      panelHeight: 260,
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaults();
      const parsed = JSON.parse(raw);
      const base = defaults();
      const merged = { ...base, ...parsed };
      if (!Array.isArray(merged.files) || !merged.files.length) merged.files = base.files;
      merged.activeFile = Math.min(Math.max(0, merged.activeFile | 0), merged.files.length - 1);
      if (!Array.isArray(merged.tests)) merged.tests = base.tests;
      merged.limits = { ...base.limits, ...(merged.limits || {}) };
      return merged;
    } catch {
      return defaults();
    }
  }

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        /* quota - not fatal */
      }
    }, 300);
  }

  function currentFile() {
    return state.files[state.activeFile] || null;
  }

  function extOf(name) {
    const i = name.lastIndexOf('.');
    return i < 0 ? '' : name.slice(i).toLowerCase();
  }

  function fileLanguage(file) {
    return file ? EXT_LANG[extOf(file.name)] || null : null;
  }

  /** Language the run will actually use. */
  function effectiveLanguage() {
    if (state.language !== 'auto') return state.language;
    const kinds = new Set(state.files.map(fileLanguage).filter(Boolean));
    if (kinds.size === 1) return [...kinds][0];
    if (kinds.size > 1) return 'mixed';
    return 'cpp';
  }

  function syncActive() {
    const f = currentFile();
    if (f && editor) f.content = editor.getValue();
  }

  // ------------------------------------------------------------ editor

  function buildEditor() {
    const host = els.editorHost;
    host.textContent = '';

    if (window.CodeMirror) {
      const cm = window.CodeMirror(host, {
        value: currentFile() ? currentFile().content : '',
        mode: MODE[fileLanguage(currentFile()) || 'cpp'],
        gutters: ['mc-gutter', 'CodeMirror-linenumbers'],
        indentUnit: 4,
        tabSize: 4,
        indentWithTabs: false,
        lineWrapping: false,
        matchBrackets: true,
        styleActiveLine: true,
        viewportMargin: 30,
        extraKeys: {
          Tab: (instance) => instance.replaceSelection('    ', 'end'),
          'Ctrl-Enter': () => run(false),
          'Cmd-Enter': () => run(false),
          'Shift-Ctrl-Enter': () => run(true),
          'Shift-Cmd-Enter': () => run(true),
        },
      });
      cm.on('change', () => {
        syncActive();
        save();
        scheduleOutline();
      });
      cm.on('cursorActivity', () => {
        const pos = cm.getCursor();
        els.statusPos.textContent = `Ln ${pos.line + 1}, Col ${pos.ch + 1}`;
      });
      editor = {
        kind: 'cm',
        cm,
        getValue: () => cm.getValue(),
        setValue: (v) => cm.setValue(v || ''),
        setMode: (m) => cm.setOption('mode', m),
        focus: () => cm.focus(),
        refresh: () => cm.refresh(),
        setCursor: (line, col) => {
          const target = { line: Math.max(0, line - 1), ch: Math.max(0, (col || 1) - 1) };
          cm.setCursor(target);
          cm.scrollIntoView(target, 120);
          cm.focus();
        },
        clearMarks: () => {
          markHandles.forEach((h) => {
            try {
              cm.removeLineClass(h.line, 'background', h.cls);
            } catch {
              /* ignore */
            }
          });
          markHandles = [];
        },
        markLine: (line, cls) => {
          const handle = cm.addLineClass(line - 1, 'background', cls);
          markHandles.push({ line: line - 1, cls });
          return handle;
        },
        clearGutter: () => {
          try {
            cm.clearGutter('mc-gutter');
          } catch {
            /* ignore */
          }
        },
        setGutter: (line, severity) => {
          const dot = document.createElement('div');
          dot.className = `mc-gutter-dot ${severity === 'warning' ? 'warn' : severity === 'info' ? 'info' : 'err'}`;
          dot.title = severity;
          try {
            cm.setGutterMarker(line - 1, 'mc-gutter', dot);
          } catch {
            /* ignore */
          }
        },
        flashLine: (line) => {
          const idx = Math.max(0, line - 1);
          try {
            cm.addLineClass(idx, 'background', 'cm-line-flash');
            setTimeout(() => {
              try {
                cm.removeLineClass(idx, 'background', 'cm-line-flash');
              } catch {
                /* ignore */
              }
            }, 1400);
          } catch {
            /* ignore */
          }
        },
      };
    } else {
      const ta = document.createElement('textarea');
      ta.className = 'fallback-editor';
      ta.spellcheck = false;
      ta.value = currentFile() ? currentFile().content : '';
      ta.addEventListener('input', () => {
        syncActive();
        save();
      });
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          const s = ta.selectionStart;
          ta.value = ta.value.slice(0, s) + '    ' + ta.value.slice(ta.selectionEnd);
          ta.selectionStart = ta.selectionEnd = s + 4;
        }
      });
      host.appendChild(ta);
      editor = {
        kind: 'textarea',
        cm: null,
        getValue: () => ta.value,
        setValue: (v) => {
          ta.value = v || '';
        },
        setMode: () => {},
        focus: () => ta.focus(),
        refresh: () => {},
        setCursor: () => {},
        clearMarks: () => {},
        markLine: () => {},
        clearGutter: () => {},
        setGutter: () => {},
        flashLine: () => {},
      };
    }

    renderCursorHint();
  }

  function renderCursorHint() {
    els.statusPos.textContent = 'Ln 1, Col 1';
  }

  // ------------------------------------------------------------ files

  function renderFiles() {
    els.fileList.textContent = '';
    state.files.forEach((file, i) => {
      const li = document.createElement('li');
      li.className = 'file-item' + (i === state.activeFile ? ' active' : '');
      li.title = file.name;

      const name = document.createElement('span');
      name.className = 'fname';
      name.textContent = file.name;
      li.appendChild(name);

      const actions = document.createElement('span');
      actions.className = 'row-actions';

      const rename = document.createElement('button');
      rename.textContent = '\u270E';
      rename.title = 'Rename';
      rename.addEventListener('click', (e) => {
        e.stopPropagation();
        renameFile(i);
      });

      const del = document.createElement('button');
      del.textContent = '\u2715';
      del.title = 'Delete';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteFile(i);
      });

      actions.append(rename, del);
      li.appendChild(actions);

      li.addEventListener('click', () => switchFile(i));
      els.fileList.appendChild(li);
    });
  }

  function switchFile(index) {
    if (index === state.activeFile) return;
    syncActive();
    state.activeFile = index;
    const f = currentFile();
    editor.setValue(f ? f.content : '');
    editor.setMode(MODE[fileLanguage(f) || 'cpp']);
    renderFiles();
    refreshMarkers();
    renderOutline();
    updateLanguageBadge();
    save();
  }

  function ensureUniqueName(name) {
    const used = new Set(state.files.map((f) => f.name.toLowerCase()));
    if (!used.has(name.toLowerCase())) return name;
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let n = 2;
    while (used.has(`${base}${n}${ext}`.toLowerCase())) n++;
    return `${base}${n}${ext}`;
  }

  function validName(name) {
    return /^[A-Za-z0-9_.\- ()+]+$/.test(name) && !name.includes('..') && name.length <= 96;
  }

  function addFile() {
    const lang = effectiveLanguage() === 'java' ? 'java' : 'cpp';
    const suggestion = lang === 'java' ? 'Helper.java' : 'helper.cpp';
    const name = window.prompt('New file name', ensureUniqueName(suggestion));
    if (!name) return;
    if (!validName(name)) return toast('Invalid file name.', true);
    if (state.files.some((f) => f.name.toLowerCase() === name.toLowerCase())) return toast('That file already exists.', true);
    if (!EXT_LANG[extOf(name)]) return toast('Use .cpp, .cc, .cxx, .c or .java', true);

    syncActive();
    state.files.push({ name, content: '' });
    state.activeFile = state.files.length - 1;
    editor.setValue('');
    editor.setMode(MODE[fileLanguage(currentFile()) || 'cpp']);
    renderFiles();
    updateLanguageBadge();
    save();
    editor.focus();
  }

  function renameFile(index) {
    const file = state.files[index];
    if (!file) return;
    const name = window.prompt('Rename file', file.name);
    if (!name || name === file.name) return;
    if (!validName(name)) return toast('Invalid file name.', true);
    if (state.files.some((f, i) => i !== index && f.name.toLowerCase() === name.toLowerCase()))
      return toast('That file already exists.', true);
    if (!EXT_LANG[extOf(name)]) return toast('Use .cpp, .cc, .cxx, .c or .java', true);
    syncActive();
    file.name = name;
    renderFiles();
    updateLanguageBadge();
    save();
  }

  function deleteFile(index) {
    if (state.files.length === 1) return toast('Keep at least one file.', true);
    const file = state.files[index];
    if (!window.confirm(`Delete ${file.name}?`)) return;
    syncActive();
    state.files.splice(index, 1);
    if (state.activeFile >= state.files.length) state.activeFile = state.files.length - 1;
    const f = currentFile();
    editor.setValue(f.content);
    editor.setMode(MODE[fileLanguage(f) || 'cpp']);
    renderFiles();
    updateLanguageBadge();
    save();
  }

  function updateLanguageBadge() {
    const lang = effectiveLanguage();
    const label = lang === 'mixed' ? 'mixed!' : lang === 'cpp' ? 'C++' : lang === 'c' ? 'C' : 'Java';
    els.statusLang.textContent = state.language === 'auto' ? `auto \u2192 ${label}` : label;
  }

  // ------------------------------------------------------------ panel

  function showTab(name) {
    els.panelTabs.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== name));
    if (name === 'stdin') els.stdin.focus();
  }

  // The user's chosen panel height is kept as-is; only the rendered height is
  // clamped, so shrinking the window never permanently shrinks the panel.
  function clampPanel(px) {
    return Math.max(90, Math.min(window.innerHeight - 220, px));
  }

  function applyPanelHeight(px) {
    els.panel.style.height = `${clampPanel(px)}px`;
    if (editor) editor.refresh();
  }

  function setPanelHeight(px, persist) {
    if (persist !== false) state.panelHeight = px;
    applyPanelHeight(px);
  }

  function initResizer() {
    let dragging = false;
    let startY = 0;
    let startH = 0;
    els.resizer.addEventListener('pointerdown', (e) => {
      dragging = true;
      startY = e.clientY;
      startH = els.panel.getBoundingClientRect().height;
      els.resizer.setPointerCapture(e.pointerId);
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
    });
    els.resizer.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      setPanelHeight(startH - (e.clientY - startY));
    });
    const stop = (e) => {
      if (!dragging) return;
      dragging = false;
      try {
        els.resizer.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      save();
    };
    els.resizer.addEventListener('pointerup', stop);
    els.resizer.addEventListener('pointercancel', stop);
  }

  // ------------------------------------------------------------ run

  function setBusy(value, label) {
    busy = value;
    els.run.disabled = value;
    els.runTests.disabled = value;
    els.statusLeft.textContent = value ? label || 'Working\u2026' : 'Ready';
  }

  function buildPayload(extra) {
    syncActive();
    return {
      language: state.language,
      files: state.files.map((f) => ({ name: f.name, content: f.content })),
      stdin: state.stdin,
      limits: state.limits,
      ...(extra || {}),
    };
  }

  async function run(useTests) {
    if (busy) return;
    syncActive();

    const payload = buildPayload(useTests ? { tests: state.tests.map((t) => ({ input: t.input, expected: t.expected })) } : null);

    setBusy(true, useTests ? 'Running tests\u2026' : 'Compiling\u2026');
    showTab('output');
    els.streams.textContent = '';
    els.runHeader.textContent = '';
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = 'Compiling and running\u2026';
    els.runHeader.appendChild(hint);

    try {
      const res = await fetch('api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      let data;
      try {
        data = await res.json();
      } catch {
        throw new Error(`Server returned ${res.status} with no JSON.`);
      }
      if (!res.ok && data.error) throw new Error(data.error);
      renderResult(data, useTests);
    } catch (err) {
      els.streams.textContent = '';
      renderStream('Program', `Request failed: ${err.message}\n\nIs the server running? Start it with:  node server.js`, 'stderr');
      setBusy(false);
      return;
    }

    setBusy(false);
    if (health) els.statusLauncher.textContent = health.launcher === 'jobobject' ? 'kernel job object' : 'userspace fallback';
  }

  function renderResult(data, useTests) {
    lastResult = data;
    problemsCache = data.compile ? data.compile.diagnostics || [] : [];
    state.problemIndex = -1;
    renderProblems(problemsCache);
    refreshMarkers();

    if (!data.compile) {
      els.streams.textContent = '';
      renderStream('Output', 'No compile phase returned.', 'empty');
      return;
    }

    if (!data.compile.ok) {
      els.streams.textContent = '';
      els.runHeader.textContent = '';
      els.runHeader.append(chip('COMPILE ERROR', 'err'));
      els.runHeader.append(stat('Errors', String(data.compile.errors)));
      els.runHeader.append(stat('Warnings', String(data.compile.warnings)));
      els.runHeader.append(stat('Time', `${data.compile.ms} ms`));
      if (data.compile.raw.trim()) renderStream('Compiler output', data.compile.raw, 'stderr');
      else renderStream('Compiler output', '(no output)', 'empty');
      showTab('problems');

      // Take the user straight to the first thing that actually broke, even if
      // it lives in a different file than the one they were editing.
      const first = problemsCache.find((d) => d.severity === 'error' && d.file && d.line) ||
        problemsCache.find((d) => d.file && d.line);
      if (first) {
        jumpToDiagnostic(first);
        const where = `${first.file}:${first.line}${first.col ? ':' + first.col : ''}`;
        els.statusLeft.textContent = `Compile failed \u2014 ${where}`;
        toast(`Compile failed \u2014 jumped to ${where}`);
      } else {
        els.statusLeft.textContent = 'Compile failed';
      }
    } else if (useTests) {
      testResults = data.tests || [];
      renderTests();
      els.streams.textContent = '';
      renderTestSummary(data);
      showTab('tests');
    } else {
      testResults = null;
      renderRun(data);
      showTab('output');
    }

    updateBadges(data);
  }

  function renderRun(data) {
    els.streams.textContent = '';
    els.runHeader.textContent = '';
    const r = data.run;
    if (!r) {
      renderStream('Output', 'No run result.', 'empty');
      return;
    }

    els.runHeader.append(chip(r.verdict, r.verdict === 'OK' ? 'ok' : 'err'));
    els.runHeader.append(stat('Exit', String(r.exitCode)));
    els.runHeader.append(stat('Time', `${r.ms} ms`));
    if (typeof r.peakMemoryBytes === 'number' && r.peakMemoryBytes > 0)
      els.runHeader.append(stat('Peak mem', formatBytes(r.peakMemoryBytes)));
    if (data.meta && data.meta.mainClass) els.runHeader.append(stat('Class', data.meta.mainClass));
    if (data.compile.warnings) els.runHeader.append(stat('Warnings', String(data.compile.warnings)));

    if (r.stdout.length) renderStream('stdout', r.stdout + (r.stdoutTruncated ? '\n\u2026output truncated\u2026' : ''), '');
    else renderStream('stdout', '(no output)', 'empty');

    if (r.stderr.length) renderStream('stderr', r.stderr + (r.stderrTruncated ? '\n\u2026output truncated\u2026' : ''), 'stderr');

    if (r.timedOut) {
      renderStream(
        'Time limit',
        `Killed after ${data.limits.timeMs} ms. Check for an infinite loop, or raise the limit under "Limits".`,
        'stderr'
      );
    }
    if (r.memoryExceeded) {
      renderStream(
        'Memory limit',
        `Exceeded the ${data.limits.memoryMB} MB limit. Raise it under "Limits" if the program really needs that much.`,
        'stderr'
      );
    }
    if (r.error) renderStream('Launcher', r.error, 'stderr');
  }

  function renderTestSummary(data) {
    const s = data.testsSummary || { total: 0, passed: 0, failed: 0 };
    els.runHeader.textContent = '';
    const allPass = s.failed === 0 && s.total > 0;
    els.runHeader.append(chip(allPass ? 'ALL PASSED' : `${s.failed} FAILED`, allPass ? 'ok' : 'err'));
    els.runHeader.append(stat('Passed', `${s.passed}/${s.total}`));
    els.runHeader.append(stat('Compile', `${data.compile.ms} ms`));
    if (data.compile.warnings) els.runHeader.append(stat('Warnings', String(data.compile.warnings)));
    renderStream(
      'Result',
      allPass
        ? `All ${s.total} test case${s.total === 1 ? '' : 's'} passed.`
        : `${s.failed} of ${s.total} test cases failed \u2014 see the Tests tab.`,
      allPass ? '' : 'stderr'
    );
  }

  function renderStream(label, text, cls) {
    const wrap = document.createElement('div');
    wrap.className = 'stream';
    const lab = document.createElement('div');
    lab.className = 'stream-label';
    lab.textContent = label;
    const pre = document.createElement('pre');
    pre.className = 'out' + (cls ? ` ${cls}` : '');
    pre.textContent = text;
    wrap.append(lab, pre);
    els.streams.appendChild(wrap);
  }

  function stat(label, value) {
    const span = document.createElement('span');
    span.className = 'stat';
    span.append(`${label} `);
    const b = document.createElement('b');
    b.textContent = value;
    span.append(b);
    return span;
  }

  function chip(text, kind) {
    const span = document.createElement('span');
    span.className = `verdict ${kind}`;
    span.textContent = text;
    return span;
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1) return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
  }

  // ------------------------------------------------------------ problems

  function renderProblems(list) {
    els.problems.textContent = '';

    const errors = list.filter((d) => d.severity === 'error').length;
    const warnings = list.filter((d) => d.severity === 'warning').length;
    if (els.problemsSummary) {
      if (!list.length) els.problemsSummary.textContent = 'Clean compile \u2014 no diagnostics.';
      else {
        const bits = [];
        if (errors) bits.push(`${errors} error${errors === 1 ? '' : 's'}`);
        if (warnings) bits.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
        if (!bits.length) bits.push(`${list.length} note${list.length === 1 ? '' : 's'}`);
        els.problemsSummary.textContent = `${bits.join(' \u00b7 ')} \u2014 click one to jump`;
      }
    }

    if (!list.length) {
      const d = document.createElement('div');
      d.className = 'empty';
      d.textContent = 'No diagnostics \u2014 clean compile.';
      els.problems.appendChild(d);
      return;
    }

    list.forEach((diag, i) => {
      const btn = document.createElement('button');
      btn.className = `diag ${diag.severity || 'error'}`;
      btn.type = 'button';
      btn.dataset.index = String(i);

      const head = document.createElement('div');
      head.className = 'diag-head';

      const dot = document.createElement('span');
      dot.className = 'diag-sev-dot';

      const sev = document.createElement('span');
      sev.className = 'diag-sev';
      sev.textContent = diag.severity || 'error';

      const loc = document.createElement('span');
      loc.className = 'diag-loc';
      loc.textContent = diag.line ? `${diag.file}:${diag.line}${diag.col ? ':' + diag.col : ''}` : diag.file || 'build';

      const msg = document.createElement('span');
      msg.className = 'diag-msg';
      msg.textContent = diag.message;

      head.append(dot, sev, loc, msg);
      btn.appendChild(head);

      if (diag.source !== null && diag.source !== undefined && diag.line) {
        const code = document.createElement('div');
        code.className = 'diag-code';
        code.append(`${String(diag.line).padStart(4)} | `);
        code.append(diag.source);
        if (diag.col > 0) {
          const caret = document.createElement('div');
          caret.className = 'caret-line';
          caret.textContent = `${' '.repeat(String(diag.line).padStart(4).length + 3 + Math.max(0, diag.col - 1))}^`;
          code.appendChild(caret);
        }
        btn.appendChild(code);
      }

      if (diag.details && diag.details.length) {
        const det = document.createElement('div');
        det.className = 'diag-details';
        det.textContent = diag.details.join('\n');
        btn.appendChild(det);
      }

      btn.addEventListener('click', () => jumpToDiagnostic(diag));
      els.problems.appendChild(btn);
    });
  }

  function jumpToDiagnostic(diag) {
    if (!diag) return;
    if (!diag.file) {
      if (diag.message) toast(diag.message, true);
      return;
    }
    const idx = state.files.findIndex((f) => f.name.toLowerCase() === diag.file.toLowerCase());
    if (idx < 0) return toast(`Open ${diag.file} to see this line.`, true);
    if (idx !== state.activeFile) switchFile(idx);
    if (diag.line) {
      editor.setCursor(diag.line, diag.col || 1);
      editor.flashLine(diag.line);
    }
    highlightProblemCard(diag);
  }

  function highlightProblemCard(diag) {
    const idx = problemsCache.indexOf(diag);
    els.problems.querySelectorAll('.diag').forEach((el, i) => {
      el.classList.toggle('current', i === idx);
    });
    const current = els.problems.querySelector('.diag.current');
    if (current && current.scrollIntoView) current.scrollIntoView({ block: 'nearest' });
  }

  /** Step through every diagnostic that has a location (F8 / Shift+F8). */
  function gotoProblem(delta) {
    const list = problemsCache.filter((d) => d.file && d.line);
    if (!list.length) return toast('No problems to navigate.');
    let i = typeof state.problemIndex === 'number' ? state.problemIndex : -1;
    i = ((i + delta) % list.length + list.length) % list.length;
    state.problemIndex = i;
    const diag = list[i];
    jumpToDiagnostic(diag);
    els.statusLeft.textContent = `Problem ${i + 1}/${list.length} \u2014 ${diag.file}:${diag.line}`;
  }

  /** Re-apply line highlights and gutter dots for the file now in the editor. */
  function refreshMarkers() {
    if (!editor || editor.kind !== 'cm') return;
    syncActive();
    editor.clearMarks();
    editor.clearGutter();
    const file = currentFile();
    if (!file) return;
    const target = file.name.toLowerCase();
    problemsCache.forEach((d) => {
      if (!d.line || !d.file) return;
      if (d.file.toLowerCase() !== target) return;
      editor.markLine(d.line, d.severity === 'warning' ? 'cm-diagnostic-line-warn' : 'cm-diagnostic-line');
      editor.setGutter(d.line, d.severity);
    });
  }

  function updateBadges(data) {
    const errors = data.compile ? data.compile.errors : 0;
    const warnings = data.compile ? data.compile.warnings : 0;
    const total = errors + warnings;
    els.badgeProblems.textContent = String(total);
    els.badgeProblems.className = `badge ${total ? (errors ? 'err' : 'warn') : ''} ${total ? '' : 'hidden'}`.trim();

    if (data.testsSummary) {
      const s = data.testsSummary;
      els.badgeTests.textContent = `${s.passed}/${s.total}`;
      els.badgeTests.className = `badge ${s.failed ? 'err' : 'ok'}`;
    } else {
      els.badgeTests.className = 'badge hidden';
    }
  }

  // ------------------------------------------------------------ outline

  let outlineTimer = null;

  function outlineVisible() {
    const pane = document.querySelector('[data-rail-pane="outline"]');
    return pane && !pane.classList.contains('hidden');
  }

  function scheduleOutline() {
    if (!outlineVisible()) return;
    clearTimeout(outlineTimer);
    outlineTimer = setTimeout(renderOutline, 250);
  }

  function renderOutline() {
    const list = els.outlineList;
    if (!list) return;

    const file = currentFile();
    list.textContent = '';

    if (!file || !window.MCOutline) {
      if (els.outlineSummary) els.outlineSummary.textContent = 'outline unavailable';
      return;
    }

    const result = window.MCOutline.parse(file.content);
    const flat = window.MCOutline.flatten(result);
    const filter = (els.outlineFilter.value || '').trim().toLowerCase();
    const shown = filter ? flat.filter((s) => s.name.toLowerCase().includes(filter)) : flat;

    if (els.outlineSummary) {
      const fns = result.stats.functions;
      const cls = result.stats.classes;
      const count = filter ? `${shown.length}/${flat.length} shown` : `${fns} fn \u00b7 ${cls} type${cls === 1 ? '' : 's'}`;
      els.outlineSummary.textContent = `${count} \u00b7 ${result.stats.lines} lines`;
    }

    if (!shown.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = filter ? 'No symbols match the filter.' : 'No functions or classes found.';
      list.appendChild(empty);
      return;
    }

    shown.forEach((sym) => {
      const li = document.createElement('li');
      li.className = `outline-item ${sym.kind}`;
      li.style.paddingLeft = `${8 + sym.level * 13}px`;
      li.title = sym.signature || sym.name;
      if (file && problemsCache.some((d) => d.file === file.name && d.line === sym.line)) li.classList.add('has-issue');

      const icon = document.createElement('span');
      icon.className = 'o-icon';
      icon.textContent = sym.kind === 'class' ? 'C' : sym.kind === 'constructor' ? 'N' : '\u0192';

      const name = document.createElement('span');
      name.className = 'o-name';
      name.textContent = sym.name;

      const line = document.createElement('span');
      line.className = 'o-line';
      line.textContent = String(sym.line);

      li.append(icon, name, line);
      li.addEventListener('click', () => {
        list.querySelectorAll('.outline-item').forEach((el) => el.classList.remove('active'));
        li.classList.add('active');
        editor.setCursor(sym.line, 1);
        editor.flashLine(sym.line);
        els.statusLeft.textContent = `${sym.name} \u2014 line ${sym.line}`;
      });
      list.appendChild(li);
    });
  }

  // ------------------------------------------------------------ tests

  function renderTests() {
    els.testList.textContent = '';

    if (!state.tests.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No test cases yet. Add one with "+ Case".';
      els.testList.appendChild(empty);
      return;
    }

    state.tests.forEach((test, i) => {
      const result = testResults ? testResults.find((r) => r.index === i + 1) : null;

      const card = document.createElement('div');
      card.className = 'test-card';

      const head = document.createElement('div');
      head.className = 'test-card-head';

      const title = document.createElement('span');
      title.className = 'test-title';
      title.textContent = `Case ${i + 1}`;
      head.appendChild(title);

      if (result) {
        const v = result.verdict;
        head.appendChild(chip(v, v === 'AC' || v === 'OK' ? 'ok' : v === 'WA' || v === 'TLE' || v === 'MLE' ? 'warn' : 'err'));
        const meta = stat('Time', `${result.ms} ms`);
        head.appendChild(meta);
        if (result.peakMemoryBytes) head.appendChild(stat('Mem', formatBytes(result.peakMemoryBytes)));
      }

      head.appendChild(spacer());

      const del = document.createElement('button');
      del.className = 'icon-btn';
      del.textContent = '\u2715';
      del.title = 'Remove case';
      del.addEventListener('click', () => {
        state.tests.splice(i, 1);
        testResults = null;
        renderTests();
        save();
      });
      head.appendChild(del);
      card.appendChild(head);

      const body = document.createElement('div');
      body.className = 'test-card-body';
      body.append(
        testField('Input', test.input, (v) => {
          state.tests[i].input = v;
          save();
        }),
        testField('Expected output', test.expected, (v) => {
          state.tests[i].expected = v;
          save();
        })
      );
      card.appendChild(body);

      if (result) card.appendChild(renderTestResult(result));

      els.testList.appendChild(card);
    });
  }

  function spacer() {
    const s = document.createElement('div');
    s.className = 'spacer';
    return s;
  }

  function testField(labelText, value, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'test-field';
    const label = document.createElement('label');
    label.textContent = labelText;
    const ta = document.createElement('textarea');
    ta.spellcheck = false;
    ta.value = value;
    ta.placeholder = labelText === 'Input' ? '(no input)' : '(empty \u2014 any output passes)';
    ta.addEventListener('input', () => onChange(ta.value));
    wrap.append(label, ta);
    return wrap;
  }

  function renderTestResult(result) {
    const box = document.createElement('div');
    box.className = 'test-result';

    if (result.diff) {
      const d = result.diff;
      box.appendChild(diffRow(`line ${d.line}`, 'expected', d.expected === null ? '(no more lines)' : JSON.stringify(d.expected), 'diff-exp'));
      box.appendChild(diffRow('', 'actual', d.actual === null ? '(no more lines)' : JSON.stringify(d.actual), 'diff-act'));
    } else if (result.verdict === 'AC' || result.verdict === 'OK') {
      const ok = document.createElement('div');
      ok.className = 'diff-line';
      ok.style.color = '#9df3cd';
      ok.textContent = '\u2713 output matches';
      box.appendChild(ok);
    }

    if (result.timedOut) box.appendChild(diffRow('', 'note', `time limit exceeded (${result.ms} ms)`));
    if (result.memoryExceeded) box.appendChild(diffRow('', 'note', 'memory limit exceeded'));
    if (result.exitCode !== 0 && !result.timedOut) box.appendChild(diffRow('', 'exit', String(result.exitCode)));

    if (result.stderr && result.stderr.trim()) {
      box.appendChild(diffRow('', 'stderr', result.stderr.trim().split('\n').slice(0, 8).join('\n')));
    }

    return box;
  }

  function diffRow(where, label, text, cls) {
    const row = document.createElement('div');
    row.className = 'diff-line';
    const l = document.createElement('span');
    l.className = 'diff-label';
    l.textContent = label;
    const t = document.createElement('span');
    if (cls) t.className = cls;
    t.textContent = `${text}${where ? `   (${where})` : ''}`;
    row.append(l, t);
    return row;
  }

  function addTest() {
    syncTests();
    state.tests.push({ input: '', expected: '' });
    testResults = null;
    renderTests();
    save();
  }

  function syncTests() {
    // the textareas hold the truth while editing; state is kept in sync on input
  }

  // ------------------------------------------------------------ health

  async function loadHealth(force) {
    try {
      const res = await fetch(`api/health${force ? '?refresh=1' : ''}`);
      health = await res.json();
      setChip(els.chipCpp, health.toolchains.cpp.ok, `g++ ${shortVersion(health.toolchains.cpp.version, 'missing')}`);
      setChip(els.chipJava, health.toolchains.java.ok, `javac ${shortVersion(health.toolchains.java.version, 'missing')}`);
      els.statusLauncher.textContent = health.launcher === 'jobobject' ? 'kernel job object' : 'userspace fallback';
      updateBadges({ compile: { errors: 0, warnings: 0 } });

      if (!health.toolchains.cpp.ok || !health.toolchains.java.ok) {
        const missing = [];
        if (!health.toolchains.cpp.ok) missing.push('g++');
        if (!health.toolchains.java.ok) missing.push('javac');
        toast(`Missing ${missing.join(' + ')}. Run: npm run setup`, true, 9000);
      }
    } catch {
      els.chipCpp.textContent = 'server offline';
      els.chipCpp.className = 'chip chip-bad';
      els.chipJava.textContent = 'server offline';
      els.chipJava.className = 'chip chip-bad';
    }
  }

  function shortVersion(v, fallback) {
    if (!v) return fallback;
    const m = String(v).match(/(\d+(?:\.\d+){1,3})/);
    return m ? m[1] : String(v).slice(0, 22);
  }

  function setChip(el, ok, text) {
    el.textContent = text;
    el.className = `chip ${ok ? 'chip-ok' : 'chip-bad'}`;
    el.title = ok ? 'Available' : 'Not found - run npm run setup';
  }

  // ------------------------------------------------------------ examples

  async function loadExamples() {
    if (els.exampleList.dataset.loaded === '1') return;
    try {
      const res = await fetch('api/examples');
      const data = await res.json();
      els.exampleList.textContent = '';
      (data.examples || []).forEach((ex) => {
        const btn = document.createElement('button');
        btn.className = 'example-item';
        btn.textContent = ex.label;
        btn.addEventListener('click', () => applyExample(ex));
        els.exampleList.appendChild(btn);
      });
      els.exampleList.dataset.loaded = '1';
    } catch {
      els.exampleList.textContent = 'Could not load examples.';
    }
  }

  function applyExample(ex) {
    applyProgram(
      {
        files: ex.files,
        stdin: ex.stdin,
        tests: ex.tests,
        language: 'auto',
      },
      `Loaded: ${ex.label}`
    );
  }

  /** Replace the whole working copy (used by examples and saved snippets). */
  function applyProgram(program, message) {
    syncActive();
    state.files = program.files.map((f) => ({ name: f.name, content: f.content }));
    state.activeFile = 0;
    state.stdin = program.stdin || '';
    state.tests =
      program.tests && program.tests.length
        ? program.tests.map((t) => ({ input: t.input || '', expected: t.expected || '' }))
        : [{ input: '', expected: '' }];
    state.language = program.language || 'auto';
    testResults = null;
    els.stdin.value = state.stdin;
    els.lang.value = state.language;
    editor.setValue(state.files[0].content);
    editor.setMode(MODE[fileLanguage(state.files[0]) || 'cpp']);
    editor.clearMarks();
    editor.clearGutter();
    problemsCache = [];
    state.problemIndex = -1;
    renderFiles();
    renderProblems([]);
    renderOutline();
    renderTests();
    updateLanguageBadge();
    hidePopovers();
    save();
    if (message) toast(message);
  }

  // ------------------------------------------------------------ popovers

  function showPopover(el) {
    hidePopovers();
    el.classList.remove('hidden');
  }

  function hidePopovers() {
    [els.popLimits, els.popExamples, els.popSnippets, els.popExport].forEach((p) => {
      if (p) p.classList.add('hidden');
    });
  }

  function initPopovers() {
    els.limitsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      els.limitTime.value = state.limits.timeMs;
      els.limitMem.value = state.limits.memoryMB;
      showPopover(els.popLimits);
    });

    els.examplesBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      loadExamples();
      showPopover(els.popExamples);
    });

    [els.popLimits, els.popExamples, els.popSnippets, els.popExport].forEach((p) => {
      if (p) p.addEventListener('click', (e) => e.stopPropagation());
    });

    els.snippetsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSnippets();
    });

    els.exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!els.exportTitle.value) els.exportTitle.value = defaultExportTitle();
      showPopover(els.popExport);
    });

    document.addEventListener('click', hidePopovers);

    const commit = () => {
      const t = Number(els.limitTime.value);
      const m = Number(els.limitMem.value);
      if (Number.isFinite(t) && t >= 100) state.limits.timeMs = Math.min(30000, Math.round(t));
      if (Number.isFinite(m) && m >= 16) state.limits.memoryMB = Math.min(4096, Math.round(m));
      save();
    };
    els.limitTime.addEventListener('change', commit);
    els.limitMem.addEventListener('change', commit);
  }

  // ------------------------------------------------------------ terminal (interactive run)

  function termClear() {
    if (els.termOut) els.termOut.textContent = '';
  }

  function termWrite(text, cls) {
    if (!text || !els.termOut) return;
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = text;
    els.termOut.appendChild(span);
    els.termOut.scrollTop = els.termOut.scrollHeight;
  }

  function stripAnsi(text) {
    return String(text)
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\r(?!\n)/g, '');
  }

  function setTermControls(running) {
    if (!els.termStart) return;
    els.termStart.disabled = running;
    els.termStop.disabled = !running;
    els.termLine.disabled = !running;
    els.termSend.disabled = !running;
    if (running) els.termLine.focus();
  }

  async function startSession() {
    if (session.running) await stopSession(true);
    termClear();
    setTermControls(false);
    els.termStart.disabled = true;
    els.termStatus.textContent = 'Compiling\u2026';
    termWrite('[starting]\n', 'term-sys');

    let data;
    try {
      const res = await fetch('api/session/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      });
      data = await res.json();
    } catch (err) {
      termWrite(`[error] ${err.message}\n`, 'term-err');
      els.termStatus.textContent = 'Could not reach the server.';
      els.termStart.disabled = false;
      return;
    }

    if (!data.ok) {
      if (data.compile) {
        problemsCache = data.compile.diagnostics || [];
        state.problemIndex = -1;
        renderProblems(problemsCache);
        refreshMarkers();
        const first =
          problemsCache.find((d) => d.severity === 'error' && d.file && d.line) ||
          problemsCache.find((d) => d.file && d.line);
        if (first) jumpToDiagnostic(first);
        showTab('problems');
      }
      termWrite('\nCompilation failed \u2014 see the Problems tab.\n', 'term-err');
      els.termStatus.textContent = 'Compile failed.';
      els.termStart.disabled = false;
      return;
    }

    session.id = data.sessionId;
    session.running = true;
    termClear();
    termWrite(`session ${data.sessionId} \u00b7 ${data.language}${data.compile.cached ? ' \u00b7 cached build' : ''}\n`, 'term-sys');
    termWrite('\u2014 program is live; type below and press Enter \u2014\n\n', 'term-sys');
    connectStream(data.sessionId);
    setTermControls(true);
    els.termStatus.textContent = 'Running \u2014 type below and press Enter.';
  }

  function connectStream(id) {
    closeStream();
    if (!window.EventSource) {
      termWrite('[error] this browser does not support EventSource\n', 'term-err');
      return;
    }
    const es = new EventSource(`api/session/${encodeURIComponent(id)}/stream`);
    session.source = es;
    es.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.t === 'o') termWrite(stripAnsi(msg.d));
      else if (msg.t === 'e') termWrite(stripAnsi(msg.d), 'term-err');
      else if (msg.t === 'x') endSession(msg.code);
    };
    es.onerror = () => {
      /* the browser retries on its own; a dead session simply 404s and stops */
    };
  }

  function closeStream() {
    if (session.source) {
      try {
        session.source.close();
      } catch {
        /* ignore */
      }
      session.source = null;
    }
  }

  function endSession(code) {
    session.running = false;
    closeStream();
    termWrite(`\n\u2014 session ended (exit ${code == null ? '?' : code}) \u2014\n`, 'term-sys');
    els.termStatus.textContent = `Ended \u2014 exit ${code == null ? '?' : code}.`;
    setTermControls(false);
    els.termStart.disabled = false;
  }

  async function stopSession(silent) {
    if (!session.id) return;
    const id = session.id;
    try {
      await fetch(`api/session/${encodeURIComponent(id)}/stop`, { method: 'POST' });
    } catch {
      /* already gone */
    }
    closeStream();
    session.running = false;
    session.id = null;
    setTermControls(false);
    els.termStart.disabled = false;
    if (!silent) {
      termWrite('\n[stopped]\n', 'term-sys');
      els.termStatus.textContent = 'Stopped.';
    }
  }

  async function sendTermLine() {
    if (!session.running || !session.id) return;
    const line = els.termLine.value;
    els.termLine.value = '';
    if (els.termEcho.checked) termWrite(`\u203a ${line}\n`, 'term-you');
    try {
      await fetch(`api/session/${encodeURIComponent(session.id)}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: `${line}\n` }),
      });
    } catch (err) {
      termWrite(`[error] ${err.message}\n`, 'term-err');
    }
  }

  // ------------------------------------------------------------ snippets

  async function refreshSnippetList() {
    els.snipList.textContent = '';
    let data;
    try {
      const res = await fetch('api/snippets');
      data = await res.json();
    } catch {
      els.snipList.textContent = 'Could not load saved snippets.';
      return;
    }
    const items = data.snippets || [];
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Nothing saved yet.';
      els.snipList.appendChild(empty);
      return;
    }
    items.forEach((s) => els.snipList.appendChild(renderSnippetItem(s)));
  }

  function renderSnippetItem(s) {
    const row = document.createElement('div');
    row.className = 'snip-item';

    const main = document.createElement('div');
    main.className = 'snip-main';
    const name = document.createElement('div');
    name.className = 'snip-name';
    name.textContent = s.name;
    name.title = s.name;
    const meta = document.createElement('div');
    meta.className = 'snip-meta';
    const when = new Date(s.updatedAt);
    meta.textContent = `${s.language} \u00b7 ${s.files.join(', ')} \u00b7 ${s.lines} lines \u00b7 ${when.toLocaleDateString()}`;
    main.append(name, meta);

    const load = document.createElement('button');
    load.className = 'icon-btn';
    load.textContent = '\u2192';
    load.title = 'Load this snippet';
    load.addEventListener('click', () => loadSnippet(s.id));

    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.textContent = '\u2715';
    del.title = 'Delete this snippet';
    del.addEventListener('click', () => deleteSnippet(s));

    row.append(main, load, del);
    return row;
  }

  async function openSnippets() {
    showPopover(els.popSnippets);
    await refreshSnippetList();
  }

  async function saveSnippet() {
    const fallbackName = (currentFile() && currentFile().name) || 'Untitled';
    const name = els.snipName.value.trim() || fallbackName.replace(/\.[^.]+$/, '');
    els.snipSave.disabled = true;
    try {
      const res = await fetch('api/snippets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, ...buildPayload() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed.');
      els.snipName.value = '';
      toast(`Saved "${data.snippet.name}".`);
      await refreshSnippetList();
    } catch (err) {
      toast(err.message, true);
    } finally {
      els.snipSave.disabled = false;
    }
  }

  async function loadSnippet(id) {
    try {
      const res = await fetch(`api/snippets/${encodeURIComponent(id)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Not found.');
      applyProgram(data.snippet, `Loaded "${data.snippet.name}".`);
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function deleteSnippet(s) {
    if (!window.confirm(`Delete "${s.name}"?`)) return;
    try {
      const res = await fetch(`api/snippets/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Delete failed.');
      }
      await refreshSnippetList();
      toast('Deleted.');
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ------------------------------------------------------------ export

  function defaultExportTitle() {
    const file = currentFile();
    return file ? `${file.name} \u2014 Multi-Coder` : 'Multi-Coder report';
  }

  function slugify(text) {
    return (
      String(text)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'report'
    );
  }

  function downloadBlob(text, filename, type) {
    const blob = new Blob([text], { type: `${type};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function exportHtmlReport() {
    const title = els.exportTitle.value.trim() || defaultExportTitle();
    els.exportHtml.disabled = true;
    try {
      const res = await fetch('api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          language: state.language,
          files: state.files.map((f) => ({ name: f.name, content: f.content })),
          result: lastResult,
          notes: els.exportNotes.value.trim(),
        }),
      });
      if (!res.ok) throw new Error(`Export failed (${res.status}).`);
      const html = await res.text();
      downloadBlob(html, `${slugify(title)}.html`, 'text/html');
      toast('Report downloaded.');
      hidePopovers();
    } catch (err) {
      toast(err.message, true);
    } finally {
      els.exportHtml.disabled = false;
    }
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(editor.getValue());
      toast('Code copied to clipboard.');
    } catch {
      toast('The browser blocked clipboard access.', true);
    }
  }

  // ------------------------------------------------------------ toast

  let toastTimer = null;
  function toast(message, isError, ms) {
    els.toast.textContent = message;
    els.toast.className = `toast${isError ? ' err' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.add('hidden'), ms || 3600);
  }

  // ------------------------------------------------------------ wiring

  function init() {
    els.lang.value = state.language;
    els.stdin.value = state.stdin;
    els.limitTime.value = state.limits.timeMs;
    els.limitMem.value = state.limits.memoryMB;

    buildEditor();
    renderFiles();
    renderTests();
    renderOutline();
    updateLanguageBadge();
    setPanelHeight(state.panelHeight, false);
    initResizer();
    initPopovers();

    els.lang.addEventListener('change', () => {
      state.language = els.lang.value;
      updateLanguageBadge();
      save();
    });

    els.stdin.addEventListener('input', () => {
      state.stdin = els.stdin.value;
      save();
    });

    els.addFile.addEventListener('click', addFile);
    els.addTest.addEventListener('click', addTest);
    els.run.addEventListener('click', () => run(false));
    els.runTests.addEventListener('click', () => run(true));

    els.clear.addEventListener('click', () => {
      els.streams.textContent = '';
      els.runHeader.textContent = '';
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = 'Press Ctrl+Enter to compile & run.';
      els.runHeader.appendChild(hint);
      updateBadges({ compile: { errors: 0, warnings: 0 } });
    });

    els.panelTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (tab) showTab(tab.dataset.tab);
    });

    els.railTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.rail-tab');
      if (!btn) return;
      const name = btn.dataset.rail;
      els.railTabs.querySelectorAll('.rail-tab').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.rail-pane').forEach((p) => {
        p.classList.toggle('hidden', p.dataset.railPane !== name);
      });
      if (name === 'outline') renderOutline();
    });

    els.outlineFilter.addEventListener('input', renderOutline);

    if (els.btnPrevProblem) els.btnPrevProblem.addEventListener('click', () => gotoProblem(-1));
    if (els.btnNextProblem) els.btnNextProblem.addEventListener('click', () => gotoProblem(1));

    if (els.termStart) {
      els.termStart.addEventListener('click', startSession);
      els.termStop.addEventListener('click', () => stopSession(false));
      els.termClear.addEventListener('click', termClear);
      els.termForm.addEventListener('submit', (e) => {
        e.preventDefault();
        sendTermLine();
      });
    }
    if (els.snipSave) els.snipSave.addEventListener('click', saveSnippet);
    if (els.exportHtml) els.exportHtml.addEventListener('click', exportHtmlReport);
    if (els.exportCopy) els.exportCopy.addEventListener('click', copyCode);

    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 'Enter') {
        e.preventDefault();
        run(e.shiftKey);
      } else if (mod && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        syncActive();
        save();
        toast('Saved locally.');
      } else if (e.key === 'F8') {
        e.preventDefault();
        gotoProblem(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        hidePopovers();
      }
    });

    window.addEventListener('resize', () => {
      if (editor) editor.refresh();
      applyPanelHeight(state.panelHeight);
    });

    window.addEventListener('beforeunload', () => {
      syncActive();
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        /* ignore */
      }
    });

    loadHealth(false);
    setTimeout(() => editor.focus(), 60);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
