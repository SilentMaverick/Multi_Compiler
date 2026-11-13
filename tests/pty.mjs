// Pseudo-console sessions: echo, colour output and two-way input.
// Needs a running server; skipped when there isn't one.
const BASE = process.env.MULTICODER_URL || 'http://127.0.0.1:7788';
let pass = 0;
let fail = 0;
const check = (n, ok, d) => {
  ok ? pass++ : fail++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${n}${ok ? '' : ` -> ${d}`}`);
};
const post = (u, b) =>
  fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const probe = await fetch(`${BASE}/api/health`);
  if (!probe.ok) throw new Error('down');
} catch {
  console.log('  SKIP: no server at ' + BASE);
  process.exit(0);
}

const SRC = `#include <iostream>
#include <string>
int main() {
    std::cout << "\\x1b[32mName?\\x1b[0m " << std::flush;
    std::string n;
    std::getline(std::cin, n);
    std::cout << "Hi \\x1b[1m" << n << "\\x1b[0m!\\n";
    return 0;
}
`;

(async () => {
  const res = await post('/api/session/start', {
    files: [{ name: 'main.cpp', content: SRC }],
    limits: { timeMs: 5000, memoryMB: 256 },
    pty: true,
  });
  const started = await res.json();
  check('pty session starts', res.status === 201 && started.ok, JSON.stringify(started).slice(0, 200));
  check('server reports pty mode', started.pty === true, started.pty);
  if (!started.ok) process.exit(1);

  let out = '';
  const controller = new AbortController();
  const streamDone = (async () => {
    const s = await fetch(`${BASE}/api/session/${started.sessionId}/stream`, { signal: controller.signal });
    const reader = s.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        const msg = JSON.parse(line.slice(6));
        if (msg.t === 'o' || msg.t === 'e') out += msg.d;
      }
    }
  })().catch(() => {});

  await sleep(900);
  check('prompt is printed', /Name\?/.test(out), JSON.stringify(out));

  // Enter in a console is CR, not LF
  await post(`/api/session/${started.sessionId}/input`, { data: 'Ada\r' });
  await sleep(900);

  const visible = out.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
  check('console echoes what was typed', /Ada/.test(visible), JSON.stringify(visible));
  check('program received the line', /Hi\s*Ada/.test(visible), JSON.stringify(visible));
  check('ANSI colour reaches the client', out.includes('\u001b[32m') || out.includes('\u001b[1m'), JSON.stringify(out.slice(0, 80)));

  await sleep(600);
  controller.abort();
  await post(`/api/session/${started.sessionId}/stop`, {});

  // pty:false still works over plain pipes
  const plain = await (
    await post('/api/session/start', {
      files: [{ name: 'main.cpp', content: 'int main(){ return 0; }' }],
      limits: { timeMs: 4000, memoryMB: 256 },
      pty: false,
    })
  ).json();
  check('pipe mode still available', plain.ok === true && plain.pty === false, JSON.stringify(plain).slice(0, 120));
  await post(`/api/session/${plain.sessionId}/stop`, {});

  console.log(`\n  ${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('crashed:', e);
  process.exit(3);
});
