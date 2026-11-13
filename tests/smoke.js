'use strict';

/**
 * End-to-end checks against the real compilers.
 *   node tests/smoke.js
 * Exits non-zero if anything fails, so it doubles as a CI gate.
 */

const executor = require('../src/executor');
const toolchains = require('../src/toolchains');
const runner = require('../src/runner');

const results = [];
let failures = 0;

function check(name, cond, detail) {
  const ok = Boolean(cond);
  if (!ok) failures++;
  results.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${ok || !detail ? '' : `\n         ${String(detail).replace(/\n/g, '\n         ')}`}`);
}

async function runCase(name, payload) {
  try {
    return await executor.execute(payload);
  } catch (err) {
    check(name, false, `threw: ${err.message}`);
    return null;
  }
}

function firstDiag(res) {
  return res && res.compile && res.compile.diagnostics && res.compile.diagnostics[0];
}

(async () => {
  const tc = await toolchains.detect(true);
  console.log('\n=== toolchains ===');
  console.log(`  g++   : ${tc.cpp.version || 'MISSING'}  (${tc.cpp.compiler || '-'})`);
  console.log(`  gcc   : ${tc.c.version || 'MISSING'}`);
  console.log(`  javac : ${tc.java.version || 'MISSING'}`);
  console.log(`  java  : ${tc.java.javaVersion || 'MISSING'}`);
  console.log(`  launcher: ${runner.helperAvailable() ? 'jobobject' : 'fallback'}`);
  console.log('');

  if (!tc.cpp.ok) {
    console.error('  g++ is missing - cannot run the suite. Run: npm run setup');
    process.exit(2);
  }

  // ---------------------------------------------------------------- C++
  console.log('=== C++ ===');
  const cppHello = await runCase('cpp hello', {
    files: [
      {
        name: 'main.cpp',
        content: `#include <iostream>
#include <string>
int main() {
    std::string n;
    std::cin >> n;
    std::cout << "Hello, " << n << "!\\n";
    return 0;
}`,
      },
    ],
    stdin: 'world\n',
    limits: { timeMs: 5000, memoryMB: 256 },
  });
  check('cpp hello exits 0', cppHello && cppHello.run.verdict === 'OK', cppHello && JSON.stringify(cppHello.run));
  check('cpp hello output', cppHello && cppHello.run.stdout.trim() === 'Hello, world!', cppHello && cppHello.run.stdout);
  check('cpp uses job object', cppHello && cppHello.run.launcher === 'jobobject', cppHello && cppHello.run.launcher);
  check('cpp reports peak memory', cppHello && cppHello.run.peakMemoryBytes > 0, cppHello && cppHello.run.peakMemoryBytes);

  const cppError = await runCase('cpp compile error', {
    files: [
      {
        name: 'main.cpp',
        content: `#include <iostream>
int main() {
    int x = 5
    std::cout << y << "\\n";
    return 0;
}`,
      },
    ],
  });
  const d0 = firstDiag(cppError);
  const allDiags = cppError ? cppError.compile.diagnostics : [];
  const warnDiag = allDiags.find((d) => d.severity === 'warning');
  check('cpp CE detected', cppError && cppError.compile.ok === false);
  check('cpp CE has diagnostics', Boolean(d0), cppError && cppError.compile.errors);
  check('cpp CE first diagnostic is the error', d0 && d0.severity === 'error', d0 && d0.severity);
  check('cpp CE error line', d0 && d0.line === 4, d0 && `${d0.file}:${d0.line}:${d0.col}`);
  check('cpp CE error column', d0 && d0.col === 5, d0 && d0.col);
  check('cpp CE has file name', d0 && d0.file === 'main.cpp', d0 && d0.file);
  check('cpp CE has source line', d0 && typeof d0.source === 'string' && d0.source.includes('std::cout'), d0 && d0.source);
  check('cpp CE keeps the warning too', Boolean(warnDiag), cppError && JSON.stringify(cppError.compile.diagnostics.map((d) => `${d.severity}:${d.line}`)));

  const cppWarn = await runCase('cpp warning', {
    files: [
      {
        name: 'main.cpp',
        content: `int main() {
    int unused = 42;
    return 0;
}`,
      },
    ],
  });
  check('cpp warnings parsed', cppWarn && cppWarn.compile.warnings >= 1, cppWarn && cppWarn.compile.warnings);

  const cppTle = await runCase('cpp TLE', {
    files: [{ name: 'main.cpp', content: 'int main() { volatile long long i = 0; for (;;) i++; }' }],
    limits: { timeMs: 1200, memoryMB: 128 },
  });
  check('cpp TLE verdict', cppTle && cppTle.run.verdict === 'TLE', cppTle && `${cppTle.run.verdict} in ${cppTle.run.ms}ms`);
  check('cpp TLE respects time limit', cppTle && cppTle.run.ms < 6000, cppTle && cppTle.run.ms);

  const cppMle = await runCase('cpp MLE', {
    files: [
      {
        name: 'main.cpp',
        content: `#include <cstdlib>
#include <cstring>
int main() {
    for (int i = 0; i < 4096; i++) {
        void *p = std::malloc(1024 * 1024);
        if (!p) return 7;
        std::memset(p, 1, 1024 * 1024);
    }
    return 0;
}`,
      },
    ],
    limits: { timeMs: 8000, memoryMB: 64 },
  });
  check('cpp MLE verdict', cppMle && cppMle.run.verdict === 'MLE', cppMle && `${cppMle.run.verdict} exit=${cppMle.run.exitCode} peak=${cppMle.run.peakMemoryBytes}`);

  const cppTests = await runCase('cpp tests', {
    files: [
      {
        name: 'main.cpp',
        content: `#include <iostream>
int main(){ int a,b; if(!(std::cin>>a>>b)) return 0; std::cout << a+b << "\\n"; }`,
      },
    ],
    limits: { timeMs: 4000, memoryMB: 128 },
    tests: [
      { input: '2 3\n', expected: '5\n' },
      { input: '10 20\n', expected: '30\n' },
      { input: '1 1\n', expected: '3\n' },
    ],
  });
  check('cpp tests ran', cppTests && cppTests.tests.length === 3, cppTests && cppTests.tests.length);
  check('cpp AC/AC/WA', cppTests && cppTests.tests.map((t) => t.verdict).join(',') === 'AC,AC,WA', cppTests && cppTests.tests.map((t) => `${t.verdict}`).join(','));
  check('cpp diff located', cppTests && cppTests.tests[2].diff && cppTests.tests[2].diff.line === 1, cppTests && JSON.stringify(cppTests.tests[2] && cppTests.tests[2].diff));
  check('cpp summary', cppTests && cppTests.testsSummary.passed === 2 && cppTests.testsSummary.failed === 1, cppTests && JSON.stringify(cppTests.testsSummary));

  const cppMulti = await runCase('cpp multi-file', {
    files: [
      { name: 'main.cpp', content: '#include <iostream>\n#include "util.h"\nint main(){ std::cout << twice(21) << "\\n"; }' },
      { name: 'util.h', content: '#pragma once\ninline int twice(int x) { return 2 * x; }' },
    ],
    limits: { timeMs: 5000, memoryMB: 256 },
  });
  check('cpp multi-file compiles', cppMulti && cppMulti.compile.ok, cppMulti && cppMulti.compile.raw.slice(0, 200));
  check('cpp multi-file output', cppMulti && cppMulti.run && cppMulti.run.stdout.trim() === '42', cppMulti && cppMulti.run && cppMulti.run.stdout);

  // ---------------------------------------------------------------- C
  const cProg = await runCase('c program', {
    files: [{ name: 'main.c', content: '#include <stdio.h>\nint main(void){ printf("c-ok\\n"); return 0; }' }],
    limits: { timeMs: 5000, memoryMB: 128 },
  });
  check('c auto-detected', cProg && cProg.language === 'c', cProg && cProg.language);
  check('c compiles and runs', cProg && cProg.run && cProg.run.stdout.trim() === 'c-ok', cProg && cProg.compile.raw.slice(0, 300));

  // ---------------------------------------------------------------- Java
  if (!tc.java.ok) {
    console.log('\n=== Java (SKIPPED: javac missing) ===');
  } else {
    console.log('\n=== Java ===');
    const javaHello = await runCase('java hello', {
      files: [
        {
          name: 'Main.java',
          content: `import java.util.Scanner;
public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String n = sc.hasNext() ? sc.next() : "world";
        System.out.println("Hello, " + n + "!");
    }
}`,
        },
      ],
      stdin: 'java\n',
      limits: { timeMs: 8000, memoryMB: 256 },
    });
    check('java hello verdict', javaHello && javaHello.run && javaHello.run.verdict === 'OK', javaHello && JSON.stringify(javaHello.run && javaHello.run.stderr));
    check('java hello output', javaHello && javaHello.run && javaHello.run.stdout.trim() === 'Hello, java!', javaHello && javaHello.run && javaHello.run.stdout);
    check('java main class detected', javaHello && javaHello.meta.mainClass === 'Main', javaHello && javaHello.meta.mainClass);
    check('java reports peak memory', javaHello && javaHello.run && javaHello.run.peakMemoryBytes > 0, javaHello && javaHello.run && javaHello.run.peakMemoryBytes);

    const javaMulti = await runCase('java multi-class', {
      files: [
        { name: 'Main.java', content: 'public class Main { public static void main(String[] a){ System.out.println(Greeter.greet("multi")); } }' },
        { name: 'Greeter.java', content: 'public class Greeter { public static String greet(String w){ return "hi " + w; } }' },
      ],
      limits: { timeMs: 8000, memoryMB: 256 },
    });
    check('java multi-class compiles', javaMulti && javaMulti.compile.ok, javaMulti && javaMulti.compile.raw.slice(0, 400));
    check('java multi-class output', javaMulti && javaMulti.run && javaMulti.run.stdout.trim() === 'hi multi', javaMulti && javaMulti.run && javaMulti.run.stdout);

    const javaError = await runCase('java compile error', {
      files: [{ name: 'Main.java', content: 'public class Main {\n    public static void main(String[] args) {\n        int x = "no";\n    }\n}' }],
      limits: { timeMs: 8000, memoryMB: 256 },
    });
    const jd = firstDiag(javaError);
    check('java CE detected', javaError && javaError.compile.ok === false);
    check('java CE has diagnostics', Boolean(jd), javaError && javaError.compile.raw.slice(0, 300));
    check('java CE line', jd && jd.line === 3, jd && `${jd.file}:${jd.line}`);

    const javaNoMain = await runCase('java no main', {
      files: [{ name: 'Main.java', content: 'public class Main { void run() {} }' }],
      limits: { timeMs: 8000, memoryMB: 256 },
    });
    check('java no-main reported', javaNoMain && javaNoMain.run && javaNoMain.run.verdict === 'RE', javaNoMain && JSON.stringify(javaNoMain.run && javaNoMain.run.verdict));
    check('java no-main message', javaNoMain && javaNoMain.run && /main/i.test(javaNoMain.run.stderr), javaNoMain && javaNoMain.run && javaNoMain.run.stderr);

    const javaOom = await runCase('java OOM', {
      files: [
        {
          name: 'Main.java',
          content: `import java.util.*;
