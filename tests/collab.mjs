// Operational-transform and access-key checks for live sharing, at the API level.
// Needs a running server; skipped automatically when there isn't one.
const BASE = process.env.MULTICODER_URL || 'http://127.0.0.1:7788';
let pass = 0;
let fail = 0;
const check = (n, ok, d) => {
  ok ? pass++ : fail++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${n}${ok ? '' : ` -> ${d}`}`);
};
const post = (u, b) =>
  fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

try {
  const probe = await fetch(`${BASE}/api/health`);
  if (!probe.ok) throw new Error(`health ${probe.status}`);
} catch {
  console.log('  SKIP: no server at ' + BASE + ' (run "npm start" first)');
  process.exit(0);
}

(async () => {
  // ---------------------------------------------------------------- room
  let r = await post('/api/collab/rooms', { fileName: 'main.cpp', language: 'cpp', content: 'hello world' });
  const { room } = await r.json();
  const key = room.secret;
  check('room created', r.status === 201 && room.id, r.status);
  check('room issues an access key', typeof key === 'string' && key.length >= 16, key);
  check('key is not the room id', key !== room.id, key);

  const snap = await (await fetch(`${BASE}/api/collab/${room.id}/snapshot?key=${key}`)).json();
  check('snapshot has the document', snap.doc === 'hello world' && snap.rev === 0, JSON.stringify(snap));
  check('snapshot does not leak the key', !('secret' in snap) && !JSON.stringify(snap).includes(key), 'key leaked');

  // ---------------------------------------------------------------- auth
  const noKey = await fetch(`${BASE}/api/collab/${room.id}/snapshot`);
  check('snapshot without a key is rejected', noKey.status === 401, noKey.status);

  const badKey = await post(`/api/collab/${room.id}/ops`, {
    clientId: 'X',
    key: 'wrong-key-value',
    rev: 0,
    op: { pos: 0, del: 0, ins: 'x' },
  });
  check('ops with a wrong key are rejected', badKey.status === 401, badKey.status);

  const noKeyStream = await fetch(`${BASE}/api/collab/${room.id}/stream?clientId=Q`);
  check('stream without a key is rejected', noKeyStream.status === 401, noKeyStream.status);

  const roomList = await (await fetch(`${BASE}/api/collab`)).json();
  check('room listing hides keys', !JSON.stringify(roomList).includes(key), 'key leaked in list');

  // ---------------------------------------------------------------- sequential
  r = await post(`/api/collab/${room.id}/ops`, { clientId: 'A', key, rev: 0, op: { pos: 0, del: 0, ins: 'A' } });
  let d = await r.json();
  check('op applied at rev 0 -> rev 1', d.rev === 1, JSON.stringify(d));

  r = await post(`/api/collab/${room.id}/ops`, { clientId: 'B', key, rev: 1, op: { pos: 0, del: 0, ins: 'B' } });
  d = await r.json();
  const s2 = await (await fetch(`${BASE}/api/collab/${room.id}/snapshot?key=${key}`)).json();
  check('sequential ops both land', s2.doc === 'BAhello world', JSON.stringify(s2.doc));

  // ---------------------------------------------------------------- concurrent
  const rev = s2.rev;
  await Promise.all([
    post(`/api/collab/${room.id}/ops`, { clientId: 'A', key, rev, op: { pos: 11, del: 0, ins: ' [A]' } }).then((x) => x.json()),
    post(`/api/collab/${room.id}/ops`, { clientId: 'B', key, rev, op: { pos: 11, del: 0, ins: ' [B]' } }).then((x) => x.json()),
  ]);
  const s3 = await (await fetch(`${BASE}/api/collab/${room.id}/snapshot?key=${key}`)).json();
  check('concurrent inserts both survive', s3.doc.includes('[A]') && s3.doc.includes('[B]'), JSON.stringify(s3.doc));
  check('revision advanced twice', s3.rev === rev + 2, `${rev} -> ${s3.rev}`);

  // ---------------------------------------------------------------- delete
  const before = s3.doc;
  await post(`/api/collab/${room.id}/ops`, { clientId: 'A', key, rev: s3.rev, op: { pos: 0, del: 2, ins: '' } });
  const s4 = await (await fetch(`${BASE}/api/collab/${room.id}/snapshot?key=${key}`)).json();
  check('delete removes exactly two chars', s4.doc.length === before.length - 2, `${before.length} -> ${s4.doc.length}`);
  check('delete result correct', s4.doc === before.slice(2), JSON.stringify(s4.doc));

  // ---------------------------------------------------------------- staleness + validation
  const stale = await post(`/api/collab/${room.id}/ops`, { clientId: 'C', key, rev: -5, op: { pos: 0, del: 0, ins: 'x' } });
  check('stale client is told to resync', (await stale.json()).resync === true, 'no resync flag');

  const bad = await post(`/api/collab/${room.id}/ops`, { clientId: 'A', key, rev: s4.rev, op: { pos: 'nope' } });
  check('bad op rejected', bad.status === 400, bad.status);

  const missing = await fetch(`${BASE}/api/collab/nosuchroom/snapshot?key=${key}`);
  check('unknown room 404s', missing.status === 404, missing.status);

  // ---------------------------------------------------------------- presence + SSE
  const controller = new AbortController();
  const events = [];
  const stream = (async () => {
    const res = await fetch(`${BASE}/api/collab/${room.id}/stream?clientId=Z&name=zeta&key=${key}`, {
      signal: controller.signal,
    });
    const reader = res.body.getReader();
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
        if (line) events.push(JSON.parse(line.slice(6)));
      }
    }
  })().catch(() => {});

  await new Promise((res) => setTimeout(res, 800));
  check('stream sends a snapshot first', events.some((e) => e.t === 'snapshot'), JSON.stringify(events.slice(0, 2)));
  check('stream reports presence', events.some((e) => e.t === 'presence'), 'no presence');

  await post(`/api/collab/${room.id}/ops`, { clientId: 'A', key, rev: s4.rev, op: { pos: 0, del: 0, ins: 'Z' } });
  await new Promise((res) => setTimeout(res, 600));
  const ops = events.filter((e) => e.t === 'ops');
  check('stream relays operations', ops.length >= 1 && ops[0].op.ins === 'Z', JSON.stringify(ops.slice(0, 2)));

  controller.abort();
  await post(`/api/collab/${room.id}/leave`, { clientId: 'Z', key });

  console.log(`\n  ${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('crashed:', e);
  process.exit(3);
});
