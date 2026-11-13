'use strict';

/**
 * Multi-Coder server: static IDE + a JSON run API.
 * Zero dependencies - Node built-ins only.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');

const executor = require('./src/executor');
const toolchains = require('./src/toolchains');
const runner = require('./src/runner');
const examples = require('./src/examples');
const sessions = require('./src/sessions');
const snippets = require('./src/snippets');
const exportReport = require('./src/export');
const debuggerApi = require('./src/debugger');
const stress = require('./src/stress');
const problems = require('./src/problems');
const collab = require('./src/collab');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const MAX_BODY = 8 * 1024 * 1024;
const MAX_CONCURRENT_RUNS = 2;

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const opts = { port: Number(process.env.PORT) || 7788, host: '127.0.0.1', open: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') opts.port = Number(argv[++i]) || opts.port;
    else if (a === '--host') opts.host = argv[++i] || opts.host;
    else if (a === '--open') opts.open = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node server.js [--port 7788] [--host 127.0.0.1] [--open]');
      process.exit(0);
    }
  }
  return opts;
}

// ---------------------------------------------------------------- helpers
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new executor.HttpError(413, 'Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new executor.HttpError(400, 'Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

// A tiny semaphore so two browser tabs cannot compile at the same time forever.
let active = 0;
const waiting = [];
function withSlot(fn) {
  return new Promise((resolve, reject) => {
    waiting.push({ fn, resolve, reject });
    pump();
  });
}
function pump() {
  while (active < MAX_CONCURRENT_RUNS && waiting.length) {
    const job = waiting.shift();
    active++;
    Promise.resolve()
      .then(job.fn)
      .then(job.resolve, job.reject)
      .finally(() => {
        active--;
        pump();
      });
  }
}

// ---------------------------------------------------------------- routing
async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.join(PUBLIC, path.normalize(rel).replace(/^([/\\])+/, ''));
  const resolved = path.resolve(target);

  if (!resolved.startsWith(path.resolve(PUBLIC) + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  let stat;
  try {
    stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }

  const ext = path.extname(resolved).toLowerCase();
  const vendor = resolved.includes(`${path.sep}vendor${path.sep}`);
  const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    return res.end();
  }

  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    ETag: etag,
    'Cache-Control': vendor ? 'public, max-age=86400' : 'no-cache',
  });
  fs.createReadStream(resolved).pipe(res);
}

/** Server-Sent Events for a shared editing room. */
function streamCollab(req, res, roomId, url) {
  const clientId = url.searchParams.get('clientId') || '';
  const name = url.searchParams.get('name') || 'guest';

  let room;
  try {
    room = collab.join(roomId, clientId, name);
  } catch (err) {
    res.writeHead(Number.isInteger(err.status) ? err.status : 500, { 'Content-Type': 'text/plain' });
    return res.end(err.message);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      /* client gone */
    }
  };

  res.write(': connected\n\n');
  send({ t: 'snapshot', doc: room.doc, rev: room.rev, fileName: room.fileName, language: room.language });
  send({ t: 'presence', clients: room.presence() });

  room.subscribers.add(send);
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 15000);

  const cleanup = () => {
    clearInterval(heartbeat);
    room.subscribers.delete(send);
    collab.leave(roomId, clientId);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

/** Server-Sent Events: replays what the program already printed, then streams. */
function streamSession(req, res, session) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (ev) => {
    try {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    } catch {
      /* client went away */
    }
  };

  res.write(': connected\n\n');
  for (const ev of session.buffer) send(ev);

  if (session.closed) {
    send({ t: 'x', code: session.exitCode, signal: session.signal });
    return res.end();
  }

  const unsubscribe = session.subscribe(send);
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 15000);

  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname === '/api/health') {
    const tc = await toolchains.detect(Boolean(url.searchParams.get('refresh')));
    return sendJson(res, 200, {
      ok: true,
      toolchains: {
        cpp: { ok: tc.cpp.ok, version: tc.cpp.version, compiler: tc.cpp.compiler },
        c: { ok: tc.c.ok, version: tc.c.version, compiler: tc.c.compiler },
        java: { ok: tc.java.ok, version: tc.java.version, javac: tc.java.javac, java: tc.java.java },
        python: { ok: tc.python.ok, version: tc.python.version, bin: tc.python.bin },
        javascript: { ok: tc.js.ok, version: tc.js.version, bin: tc.js.bin },
      },
      launcher: process.platform === 'win32' && runner.helperAvailable() ? 'jobobject' : 'fallback',
      helperBuilt: runner.helperAvailable(),
      cache: executor.cacheStats(),
      sessions: sessions.list().length,
      sessionLimit: sessions.MAX_SESSIONS,
      debugSessions: debuggerApi.list().length,
      collabRooms: collab.list(),
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      cpus: os.cpus().length,
      limits: executor.DEFAULT_LIMITS,
      root: ROOT,
    });
  }

  if (pathname === '/api/examples') {
    return sendJson(res, 200, { examples: examples.list() });
  }

  // ------------------------------------------------------------ live sharing
  if (pathname === '/api/collab/rooms' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 201, { room: collab.createRoom(body) });
  }

  if (pathname === '/api/collab') {
    return sendJson(res, 200, { rooms: collab.list() });
  }

  const collabMatch = /^\/api\/collab\/([^/]+)\/(stream|ops|leave|snapshot)$/.exec(pathname);
  if (collabMatch) {
    const roomId = decodeURIComponent(collabMatch[1]);
    const action = collabMatch[2];
    try {
      if (action === 'stream' && req.method === 'GET') return streamCollab(req, res, roomId, url);
      if (action === 'ops' && req.method === 'POST') {
        const body = await readBody(req);
        return sendJson(res, 200, collab.submit(roomId, body));
      }
      if (action === 'leave' && req.method === 'POST') {
        const body = await readBody(req);
        collab.leave(roomId, body.clientId);
        return sendJson(res, 200, { ok: true });
      }
      if (action === 'snapshot') return sendJson(res, 200, collab.snapshot(roomId));
    } catch (err) {
      return sendJson(res, Number.isInteger(err.status) ? err.status : 500, { ok: false, error: err.message });
    }
  }

  // ------------------------------------------------------------ snippets (#6)
  if (pathname === '/api/snippets') {
    if (req.method === 'GET') return sendJson(res, 200, { snippets: snippets.list() });
    if (req.method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 201, { snippet: snippets.create(body) });
    }
  }

  if (pathname.startsWith('/api/snippets/')) {
    const id = decodeURIComponent(pathname.slice('/api/snippets/'.length));
    if (!id || id.includes('/')) return sendJson(res, 404, { ok: false, error: 'Unknown snippet.' });
    if (req.method === 'GET') return sendJson(res, 200, { snippet: snippets.get(id) });
    if (req.method === 'PUT' || req.method === 'PATCH') {
      const body = await readBody(req);
      return sendJson(res, 200, { snippet: snippets.update(id, body) });
    }
    if (req.method === 'DELETE') {
      snippets.remove(id);
      return sendJson(res, 200, { ok: true });
    }
  }

  // ------------------------------------------------------------ export (#8)
  if (pathname === '/api/export' && req.method === 'POST') {
    const body = await readBody(req);
    const html = exportReport.renderReport({
      title: body.title || 'Multi-Coder report',
      language: body.language,
      files: body.files,
      result: body.result || null,
      notes: body.notes,
    });
    const buf = Buffer.from(html, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    return res.end(buf);
  }

  // ------------------------------------------------------------ sessions (#7)
  if (pathname === '/api/session/start' && req.method === 'POST') {
    const body = await readBody(req);
    const result = await withSlot(() => sessions.start(body));
    return sendJson(res, result.ok ? 201 : 200, result);
  }

  const sessionMatch = /^\/api\/session\/([^/]+)\/(stream|input|stop|state)$/.exec(pathname);
  if (sessionMatch) {
    const id = decodeURIComponent(sessionMatch[1]);
    const action = sessionMatch[2];
    const session = sessions.get(id);
    if (!session) return sendJson(res, 404, { ok: false, error: 'That session has ended or expired.' });

    if (action === 'stream' && req.method === 'GET') return streamSession(req, res, session);
    if (action === 'input' && req.method === 'POST') {
      const body = await readBody(req);
      const ok = sessions.input(id, typeof body.data === 'string' ? body.data : '');
      return sendJson(res, 200, { ok });
    }
    if (action === 'stop' && req.method === 'POST') {
      sessions.stop(id);
      return sendJson(res, 200, { ok: true });
    }
    if (action === 'state') {
      return sendJson(res, 200, {
        ok: true,
        closed: session.closed,
        exitCode: session.exitCode,
        startedAt: session.startedAt,
      });
    }
  }

  // ------------------------------------------------------------ debugger (#2)
  if (pathname === '/api/debug/start' && req.method === 'POST') {
    const body = await readBody(req);
    const result = await withSlot(() => debuggerApi.start(body));
    return sendJson(res, result.ok ? 201 : 200, result);
  }

  const debugMatch = /^\/api\/debug\/([^/]+)\/(cmd|stop|state)$/.exec(pathname);
  if (debugMatch) {
    const id = decodeURIComponent(debugMatch[1]);
    const action = debugMatch[2];
    if (action === 'stop' && req.method === 'POST') {
      debuggerApi.stop(id);
      return sendJson(res, 200, { ok: true });
    }
    if (action === 'cmd' && req.method === 'POST') {
      const body = await readBody(req);
      const state = await debuggerApi.command(id, body.action, body);
      return sendJson(res, 200, { ok: true, state });
    }
    if (action === 'state') {
      const state = await debuggerApi.command(id, 'state');
      return sendJson(res, 200, { ok: true, state });
    }
  }

  // ------------------------------------------------------------ practice (#1)
  if (pathname === '/api/problems') {
    return sendJson(res, 200, { problems: problems.list() });
  }
  if (pathname.startsWith('/api/problems/')) {
    const id = decodeURIComponent(pathname.slice('/api/problems/'.length));
    const problem = problems.get(id);
    if (!problem) return sendJson(res, 404, { ok: false, error: 'No such problem.' });
    return sendJson(res, 200, { problem });
  }

  // ------------------------------------------------------------ stress (#3)
  if (pathname === '/api/stress' && req.method === 'POST') {
    const body = await readBody(req);
    const result = await withSlot(() => stress.stress(body));
    return sendJson(res, 200, result);
  }

  if (pathname === '/api/run' && req.method === 'POST') {
    const body = await readBody(req);
    const result = await withSlot(() => executor.execute(body, { keepArtifacts: url.searchParams.get('keep') === '1' }));
    return sendJson(res, result.ok ? 200 : 200, result);
  }

  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { ok: false, error: `Unknown endpoint ${pathname}` });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    return res.end('Method not allowed');
  }

  return serveStatic(req, res, pathname);
}

