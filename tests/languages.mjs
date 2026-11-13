import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ex = require('../src/executor.js');
const tc = require('../src/toolchains.js');

let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? pass++ : fail++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${n}${ok ? '' : ` -> ${d}`}`); };

(async () => {
  const t = await tc.detect(true);
  console.log('python:', t.python.version, '| node:', t.js.version);
  console.log('');

  const py = await ex.execute({
    files: [{ name: 'main.py', content: 'import sys\nn = int(sys.stdin.readline())\nprint("sq", n*n)\n' }],
    stdin: '7\n',
    limits: { timeMs: 5000, memoryMB: 256 },
  });
  check('python runs', py.language === 'python' && py.compile.ok && py.run.stdout.trim() === 'sq 49', JSON.stringify(py.run && py.run.stdout));

  const pyErr = await ex.execute({
    files: [{ name: 'main.py', content: 'def f():\n    x =\n' }],
    limits: { timeMs: 5000, memoryMB: 256 },
  });
  const d = pyErr.compile.diagnostics[0];
  check('python syntax error detected', pyErr.compile.ok === false && pyErr.compile.errors === 1, JSON.stringify(pyErr.compile.diagnostics));
  check('python error line', d && d.line === 2, d && d.line);
  check('python error file', d && d.file === 'main.py', d && d.file);
  check('python error message', d && /SyntaxError/.test(d.message), d && d.message);
  check('python error has source', d && /x =/.test(d.source || ''), d && d.source);

  const pyRt = await ex.execute({
    files: [{ name: 'main.py', content: 'print(1/0)\n' }],
    limits: { timeMs: 5000, memoryMB: 256 },
  });
  check('python runtime error -> RE', pyRt.run.verdict === 'RE', pyRt.run.verdict);
  check('python traceback kept', /ZeroDivisionError/.test(pyRt.run.stderr), pyRt.run.stderr.slice(0, 80));

  const js = await ex.execute({
    files: [{ name: 'main.js', content: 'const n = Number(require("fs").readFileSync(0, "utf8").trim());\nconsole.log("sq", n * n);\n' }],
    stdin: '7\n',
    limits: { timeMs: 5000, memoryMB: 256 },
  });
  check('javascript runs', js.language === 'javascript' && js.compile.ok && js.run.stdout.trim() === 'sq 49', JSON.stringify(js.run && js.run.stdout));

  const jsErr = await ex.execute({
    files: [{ name: 'main.js', content: 'const x = ;\n' }],
    limits: { timeMs: 5000, memoryMB: 256 },
  });
  const jd = jsErr.compile.diagnostics[0];
  check('js syntax error detected', jsErr.compile.ok === false && jsErr.compile.errors >= 1, JSON.stringify(jsErr.compile.diagnostics));
  check('js error line', jd && jd.line === 1, jd && jd.line);
  check('js error file', jd && jd.file === 'main.js', jd && jd.file);
  check('js error message', jd && /SyntaxError/.test(jd.message), jd && jd.message);

  const pyTle = await ex.execute({
    files: [{ name: 'main.py', content: 'while True:\n    pass\n' }],
    limits: { timeMs: 1200, memoryMB: 256 },
  });
  check('python TLE', pyTle.run.verdict === 'TLE', pyTle.run.verdict + ' ' + pyTle.run.ms);

  const pyTests = await ex.execute({
    files: [{ name: 'main.py', content: 'import sys\na,b = map(int, sys.stdin.read().split())\nprint(a+b)\n' }],
    limits: { timeMs: 5000, memoryMB: 256 },
    tests: [{ input: '2 3\n', expected: '5\n' }, { input: '1 1\n', expected: '3\n' }],
  });
  check('python tests AC/WA', pyTests.tests.map((x) => x.verdict).join(',') === 'AC,WA', JSON.stringify(pyTests.tests.map((x) => x.verdict)));

  const mixed = await (async () => {
    try {
      await ex.execute({ files: [{ name: 'a.py', content: 'print(1)' }, { name: 'b.js', content: 'console.log(1)' }] });
      return null;
    } catch (e) { return e; }
  })();
  check('mixed python+js rejected', mixed && /Mixed languages/.test(mixed.message), mixed && mixed.message);

  console.log(`\n  ${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
})();