public class Main {
    public static void main(String[] args) {
        List<byte[]> hog = new ArrayList<>();
        while (true) hog.add(new byte[1024 * 1024]);
    }
}`,
        },
      ],
      limits: { timeMs: 15000, memoryMB: 64 },
    });
    check('java OOM -> MLE', javaOom && javaOom.run && javaOom.run.verdict === 'MLE', javaOom && javaOom.run && `${javaOom.run.verdict} / ${String(javaOom.run.stderr).slice(0, 120)}`);
  }

  // ---------------------------------------------------------------- validation
  console.log('\n=== validation ===');
  let mixed = null;
  try {
    await executor.execute({
      files: [
        { name: 'a.cpp', content: 'int main(){}' },
        { name: 'A.java', content: 'class A{}' },
      ],
    });
  } catch (err) {
    mixed = err;
  }
  check('mixed languages rejected', mixed && /Mixed languages/.test(mixed.message), mixed && mixed.message);

  let traversal = null;
  try {
    await executor.execute({ files: [{ name: '../evil.cpp', content: 'int main(){}' }] });
  } catch (err) {
    traversal = err;
  }
  check('path traversal rejected', traversal && /Invalid file name/.test(traversal.message), traversal && traversal.message);

  let noFiles = null;
  try {
    await executor.execute({ files: [] });
  } catch (err) {
    noFiles = err;
  }
  check('empty file set rejected', noFiles && /No source files/.test(noFiles.message), noFiles && noFiles.message);

  // ---------------------------------------------------------------- summary
  const passed = results.filter((r) => r.ok).length;
  console.log('\n=== summary ===');
  console.log(`  ${passed}/${results.length} checks passed`);
  if (failures) {
    console.log(`  ${failures} FAILED`);
    process.exit(1);
  }
  console.log('  all good');
})().catch((err) => {
  console.error('suite crashed:', err);
  process.exit(3);
});
