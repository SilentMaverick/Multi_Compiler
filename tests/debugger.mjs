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

  // java is refused politely
  let javaErr = null;
  try {
    await dbg.start({ files: [{ name: 'Main.java', content: 'public class Main { public static void main(String[] a){} }' }] });
  } catch (e) { javaErr = e; }
  check('java debugging refused with a clear message', javaErr && /C and C\+\+ only/.test(javaErr.message), javaErr && javaErr.message);

  console.log(`\n  ${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(3); });
