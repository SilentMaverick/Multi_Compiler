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
      },
      launcher: process.platform === 'win32' && runner.helperAvailable() ? 'jobobject' : 'fallback',
      helperBuilt: runner.helperAvailable(),
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
      const status = err instanceof executor.HttpError ? err.status : 500;
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
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = { main };
