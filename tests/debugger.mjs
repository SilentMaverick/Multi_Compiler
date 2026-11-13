import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const dbg = require('../src/debugger.js');

let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? pass++ : fail++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${n}${ok ? '' : ` -> ${d}`}`); };

const SRC = `#include <iostream>

int sumTo(int n) {
    int total = 0;
    for (int i = 1; i <= n; i++) {
        total += i * 2;
    }
    return total;
}

int main() {
    int a = sumTo(3);
    int b = sumTo(5);
    std::cout << a + b << "\\n";
    return 0;
}
`;

(async () => {
  const started = await dbg.start({
    files: [{ name: 'main.cpp', content: SRC }],
    breakpoints: [{ file: 'main.cpp', line: 5 }],
    limits: { timeMs: 5000, memoryMB: 256 },
  });

  check('debug session starts', started.ok === true, JSON.stringify(started).slice(0, 300));
  if (!started.ok) process.exit(1);

  const id = started.sessionId;
  let st = started.state;
  console.log(`   location: ${st.location && st.location.file}:${st.location && st.location.line} in ${st.location && st.location.func}`);

  check('stopped at the breakpoint', st.status === 'paused', st.status);
  check('breakpoint line is correct', st.location && st.location.line === 5, st.location && st.location.line);
  check('frame function is sumTo', st.location && /sumTo/.test(st.location.func), st.location && st.location.func);
  check('stack has frames', st.frames.length >= 1, st.frames.length);
  check('variables are listed', Array.isArray(st.variables) && st.variables.length > 0, JSON.stringify(st.variables));
  const nVar = st.variables.find((v) => v.name === 'n');
  check('parameter n has a value', nVar && nVar.value === '3', JSON.stringify(nVar));
  const totalVar = st.variables.find((v) => v.name === 'total');
  check('local total has a value', totalVar && totalVar.value === '0', JSON.stringify(totalVar));

  // step over the loop body a few times
  st = await dbg.command(id, 'next');
  check('step keeps session paused', st.status === 'paused', st.status);
  let moved = false;
  let seen = st.location && st.location.line;
  for (let k = 0; k < 12 && !moved; k++) {
    st = await dbg.command(id, 'next');
    if (st.location && st.location.line !== seen) moved = true;
  }
  check('stepping advances the line', moved, `stuck at ${seen}`);

  st = await dbg.command(id, 'evaluate', { expr: 'n' });
  check('evaluate returns a value', st.evaluation && st.evaluation.value === '3', JSON.stringify(st.evaluation));

  st = await dbg.command(id, 'evaluate', { expr: 'n * 100' });
  check('evaluate computes expressions', st.evaluation && st.evaluation.value === '300', JSON.stringify(st.evaluation));

  st = await dbg.command(id, 'evaluate', { expr: 'nope_missing' });
  check('bad expression reports an error', st.evaluation && st.evaluation.error, JSON.stringify(st.evaluation));

  st = await dbg.command(id, 'breakpoint-add', { file: 'main.cpp', line: 12 });
  check('breakpoint added', st.breakpoints.length === 2, JSON.stringify(st.breakpoints));
  const loopBp = st.breakpoints.find((b) => b.line === 5);
  st = await dbg.command(id, 'breakpoint-remove', { bpId: loopBp.id });
  check('breakpoint removed', st.breakpoints.length === 1, JSON.stringify(st.breakpoints));
  dbg.stop(id);
  check('session closes', dbg.list().length === 0, JSON.stringify(dbg.list()));

  // fresh session: stop at a breakpoint, then continue through to the end
  const s2 = await dbg.start({
    files: [{ name: 'main.cpp', content: SRC }],
    breakpoints: [{ file: 'main.cpp', line: 11 }],
    limits: { timeMs: 5000, memoryMB: 256 },
  });
  check('second session stops at line 11', s2.state.status === 'paused' && s2.state.location.line >= 11, `${s2.state.status} ${s2.state.location && s2.state.location.line}`);

  const s2b = await dbg.command(s2.sessionId, 'continue');
  check('program runs to completion', s2b.status === 'exited', s2b.status);
  check('exit code reported', s2b.exitCode === 0, s2b.exitCode);
  check('program output captured', /42/.test(s2b.output || ''), JSON.stringify(s2b.output));
  dbg.stop(s2.sessionId);

  // ---------------------------------------------------------------- visualizer
  const VIS = `#include <vector>
int main() {
    int a[4] = {9, 8, 7, 6};
    std::vector<int> v = {1, 2};
    for (int i = 0; i < 3; i++) { a[i] = a[i] + i; }
    return a[0] + v[0];
}
`;
  const vis = await dbg.start({
    files: [{ name: 'main.cpp', content: VIS }],
    breakpoints: [{ file: 'main.cpp', line: 5 }],
    limits: { timeMs: 5000, memoryMB: 256 },
  });
  check('visualizer session starts', vis.ok === true, JSON.stringify(vis).slice(0, 160));
  const arrays = (vis.state && vis.state.arrays) || [];
  const arrA = arrays.find((x) => x.name === 'a');
  const arrV = arrays.find((x) => x.name === 'v');
  check('C array is extracted for drawing', arrA && arrA.kind === 'array' && arrA.values.join(',') === '9,8,7,6', JSON.stringify(arrA));
  check('std::vector is extracted', arrV && arrV.values.join(',') === '1,2', JSON.stringify(arrV));
  dbg.stop(vis.sessionId);

  // ---------------------------------------------------------------- java (jdb)
  const JAVA = `public class Main {
    static int add(int x, int y) { return x + y; }
    public static void main(String[] args) {
        int[] arr = {5, 3, 1};
        String label = "hi";
        int total = 0;
        for (int i = 0; i < arr.length; i++) {
            total = add(total, arr[i]);
        }
        System.out.println(label + " " + total);
    }
}
`;
  const jd = await dbg.start({
    files: [{ name: 'Main.java', content: JAVA }],
    breakpoints: [{ file: 'Main.java', line: 8 }],
    limits: { timeMs: 8000, memoryMB: 256 },
  });
  check('java debug session starts', jd.ok === true, JSON.stringify(jd).slice(0, 200));
  if (jd.ok) {
    check('java stops at the breakpoint', jd.state.status === 'paused' && jd.state.location.line === 8, JSON.stringify(jd.state.location));
    const jnames = (jd.state.variables || []).map((v) => v.name);
    check('java locals are listed', jnames.includes('arr') && jnames.includes('total'), jnames.join(','));
    const jarr = (jd.state.arrays || []).find((a) => a.name === 'arr');
    check('java array is drawn', jarr && jarr.values.join(',') === '5,3,1', JSON.stringify(jarr));

    const jStep = await dbg.command(jd.sessionId, 'next');
    check('java stepping works', jStep.status === 'paused' && jStep.location.line !== 8, JSON.stringify(jStep.location));

    const jEval = await dbg.command(jd.sessionId, 'evaluate', { expr: 'label' });
    check('java evaluate works', jEval.evaluation && /hi/.test(String(jEval.evaluation.value)), JSON.stringify(jEval.evaluation));

    // the loop breakpoint would re-trigger, so clear it before running out
    await dbg.command(jd.sessionId, 'breakpoint-remove', { file: 'Main.java', line: 8 });
    const jEnd = await dbg.command(jd.sessionId, 'continue');
    check('java program runs to completion', jEnd.status === 'exited', jEnd.status);
    dbg.stop(jd.sessionId);
  }

  console.log(`\n  ${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(3); });
