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
        lineNumbers: true,
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
      });
      cm.on('cursorActivity', () => {
        const pos = cm.getCursor();
        els.statusPos.textContent = `Ln ${pos.line + 1}, Col ${pos.ch + 1}`;
      });
      editor = {
        kind: 'cm',
        getValue: () => cm.getValue(),
        setValue: (v) => cm.setValue(v || ''),
        setMode: (m) => cm.setOption('mode', m),
        focus: () => cm.focus(),
        refresh: () => cm.refresh(),
        setCursor: (line) => {
          cm.setCursor({ line: Math.max(0, line - 1), ch: 0 });
          cm.scrollIntoView({ line: Math.max(0, line - 1), ch: 0 }, 120);
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
    editor.clearMarks();
    renderFiles();
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

  async function run(useTests) {
    if (busy) return;
    syncActive();

    const payload = {
      language: state.language,
      files: state.files.map((f) => ({ name: f.name, content: f.content })),
      stdin: state.stdin,
      limits: state.limits,
    };
    if (useTests) payload.tests = state.tests.map((t) => ({ input: t.input, expected: t.expected }));

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
    problemsCache = data.compile ? data.compile.diagnostics || [] : [];
    renderProblems(problemsCache);
    markDiagnostics(problemsCache);

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

      const head = document.createElement('div');
      head.className = 'diag-head';

      const sev = document.createElement('span');
      sev.className = 'diag-sev';
      sev.textContent = diag.severity || 'error';

      const loc = document.createElement('span');
      loc.className = 'diag-loc';
      loc.textContent = diag.line ? `${diag.file}:${diag.line}${diag.col ? ':' + diag.col : ''}` : diag.file || 'build';

      const msg = document.createElement('span');
      msg.className = 'diag-msg';
      msg.textContent = diag.message;

      head.append(sev, loc, msg);
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
    if (!diag.file) return;
    const idx = state.files.findIndex((f) => f.name.toLowerCase() === diag.file.toLowerCase());
    if (idx < 0) return toast(`Open ${diag.file} to see this line.`, true);
    switchFile(idx);
    if (diag.line) editor.setCursor(diag.line);
  }

  function markDiagnostics(list) {
    if (!editor || editor.kind !== 'cm') return;
    syncActive();
    editor.clearMarks();
    list.forEach((d) => {
      if (!d.line || !d.file) return;
      if (d.file.toLowerCase() !== (currentFile() || {}).name?.toLowerCase()) return;
      editor.markLine(d.line, d.severity === 'warning' ? 'cm-diagnostic-line-warn' : 'cm-diagnostic-line');
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
    syncActive();
    state.files = ex.files.map((f) => ({ name: f.name, content: f.content }));
    state.activeFile = 0;
    state.stdin = ex.stdin || '';
    state.tests = ex.tests && ex.tests.length ? ex.tests.map((t) => ({ input: t.input, expected: t.expected })) : [{ input: '', expected: '' }];
    state.language = 'auto';
    testResults = null;
    els.stdin.value = state.stdin;
    els.lang.value = state.language;
    editor.setValue(state.files[0].content);
    editor.setMode(MODE[fileLanguage(state.files[0]) || 'cpp']);
    editor.clearMarks();
    problemsCache = [];
    renderFiles();
    renderProblems([]);
    renderTests();
    updateLanguageBadge();
    hidePopovers();
    save();
    toast(`Loaded: ${ex.label}`);
  }

  // ------------------------------------------------------------ popovers

  function showPopover(el) {
    hidePopovers();
    el.classList.remove('hidden');
  }

  function hidePopovers() {
    els.popLimits.classList.add('hidden');
    els.popExamples.classList.add('hidden');
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

    [els.popLimits, els.popExamples].forEach((p) => p.addEventListener('click', (e) => e.stopPropagation()));

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
