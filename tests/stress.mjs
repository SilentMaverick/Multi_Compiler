import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { stress } = require('../src/stress.js');

let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? pass++ : fail++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${n}${ok ? '' : ` -> ${d}`}`); };
const f = (name, content) => ({ files: [{ name, content }] });

const GENERATOR = `#include <iostream>
#include <cstdlib>
int main() {
    int seed; std::cin >> seed;
    std::srand(seed * 7919);
    int n = 3 + seed % 5;
    std::cout << n << "\\n";
    for (int i = 0; i < n; i++) std::cout << (-(1 + std::rand() % 9)) << " ";
    std::cout << "\\n";
}
`;

const REFERENCE = `#include <iostream>
int main() {
    int n; if (!(std::cin >> n)) return 0;
    long long best = -1000000;
    for (int i = 0; i < n; i++) { long long x; std::cin >> x; if (x > best) best = x; }
    std::cout << best << "\\n";
}
`;

const BUGGY = `#include <iostream>
int main() {
    int n; if (!(std::cin >> n)) return 0;
    long long best = 0;
    for (int i = 0; i < n; i++) { long long x; std::cin >> x; if (x > best) best = x; }
    std::cout << best << "\\n";
}
`;

const CORRECT = REFERENCE;

(async () => {
  const bad = await stress({
    language: 'cpp',
    solution: f('main.cpp', BUGGY),
    generator: f('gen.cpp', GENERATOR),
    reference: f('ref.cpp', REFERENCE),
    iterations: 40,
    limits: { timeMs: 4000, memoryMB: 256 },
  });

  check('buggy solution is caught', bad.verdict === 'FAIL', bad.verdict);
  check('counterexample includes the input', Boolean(bad.counterexample && bad.counterexample.input), JSON.stringify(bad.counterexample).slice(0, 200));
  check('counterexample has expected/actual', bad.counterexample && bad.counterexample.expected !== bad.counterexample.actual, JSON.stringify(bad.counterexample && [bad.counterexample.expected, bad.counterexample.actual]));
  console.log('   counterexample:', JSON.stringify(bad.counterexample && {
    seed: bad.counterexample.seed,
    input: bad.counterexample.input.replace(/\s+/g, ' ').trim(),
    expected: bad.counterexample.expected.trim(),
    actual: bad.counterexample.actual.trim(),
  }));

  const good = await stress({
    language: 'cpp',
    solution: f('main.cpp', CORRECT),
    generator: f('gen.cpp', GENERATOR),
    reference: f('ref.cpp', REFERENCE),
    iterations: 20,
    limits: { timeMs: 4000, memoryMB: 256 },
  });
  check('correct solution passes', good.verdict === 'PASS', JSON.stringify(good.counterexample));
  check('all iterations ran', good.ran === 20, good.ran);

  let compileErr = null;
  try {
    await stress({
      language: 'cpp',
      solution: f('main.cpp', 'int main() { return nope; }'),
      generator: f('gen.cpp', GENERATOR),
      reference: f('ref.cpp', REFERENCE),
      iterations: 5,
    });
  } catch (e) { compileErr = e; }
  check('compile failure is reported', compileErr && /does not compile/.test(compileErr.message), compileErr && compileErr.message);
  check('compile diagnostics attached', compileErr && compileErr.compile && compileErr.compile.errors > 0, compileErr && compileErr.label);

  // python works too
  const pyGen = f('gen.py', 'import sys, random\nseed=int(sys.stdin.readline())\nrandom.seed(seed)\nn=3+seed%4\nprint(n)\nprint(*[random.randint(-9,-1) for _ in range(n)])\n');
  const pyRef = f('ref.py', 'import sys\nn=int(sys.stdin.readline())\nprint(max(map(int, sys.stdin.read().split())))\n');
  const pyBad = f('main.py', 'import sys\nn=int(sys.stdin.readline())\nprint(max(0, max(map(int, sys.stdin.read().split()))))\n');
  const py = await stress({ language: 'python', solution: pyBad, generator: pyGen, reference: pyRef, iterations: 15, limits: { timeMs: 6000, memoryMB: 256 } });
  check('python stress works', py.verdict === 'FAIL' && py.counterexample, JSON.stringify(py).slice(0, 160));

  console.log(`\n  ${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(3); });
