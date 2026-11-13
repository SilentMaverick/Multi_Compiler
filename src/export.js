'use strict';

/**
 * Shareable report (#8).
 *
 * Turns the current program plus the last run into one self-contained HTML file:
 * no assets, no network, opens anywhere, prints cleanly to PDF. That makes it
 * easy to send a result to someone who does not have the compilers installed.
 */

const path = require('path');

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(bytes) {
  if (!bytes) return null;
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(mb >= 10 ? 0 : 1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function verdictClass(verdict) {
  if (!verdict) return 'neutral';
  if (verdict === 'OK' || verdict === 'AC') return 'good';
  if (verdict === 'WA' || verdict === 'TLE' || verdict === 'MLE') return 'warn';
  return 'bad';
}

function diagnosticList(diagnostics) {
  if (!diagnostics || !diagnostics.length) return '<p class="muted">No diagnostics.</p>';
  const items = diagnostics
    .slice(0, 60)
    .map((d) => {
      const loc = d.line ? `${d.file}:${d.line}${d.col ? ':' + d.col : ''}` : d.file || 'build';
      const code = d.source != null && d.line
        ? `<pre class="code-frame">${escapeHtml(String(d.line).padStart(4))} | ${escapeHtml(d.source)}</pre>`
        : '';
      return `<li class="diag ${escapeHtml(d.severity)}">
        <div class="diag-head"><span class="sev">${escapeHtml(d.severity)}</span>
        <span class="loc">${escapeHtml(loc)}</span>
        <span class="msg">${escapeHtml(d.message)}</span></div>${code}</li>`;
    })
    .join('');
  return `<ul class="diags">${items}</ul>`;
}

function testTable(tests) {
  if (!tests || !tests.length) return '';
  const rows = tests
    .map((t) => {
      const diff = t.diff
        ? `<div class="diff"><span class="lbl">expected</span> ${escapeHtml(JSON.stringify(t.diff.expected))}<br>
           <span class="lbl">actual</span> ${escapeHtml(JSON.stringify(t.diff.actual))}</div>`
        : '';
      return `<tr>
        <td>${t.index}</td>
        <td><span class="badge ${verdictClass(t.verdict)}">${escapeHtml(t.verdict)}</span></td>
        <td class="num">${t.ms} ms</td>
        <td><pre class="inline">${escapeHtml(t.actual || '')}</pre>${diff}</td>
      </tr>`;
    })
    .join('');
  return `<table class="tests">
    <thead><tr><th>#</th><th>Verdict</th><th>Time</th><th>Output</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

/**
 * @param {object} input { title, language, files, result, notes }
 * @returns {string} full HTML document
 */
function renderReport(input) {
  const title = (input.title || 'Multi-Coder report').slice(0, 200);
  const files = Array.isArray(input.files) ? input.files : [];
  const result = input.result || null;
  const language = input.language || 'auto';
  const when = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const fileBlocks = files
    .map(
      (f) => `<section class="file">
        <h2>${escapeHtml(f.name)}</h2>
        <pre class="code"><code>${escapeHtml(f.content)}</code></pre>
      </section>`
    )
    .join('');

  let outcome = '<p class="muted">This program was not run before exporting.</p>';
  if (result) {
    const compile = result.compile || {};
    const run = result.run;
    const summary = result.testsSummary;
    const verdict = run ? run.verdict : summary ? (summary.failed ? `${summary.failed} failed` : 'all passed') : compile.ok ? 'compiled' : 'CE';

    const stats = [];
    if (compile.ok) stats.push(`compile ${compile.cached ? 'cached' : compile.ms + ' ms'}`);
    if (run) {
      stats.push(`run ${run.ms} ms`);
      if (run.peakMemoryBytes) stats.push(`peak ${formatBytes(run.peakMemoryBytes)}`);
      stats.push(`exit ${run.exitCode}`);
    }
    if (summary) stats.push(`${summary.passed}/${summary.total} tests passed`);

    const streams = [];
    if (run && run.stdout) streams.push(`<h3>stdout</h3><pre class="out">${escapeHtml(run.stdout)}</pre>`);
    if (run && run.stderr) streams.push(`<h3>stderr</h3><pre class="out err">${escapeHtml(run.stderr)}</pre>`);

    outcome = `
      <div class="verdict-row">
        <span class="badge ${verdictClass(verdict)}">${escapeHtml(verdict)}</span>
        <span class="muted">${escapeHtml(stats.join(' · '))}</span>
      </div>
      ${compile.ok ? '' : `<h3>Compiler output</h3>${diagnosticList(compile.diagnostics)}`}
      ${compile.ok && compile.warnings ? `<h3>Warnings</h3>${diagnosticList(compile.diagnostics.filter((d) => d.severity === 'warning'))}` : ''}
      ${streams.join('')}
      ${summary ? `<h3>Test cases</h3>${testTable(result.tests)}` : ''}`;
  }

  const notes = input.notes ? `<section class="notes"><h2>Notes</h2><p>${escapeHtml(input.notes)}</p></section>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 40px 24px 80px;
    font: 15px/1.6 "Segoe UI", system-ui, -apple-system, sans-serif;
    background: #0d1017; color: #d8e0ef;
    max-width: 980px; margin-inline: auto;
  }
  header { border-bottom: 1px solid #262e3d; padding-bottom: 18px; margin-bottom: 28px; }
  h1 { margin: 0 0 6px; font-size: 24px; letter-spacing: -0.2px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.8px; color: #93a1b8; margin: 28px 0 8px; }
  h3 { font-size: 13px; color: #93a1b8; margin: 18px 0 6px; }
  .meta { color: #64748b; font-size: 13px; }
  .muted { color: #64748b; }
  pre {
    background: #12161f; border: 1px solid #1d2431; border-radius: 8px;
    padding: 14px 16px; overflow-x: auto; margin: 0;
    font: 13px/1.55 "Cascadia Code", Consolas, monospace;
    white-space: pre-wrap; word-break: break-word;
  }
  pre.out.err { border-color: rgba(255,92,108,.35); color: #ffc4ca; }
  .code-frame { margin-top: 6px; padding: 6px 10px; font-size: 12px; }
  .verdict-row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
  .badge { display: inline-block; padding: 2px 9px; border-radius: 5px; font-size: 12px; font-weight: 600; letter-spacing: .4px; }
  .badge.good { background: rgba(46,204,143,.16); color: #7ef0bd; }
  .badge.warn { background: rgba(240,180,41,.16); color: #ffd98a; }
  .badge.bad  { background: rgba(255,92,108,.16); color: #ff9aa4; }
  .badge.neutral { background: #1e2531; color: #93a1b8; }
  ul.diags { list-style: none; margin: 0; padding: 0; }
  li.diag { border-left: 3px solid #ff5c6c; background: #171d28; border-radius: 6px; padding: 8px 12px; margin-bottom: 8px; }
  li.diag.warning { border-left-color: #f0b429; }
  li.diag.info { border-left-color: #56b6f5; }
  .diag-head { display: flex; gap: 10px; flex-wrap: wrap; font-size: 13px; }
  .diag-head .sev { text-transform: uppercase; font-size: 10px; letter-spacing: .6px; color: #ff9aa4; padding-top: 2px; }
  li.diag.warning .sev { color: #ffd98a; }
  .diag-head .loc { font-family: Consolas, monospace; color: #4f8cff; }
  table.tests { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.tests th { text-align: left; color: #64748b; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .6px; padding: 6px 8px; border-bottom: 1px solid #262e3d; }
  table.tests td { padding: 8px; border-bottom: 1px solid #1d2431; vertical-align: top; }
  table.tests td.num { font-family: Consolas, monospace; color: #93a1b8; white-space: nowrap; }
  pre.inline { background: transparent; border: 0; padding: 0; font-size: 12px; margin: 0; }
  .diff { margin-top: 6px; font-family: Consolas, monospace; font-size: 12px; color: #93a1b8; }
  .diff .lbl { color: #64748b; display: inline-block; width: 62px; }
  footer { margin-top: 40px; padding-top: 14px; border-top: 1px solid #262e3d; color: #64748b; font-size: 12px; }
  @media print {
    body { background: #fff; color: #111; padding: 0; max-width: none; }
    pre { background: #f6f7f9; border-color: #e2e5ea; color: #111; }
    h2, h3, .meta, footer { color: #555; }
    header, footer { border-color: #ddd; }
    li.diag { background: #fafbfc; }
  }
</style>
</head>
<body>
  <header>
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">${escapeHtml(language.toUpperCase())} · exported ${escapeHtml(when)} · Multi-Coder</div>
  </header>
  <section>
    <h2>Source</h2>
    ${fileBlocks || '<p class="muted">No files.</p>'}
  </section>
  <section>
    <h2>Result</h2>
    ${outcome}
  </section>
  ${notes}
  <footer>Generated by Multi-Coder — a local IDE for C++, C and Java.</footer>
</body>
</html>`;
}

module.exports = { renderReport, escapeHtml };
