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
    chipPython: $('chip-python'),
    chipJs: $('chip-js'),
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
    dbgStart: $('btn-dbg-start'),
    dbgNext: $('btn-dbg-next'),
    dbgStep: $('btn-dbg-step'),
    dbgCont: $('btn-dbg-cont'),
    dbgOutBtn: $('btn-dbg-out'),
    dbgStop: $('btn-dbg-stop'),
    dbgStatus: $('dbg-status'),
    dbgVars: $('dbg-vars'),
    dbgFrames: $('dbg-frames'),
    dbgOut: $('dbg-out'),
    dbgEvalForm: $('dbg-eval-form'),
    dbgExpr: $('dbg-expr'),
    stressIters: $('stress-iters'),
    stressRun: $('btn-stress-run'),
    stressStatus: $('stress-status'),
    stressGen: $('stress-gen'),
    stressRef: $('stress-ref'),
    stressResult: $('stress-result'),
    practiceBtn: $('btn-practice'),
    popPractice: $('popover-practice'),
    practiceList: $('practice-list'),
    problemTitle: $('problem-title'),
    problemDiff: $('problem-diff'),
    problemStatement: $('problem-statement'),
    problemResult: $('problem-result'),
    problemSubmit: $('btn-problem-submit'),
    problemReset: $('btn-problem-reset'),
    themeBtn: $('btn-theme'),
    shareBtn: $('btn-share'),
    collabBar: $('collab-bar'),
    collabText: $('collab-text'),
    collabCopy: $('btn-collab-copy'),
    collabLeave: $('btn-collab-leave'),
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
    '.py': 'python',
    '.js': 'javascript',
    '.mjs': 'javascript',
    '.h': 'cpp',
    '.hpp': 'cpp',
  };

  const MODE = {
    cpp: 'text/x-c++src',
    c: 'text/x-csrc',
    java: 'text/x-java',
    python: 'python',
    javascript: 'javascript',
  };

  const LANG_LABEL = {
    cpp: 'C++',
    c: 'C',
    java: 'Java',
    python: 'Python',
    javascript: 'JavaScript',
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
  const debug = { id: null, active: false, paused: false, bps: [] };
  let debugLineMark = null;
  const collab = { roomId: null, clientId: null, rev: 0, source: null, applying: false, people: [], queue: [], pumping: false, resyncing: false, lastDoc: '' };

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
      breakpoints: [],
      problem: null,
      theme: 'dark',
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
      if (!Array.isArray(merged.breakpoints)) merged.breakpoints = [];
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
        gutters: ['mc-breakpoints', 'mc-gutter', 'CodeMirror-linenumbers'],
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
      cm.on('change', (instance, change) => {
        if (collab.roomId && !collab.applying && change.origin !== 'collab' && change.origin !== 'setValue') {
          if (change.next) {
            // multi-change batch (undo, multi-cursor): send the whole document
            const full = instance.getValue();
            enqueueCollabOp({ pos: 0, del: collab.lastDoc.length, ins: full });
            collab.lastDoc = full;
          } else {
            const from = instance.indexFromPos(change.from);
            const to = instance.indexFromPos(change.to);
            enqueueCollabOp({ pos: from, del: to - from, ins: change.text.join('\n') });
          }
        }
        collab.lastDoc = instance.getValue();
        syncActive();
        save();
        scheduleOutline();
      });
      cm.on('cursorActivity', () => {
        const pos = cm.getCursor();
        els.statusPos.textContent = `Ln ${pos.line + 1}, Col ${pos.ch + 1}`;
      });
      cm.on('gutterClick', (instance, line, gutter) => {
        if (gutter === 'mc-breakpoints') toggleBreakpoint(line + 1);
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
        clearBreakpoints: () => {
          try {
            cm.clearGutter('mc-breakpoints');
          } catch {
            /* ignore */
          }
        },
        setBreakpoint: (line) => {
          const dot = document.createElement('div');
          dot.className = 'mc-bp-dot';
          try {
            cm.setGutterMarker(line - 1, 'mc-breakpoints', dot);
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
        clearBreakpoints: () => {},
        setBreakpoint: () => {},
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
    renderBreakpoints();
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
    const lang = effectiveLanguage();
    const names = {
      java: 'Helper.java',
      python: 'helper.py',
      javascript: 'helper.js',
      c: 'helper.c',
    };
    const suggestion = names[lang] || 'helper.cpp';
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
    const label = lang === 'mixed' ? 'mixed!' : LANG_LABEL[lang] || lang;
    els.statusLang.textContent = state.language === 'auto' ? `auto \u2192 ${label}` : label;
  }

  // ------------------------------------------------------------ panel

  function showTab(name) {
    els.panelTabs.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== name));
    if (name === 'stdin') els.stdin.focus();
    if (name === 'stress') ensureStressTemplates();
    if (name === 'problem') ensureProblemLoaded();
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
      setBusy(false);
      if (health) els.statusLauncher.textContent = health.launcher === 'jobobject' ? 'kernel job object' : 'userspace fallback';
      return data;
    } catch (err) {
      els.streams.textContent = '';
      renderStream('Program', `Request failed: ${err.message}\n\nIs the server running? Start it with:  node server.js`, 'stderr');
      setBusy(false);
      return null;
    }
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
      if (els.chipPython && health.toolchains.python) {
        setChip(els.chipPython, health.toolchains.python.ok, `py ${shortVersion(health.toolchains.python.version, 'missing')}`);
      }
      if (els.chipJs && health.toolchains.javascript) {
        setChip(els.chipJs, health.toolchains.javascript.ok, `node ${shortVersion(health.toolchains.javascript.version, 'missing')}`);
      }
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
    [els.popLimits, els.popExamples, els.popSnippets, els.popExport, els.popPractice].forEach((p) => {
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

    [els.popLimits, els.popExamples, els.popSnippets, els.popExport, els.popPractice].forEach((p) => {
      if (p) p.addEventListener('click', (e) => e.stopPropagation());
    });

    if (els.practiceBtn) {
      els.practiceBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openPractice();
      });
    }
    if (els.problemSubmit) {
      els.problemSubmit.addEventListener('click', submitProblem);
      els.problemReset.addEventListener('click', resetProblemCode);
    }

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

  // ------------------------------------------------------------ debugger

  function renderBreakpoints() {
    if (!editor) return;
    editor.clearBreakpoints();
    const file = currentFile();
    if (!file) return;
    state.breakpoints
      .filter((b) => b.file === file.name)
      .forEach((b) => editor.setBreakpoint(b.line));
  }

  async function toggleBreakpoint(line) {
    const file = currentFile();
    if (!file) return;
    const idx = state.breakpoints.findIndex((b) => b.file === file.name && b.line === line);
    const removing = idx >= 0;
    if (removing) state.breakpoints.splice(idx, 1);
    else state.breakpoints.push({ file: file.name, line });
    renderBreakpoints();
    save();
    els.statusLeft.textContent = `${removing ? 'Removed' : 'Set'} breakpoint at ${file.name}:${line}`;

    if (debug.id) {
      const serverBp = debug.bps.find((b) => b.file === file.name && b.line === line);
      if (removing && serverBp) await dbgCommand('breakpoint-remove', { bpId: serverBp.id });
      else if (!removing) await dbgCommand('breakpoint-add', { file: file.name, line });
    }
  }

  function markDebugLine(line) {
    if (!editor || editor.kind !== 'cm') return;
    if (debugLineMark != null) {
      try {
        editor.cm.removeLineClass(debugLineMark, 'background', 'cm-debug-line');
      } catch {
        /* ignore */
      }
    }
    debugLineMark = line - 1;
    try {
      editor.cm.addLineClass(debugLineMark, 'background', 'cm-debug-line');
    } catch {
      /* ignore */
    }
  }

  async function startDebug() {
    if (debug.active) await stopDebug(true);
    els.dbgOut.textContent = '';
    els.dbgStatus.textContent = 'Compiling with debug symbols\u2026';
    els.dbgStart.disabled = true;
    try {
      const payload = buildPayload();
      payload.breakpoints = state.breakpoints.slice(0, 50);
      const res = await fetch('api/debug/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.ok) {
        if (data.compile) {
          problemsCache = data.compile.diagnostics || [];
          state.problemIndex = -1;
          renderProblems(problemsCache);
          refreshMarkers();
          const first = problemsCache.find((d) => d.severity === 'error' && d.file && d.line);
          if (first) jumpToDiagnostic(first);
          showTab('problems');
        }
        els.dbgStatus.textContent = data.error || 'Debug failed.';
        toast(data.error || 'Debug failed', true);
        return;
      }
      debug.id = data.sessionId;
      debug.active = true;
      showTab('debug');
      renderDebug(data.state);
    } catch (err) {
      els.dbgStatus.textContent = err.message;
      toast(err.message, true);
    } finally {
      els.dbgStart.disabled = false;
    }
  }

  async function dbgCommand(action, extra) {
    if (!debug.id) return;
    try {
      const res = await fetch(`api/debug/${encodeURIComponent(debug.id)}/cmd`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...(extra || {}) }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Debug command failed.');
      renderDebug(data.state);
    } catch (err) {
      toast(err.message, true);
      els.dbgStatus.textContent = err.message;
    }
  }

  async function stopDebug(silent) {
    if (debug.id) {
      try {
        await fetch(`api/debug/${encodeURIComponent(debug.id)}/stop`, { method: 'POST' });
      } catch {
        /* already gone */
      }
    }
    debug.id = null;
    debug.active = false;
    debug.paused = false;
    debug.bps = [];
    setDebugControls(false);
    if (debugLineMark != null && editor && editor.kind === 'cm') {
      try {
        editor.cm.removeLineClass(debugLineMark, 'background', 'cm-debug-line');
      } catch {
        /* ignore */
      }
      debugLineMark = null;
    }
    if (!silent) els.dbgStatus.textContent = 'Debugging stopped.';
  }

  function setDebugControls(paused) {
    if (!els.dbgNext) return;
    debug.paused = paused;
    els.dbgNext.disabled = !paused;
    els.dbgStep.disabled = !paused;
    els.dbgCont.disabled = !paused;
    if (els.dbgOutBtn) els.dbgOutBtn.disabled = !paused;
    els.dbgStop.disabled = !debug.active;
  }

  function renderDebug(st) {
    if (!st) return;
    debug.bps = st.breakpoints || [];

    if (st.output) {
      els.dbgOut.textContent += st.output;
      els.dbgOut.scrollTop = els.dbgOut.scrollHeight;
    }
    if (st.evaluation) {
      const line = st.evaluation.error
        ? `> ${st.evaluation.expr} => error: ${st.evaluation.error}\n`
        : `> ${st.evaluation.expr} => ${st.evaluation.value}\n`;
      els.dbgOut.textContent += line;
      els.dbgOut.scrollTop = els.dbgOut.scrollHeight;
    }

    const paused = st.status === 'paused';
    setDebugControls(paused);

    if (st.status === 'exited') {
      els.dbgStatus.textContent = `Program finished${st.exitCode == null ? '' : ` (exit ${st.exitCode})`}`;
      debug.active = false;
      debug.id = null;
      setDebugControls(false);
    } else if (paused && st.location) {
      els.dbgStatus.textContent = `Paused at ${st.location.file}:${st.location.line} in ${st.location.func}()`;
    } else {
      els.dbgStatus.textContent = st.status;
    }

    // variables
    els.dbgVars.textContent = '';
    if (!st.variables || !st.variables.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = paused ? 'No local variables in this frame.' : 'Not paused.';
      els.dbgVars.appendChild(empty);
    } else {
      st.variables.forEach((v) => {
        const row = document.createElement('div');
        row.className = 'dbg-var';
        const name = document.createElement('span');
        name.className = 'vname';
        name.textContent = v.name;
        const type = document.createElement('span');
        type.className = 'vtype';
        type.textContent = v.type;
        const value = document.createElement('span');
        value.className = `vvalue${v.value == null ? ' none' : ''}`;
        value.textContent = v.value == null ? '(complex)' : v.value;
        row.append(name, type, value);
        els.dbgVars.appendChild(row);
      });
    }

    // stack
    els.dbgFrames.textContent = '';
    (st.frames || []).forEach((f, i) => {
      const btn = document.createElement('button');
      btn.className = `dbg-frame${i === 0 ? ' current' : ''}`;
      btn.type = 'button';
      btn.textContent = `#${f.level} ${f.func}()  ${f.file || '?'}:${f.line ?? '?'}`;
      btn.addEventListener('click', () => dbgCommand('frame', { level: f.level }));
      els.dbgFrames.appendChild(btn);
    });

    // follow execution in the editor
    if (paused && st.location && st.location.line) {
      const idx = state.files.findIndex((f) => f.name.toLowerCase() === String(st.location.file || '').toLowerCase());
      if (idx >= 0) {
        if (idx !== state.activeFile) switchFile(idx);
        editor.setCursor(st.location.line, 1);
        markDebugLine(st.location.line);
      }
    }
  }

  // ------------------------------------------------------------ theme

  function resolvedTheme(theme) {
    if (theme === 'light' || theme === 'dark') return theme;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function applyTheme(theme) {
    const value = resolvedTheme(theme || state.theme);
    document.documentElement.dataset.theme = value;
    if (els.themeBtn) els.themeBtn.textContent = value === 'light' ? '\u2600' : '\u263E';
    if (editor && editor.refresh) {
      setTimeout(() => {
        try {
          editor.refresh();
        } catch {
          /* ignore */
        }
      }, 40);
    }
  }

  function toggleTheme() {
    state.theme = resolvedTheme(state.theme) === 'light' ? 'dark' : 'light';
    applyTheme(state.theme);
    save();
  }

  // ------------------------------------------------------------ live sharing / collaboration

  function collabLink() {
    return `${location.origin}${location.pathname}#room=${collab.roomId}`;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  function collabName() {
    let name = null;
    try {
      name = sessionStorage.getItem('mc-collab-name');
    } catch {
      /* ignore */
    }
    if (!name) {
      name = `guest-${Math.random().toString(36).slice(2, 6)}`;
      try {
        sessionStorage.setItem('mc-collab-name', name);
      } catch {
        /* ignore */
      }
    }
    return name;
  }

  function updateCollabBar() {
    if (!els.collabBar) return;
    const people = collab.people;
    const names = people.map((p) => p.name).join(', ');
    els.collabText.textContent = people.length
      ? `Live \u2014 ${people.length} ${people.length === 1 ? 'person' : 'people'}${names ? ` (${names})` : ''}`
      : 'Live \u2014 waiting for others';
  }

  async function startShare() {
    if (collab.roomId) {
      const ok = await copyText(collabLink());
      return toast(ok ? 'Link copied.' : collabLink());
    }
    const file = currentFile();
    if (!file) return;
    try {
      const res = await fetch('api/collab/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, language: state.language, content: file.content }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start sharing.');
      joinRoom(data.room.id);
      history.replaceState(null, '', `#room=${data.room.id}`);
      const ok = await copyText(collabLink());
      toast(ok ? 'Live session started \u2014 link copied.' : 'Live session started.');
    } catch (err) {
      toast(err.message, true);
    }
  }

  function joinRoom(roomId) {
    collab.roomId = roomId;
    collab.clientId =
      window.crypto && crypto.randomUUID ? crypto.randomUUID() : `c${Math.random().toString(36).slice(2)}`;
    collab.rev = 0;
    collab.queue.length = 0;
    collab.lastDoc = editor ? editor.getValue() : '';
    const url = `api/collab/${encodeURIComponent(roomId)}/stream?clientId=${encodeURIComponent(collab.clientId)}&name=${encodeURIComponent(collabName())}`;
    const es = new EventSource(url);
    collab.source = es;
    es.onmessage = onCollabEvent;
    els.collabBar.classList.remove('hidden');
    updateCollabBar();
  }

  function onCollabEvent(ev) {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (msg.t === 'presence') {
      collab.people = msg.clients || [];
      updateCollabBar();
      return;
    }

    if (msg.t === 'snapshot') {
      collab.rev = msg.rev;
      collab.applying = true;
      editor.setValue(msg.doc);
      collab.applying = false;
      collab.lastDoc = msg.doc;
      const file = currentFile();
      if (file) {
        file.content = msg.doc;
        if (msg.fileName) file.name = msg.fileName;
      }
      renderFiles();
      updateLanguageBadge();
      renderOutline();
      updateCollabBar();
      return;
    }

    if (msg.t === 'ops') {
      if (msg.by === collab.clientId) {
        collab.rev = msg.rev;
        return;
      }
      // Only apply when exactly next and nothing local is pending; otherwise the
      // server's canonical document wins and we resync.
      if (msg.rev !== collab.rev + 1 || collab.queue.length || collab.pumping) {
        scheduleResync();
        return;
      }
      const cm = editor.cm;
      if (!cm) return;
      collab.applying = true;
      try {
        cm.replaceRange(msg.op.ins, cm.posFromIndex(msg.op.pos), cm.posFromIndex(msg.op.pos + msg.op.del), 'collab');
        collab.rev = msg.rev;
        collab.lastDoc = cm.getValue();
        const file = currentFile();
        if (file) file.content = collab.lastDoc;
      } catch {
        scheduleResync();
      } finally {
        collab.applying = false;
      }
    }
  }

  function scheduleResync() {
    if (collab.resyncing || !collab.roomId) return;
    collab.resyncing = true;
    setTimeout(async () => {
      try {
        const res = await fetch(`api/collab/${encodeURIComponent(collab.roomId)}/snapshot`);
        const snap = await res.json();
        if (res.ok) {
          collab.queue.length = 0;
          collab.rev = snap.rev;
          collab.applying = true;
          editor.setValue(snap.doc);
          collab.applying = false;
          collab.lastDoc = snap.doc;
          const file = currentFile();
          if (file) file.content = snap.doc;
          renderOutline();
        }
      } catch {
        /* offline */
      } finally {
        collab.resyncing = false;
      }
    }, 150);
  }

  function enqueueCollabOp(op) {
    if (!collab.roomId) return;
    if (!op.del && !op.ins) return;
    collab.queue.push(op);
    pumpCollab();
  }

  async function pumpCollab() {
    if (collab.pumping) return;
    collab.pumping = true;
    try {
      while (collab.queue.length && collab.roomId) {
        const op = collab.queue.shift();
        const res = await fetch(`api/collab/${encodeURIComponent(collab.roomId)}/ops`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientId: collab.clientId, rev: collab.rev, op }),
        });
        const data = await res.json();
        if (!res.ok || data.resync) {
          scheduleResync();
          break;
        }
        collab.rev = data.rev;
      }
    } catch {
      /* transient network error: the next keystroke retries */
    } finally {
      collab.pumping = false;
    }
  }

  async function leaveCollab(silent) {
    if (!collab.roomId) return;
    const id = collab.roomId;
    try {
      await fetch(`api/collab/${encodeURIComponent(id)}/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: collab.clientId }),
      });
    } catch {
      /* ignore */
    }
    if (collab.source) {
      try {
        collab.source.close();
      } catch {
        /* ignore */
      }
      collab.source = null;
    }
    collab.roomId = null;
    collab.clientId = null;
    collab.rev = 0;
    collab.queue.length = 0;
    collab.people = [];
    els.collabBar.classList.add('hidden');
    history.replaceState(null, '', location.pathname);
    if (!silent) toast('Left the live session.');
  }

  // ------------------------------------------------------------ practice problems

  let practiceLoaded = false;

  function problemFileName(lang) {
    if (lang === 'java') return 'Main.java';
    if (lang === 'python') return 'main.py';
    if (lang === 'javascript') return 'main.js';
    return 'main.cpp';
  }

  async function openPractice() {
    showPopover(els.popPractice);
    if (practiceLoaded) return;
    try {
      const res = await fetch('api/problems');
      const data = await res.json();
      els.practiceList.textContent = '';
      (data.problems || []).forEach((p) => {
        const row = document.createElement('div');
        row.className = 'pr-item';
        const name = document.createElement('div');
        name.className = 'pr-name';
        name.textContent = p.title;
        const tags = document.createElement('div');
        tags.className = 'pr-tags';
        tags.textContent = `${p.difficulty} \u00b7 ${p.tags.join(', ')}`;
        name.appendChild(tags);
        const counts = document.createElement('div');
        counts.className = 'pr-tags';
        counts.textContent = `${p.samples}+${p.hidden} tests`;
        row.append(name, counts);
        row.addEventListener('click', () => loadProblem(p.id));
        els.practiceList.appendChild(row);
      });
      practiceLoaded = true;
    } catch {
      els.practiceList.textContent = 'Could not load problems.';
    }
  }

  async function loadProblem(id) {
    try {
      const res = await fetch(`api/problems/${encodeURIComponent(id)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Problem not found.');
      const p = data.problem;
      const lang = effectiveLanguage() === 'java' ? 'java' : effectiveLanguage() === 'python' ? 'python' : 'cpp';
      const starter = p.starters[lang] || p.starters.cpp;
      const tests = [...p.samples, ...p.hidden].map((t) => ({ input: t.input, expected: t.expected }));

      applyProgram(
        {
          files: [{ name: problemFileName(lang), content: starter }],
          stdin: p.samples.length ? p.samples[0].input : '',
          tests,
          language: lang,
        },
        `Loaded "${p.title}"`
      );

      state.problem = {
        id: p.id,
        title: p.title,
        difficulty: p.difficulty,
        sampleCount: p.samples.length,
        hiddenCount: p.hidden.length,
        starter,
        lang,
      };
      save();
      renderProblem(p);
      showTab('problem');
    } catch (err) {
      toast(err.message, true);
    }
  }

  function renderProblem(p) {
    els.problemTitle.textContent = p.title;
    els.problemDiff.textContent = p.difficulty;
    els.problemDiff.className = `badge ${p.difficulty}`;
    els.problemStatement.textContent = p.statement;
    els.problemResult.textContent = '';
  }

  function ensureProblemLoaded() {
    if (state.problem) {
      els.problemTitle.textContent = state.problem.title;
      els.problemDiff.textContent = state.problem.difficulty;
      els.problemDiff.className = `badge ${state.problem.difficulty}`;
      if (!els.problemStatement.textContent || els.problemStatement.textContent.startsWith('Pick a problem')) {
        loadProblem(state.problem.id);
      }
    } else {
      loadProblem('two-sum');
    }
  }

  async function submitProblem() {
    const info = state.problem;
    if (!info) return toast('Load a problem first.', true);
    els.problemSubmit.disabled = true;
    els.problemResult.textContent = 'Running all tests\u2026';
    try {
      const data = await run(true);
      if (!data) throw new Error('Run failed.');
      els.problemResult.textContent = '';
      const summary = data.testsSummary || { total: 0, passed: 0, failed: 0 };
      const allPass = summary.failed === 0 && summary.total > 0;

      const banner = document.createElement('span');
      banner.className = `pr-banner ${allPass ? 'ok' : 'bad'}`;
      banner.textContent = allPass
        ? `ACCEPTED \u2014 ${summary.passed}/${summary.total} tests passed`
        : `${summary.failed} of ${summary.total} tests failed`;
      els.problemResult.appendChild(banner);

      if (!allPass) {
        const failed = (data.tests || []).filter((t) => t.verdict !== 'AC' && t.verdict !== 'OK');
        const first = failed[0];
        if (first) {
          const which = first.index <= info.sampleCount ? 'sample' : 'hidden';
          const box = document.createElement('div');
          box.className = 'pr-fail';
          box.textContent =
            `First failure: ${which} test ${first.index} (${first.verdict})\n` +
            `input:    ${first.input.trim()}\n` +
            `expected: ${(first.expected || '').trim()}\n` +
            `actual:   ${(first.actual || '').trim()}`;
          box.style.whiteSpace = 'pre-wrap';
          els.problemResult.appendChild(box);
        }
      }
    } catch (err) {
      els.problemResult.textContent = err.message;
    } finally {
      els.problemSubmit.disabled = false;
    }
  }

  function resetProblemCode() {
    const info = state.problem;
    if (!info) return;
    const file = currentFile();
    if (!file) return;
    if (!window.confirm(`Discard your changes to ${file.name}?`)) return;
    file.content = info.starter;
    editor.setValue(info.starter);
    renderOutline();
    refreshMarkers();
    save();
    toast('Starter code restored.');
  }

  // ------------------------------------------------------------ stress testing

  const STRESS_TEMPLATES = {
    cpp: {
      ext: 'cpp',
      gen: `// reads a seed on stdin, prints one random test case
#include <iostream>
#include <cstdlib>

int main() {
    int seed;
    std::cin >> seed;
    std::srand(seed * 7919);
    int n = 1 + std::rand() % 8;
    std::cout << n << "\\n";
    for (int i = 0; i < n; i++) std::cout << (std::rand() % 21 - 10) << " ";
    std::cout << "\\n";
}
`,
      ref: `// reads the test case, prints the answer (write the obvious slow version)
#include <iostream>

int main() {
    int n;
    if (!(std::cin >> n)) return 0;
    long long best = -1000000000;
    for (int i = 0; i < n; i++) {
        long long x;
        std::cin >> x;
        if (x > best) best = x;
    }
    std::cout << best << "\\n";
}
`,
    },
    python: {
      ext: 'py',
      gen: `# reads a seed, prints one random test case
import random, sys

seed = int(sys.stdin.readline())
random.seed(seed)
n = 1 + random.randrange(8)
print(n)
print(*[random.randint(-10, 10) for _ in range(n)])
`,
      ref: `# reads the test case, prints the answer
import sys

n = int(sys.stdin.readline())
print(max(map(int, sys.stdin.read().split())))
`,
    },
    javascript: {
      ext: 'js',
      gen: `// reads a seed, prints one random test case
const seed = Number(require('fs').readFileSync(0, 'utf8').trim());
let s = seed * 7919;
const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) % 1000);
const n = 1 + (rand() % 8);
const values = Array.from({ length: n }, () => (rand() % 21) - 10);
console.log(n);
console.log(values.join(' '));
`,
      ref: `// reads the test case, prints the answer
const lines = require('fs').readFileSync(0, 'utf8').trim().split('\\n');
const n = Number(lines[0]);
const values = (lines[1] || '').trim().split(/\\s+/).slice(0, n).map(Number);
console.log(Math.max(...values));
`,
    },
  };

  let stressTemplatesReady = false;

  function ensureStressTemplates() {
    if (stressTemplatesReady || !els.stressGen) return;
    const t = STRESS_TEMPLATES[effectiveLanguage()] || STRESS_TEMPLATES.cpp;
    els.stressGen.value = t.gen;
    els.stressRef.value = t.ref;
    stressTemplatesReady = true;
  }

  function stressBlock(label, text, cls) {
    const box = document.createElement('div');
    box.className = 'stress-block';
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = label;
    box.append(lbl, document.createTextNode(text == null ? '(none)' : String(text)));
    if (cls) box.style.color = cls;
    return box;
  }

  async function runStress() {
    ensureStressTemplates();
    const lang = effectiveLanguage();
    if (lang === 'mixed') return toast('Pick one language before stress testing.', true);
    const tpl = STRESS_TEMPLATES[lang] || STRESS_TEMPLATES.cpp;

    els.stressRun.disabled = true;
    els.stressStatus.textContent = 'Compiling three programs\u2026';
    els.stressResult.textContent = '';

    try {
      const res = await fetch('api/stress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language: lang,
          solution: { files: state.files.map((f) => ({ name: f.name, content: f.content })) },
          generator: { files: [{ name: `gen.${tpl.ext}`, content: els.stressGen.value }] },
          reference: { files: [{ name: `ref.${tpl.ext}`, content: els.stressRef.value }] },
          iterations: Number(els.stressIters.value) || 25,
          limits: state.limits,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Stress test failed.');

      const banner = document.createElement('div');
      banner.className = `stress-banner ${data.verdict === 'PASS' ? 'ok' : 'bad'}`;
      banner.textContent =
        data.verdict === 'PASS'
          ? `PASS \u2014 ${data.ran} random cases agreed`
          : `FAIL \u2014 disagreed at seed ${data.counterexample.seed}`;
      els.stressResult.appendChild(banner);

      if (data.counterexample) {
        const c = data.counterexample;
        els.stressResult.appendChild(stressBlock('input', c.input));
        els.stressResult.appendChild(stressBlock('expected (reference)', c.expected));
        els.stressResult.appendChild(stressBlock('actual (your program)', c.actual));
        if (c.stderr && c.stderr.trim()) els.stressResult.appendChild(stressBlock('stderr', c.stderr.trim()));
      }

      els.stressStatus.textContent =
        data.verdict === 'PASS'
          ? `${data.ran} cases matched the reference.`
          : 'Found a counterexample \u2014 fix your program and run again.';
    } catch (err) {
      els.stressStatus.textContent = err.message;
      toast(err.message, true);
    } finally {
      els.stressRun.disabled = false;
    }
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
    applyTheme(state.theme);
    collab.lastDoc = editor.getValue();
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
    if (els.stressRun) els.stressRun.addEventListener('click', runStress);

    if (els.themeBtn) els.themeBtn.addEventListener('click', toggleTheme);
    if (els.shareBtn) els.shareBtn.addEventListener('click', startShare);
    if (els.collabCopy) {
      els.collabCopy.addEventListener('click', async () => {
        const ok = await copyText(collabLink());
        toast(ok ? 'Link copied.' : collabLink());
      });
    }
    if (els.collabLeave) els.collabLeave.addEventListener('click', () => leaveCollab(false));

    if (els.dbgStart) {
      els.dbgStart.addEventListener('click', startDebug);
      els.dbgNext.addEventListener('click', () => dbgCommand('next'));
      els.dbgStep.addEventListener('click', () => dbgCommand('step'));
      els.dbgCont.addEventListener('click', () => dbgCommand('continue'));
      if (els.dbgOutBtn) els.dbgOutBtn.addEventListener('click', () => dbgCommand('finish'));
      els.dbgStop.addEventListener('click', () => stopDebug(false));
      els.dbgEvalForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const expr = els.dbgExpr.value.trim();
        if (!expr) return;
        els.dbgExpr.value = '';
        dbgCommand('evaluate', { expr });
      });
    }
    renderBreakpoints();

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
      } else if (e.key === 'F10' && debug.active && debug.paused) {
        e.preventDefault();
        dbgCommand('next');
      } else if (e.key === 'F11' && debug.active && debug.paused) {
        e.preventDefault();
        dbgCommand(e.shiftKey ? 'finish' : 'step');
      } else if (e.key === 'F5' && debug.active) {
        e.preventDefault();
        dbgCommand('continue');
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

    // arriving through a share link joins the room automatically
    const roomMatch = /^#room=([A-Za-z0-9_-]{4,64})$/.exec(location.hash);
    if (roomMatch) setTimeout(() => joinRoom(roomMatch[1]), 350);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