// ---------------------------------------------------------------- main
function main() {
  const opts = parseArgs(process.argv);

  // Drop artifacts left behind by a previous crash so .build cannot grow forever.
  try {
    const buildDir = path.join(ROOT, '.build');
    if (fs.existsSync(buildDir)) {
      for (const entry of fs.readdirSync(buildDir)) {
        fs.rmSync(path.join(buildDir, entry), { recursive: true, force: true });
      }
    }
  } catch {
    /* not fatal */
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = Number.isInteger(err.status) ? err.status : 500;
      if (!res.headersSent) sendJson(res, status, { ok: false, error: err.message });
      else res.end();
      if (status >= 500) console.error('[error]', err);
    });
  });

  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;

  let attempts = 0;
  const listen = (port) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && attempts < 10) {
        attempts++;
        listen(port + 1);
      } else {
        console.error('Failed to start:', err.message);
        process.exit(1);
      }
    });
    server.listen(port, opts.host, async () => {
      const tc = await toolchains.detect(true);
      const url = `http://${opts.host}:${port}`;
      console.log('');
      console.log('  Multi-Coder  -  C++ / Java in the browser');
      console.log(`  ${url}`);
      console.log('');
      console.log(`  g++   : ${tc.cpp.ok ? tc.cpp.label : 'NOT FOUND  -> npm run setup'}`);
      console.log(`  javac : ${tc.java.ok ? tc.java.label : 'NOT FOUND  -> npm run setup'}`);
      console.log(`  limits: ${runner.helperAvailable() ? 'kernel job object' : 'userspace fallback'}`);
      console.log('  Ctrl+C to stop');
      console.log('');

      if (opts.open) {
        const { exec } = require('child_process');
        const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
        exec(cmd, () => {});
      }
    });
  };
  listen(opts.port);

  const shutdown = () => {
    console.log('\n  shutting down...');
    try {
      sessions.shutdown();
      debuggerApi.shutdown();
    } catch {
      /* ignore */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = { main };
