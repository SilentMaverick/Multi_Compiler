'use strict';

/**
 * Snippet library (#6).
 *
 * Saved programs live server-side in .data/snippets.json rather than in
 * localStorage, so they survive clearing site data, are visible from any
 * browser, and can be backed up by copying one file.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, '.data');
const FILE = path.join(DATA_DIR, 'snippets.json');

const MAX_SNIPPETS = 300;
const MAX_NAME = 80;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.snippets)) return { version: 1, snippets: [] };
    return parsed;
  } catch {
    return { version: 1, snippets: [] };
  }
}

function persist(db) {
  ensureDir();
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

function sanitizeName(name) {
  const clean = String(name == null ? '' : name).trim().replace(/\s+/g, ' ');
  if (!clean) throw new HttpError(400, 'A snippet needs a name.');
  if (clean.length > MAX_NAME) throw new HttpError(400, `Name must be under ${MAX_NAME} characters.`);
  return clean;
}

function sanitizePayload(payload) {
  const files = Array.isArray(payload.files) ? payload.files : [];
  if (!files.length) throw new HttpError(400, 'Nothing to save: no files.');
  const cleanFiles = files.map((f) => {
    if (typeof f.name !== 'string' || !f.name.trim()) throw new HttpError(400, 'Every file needs a name.');
    if (typeof f.content !== 'string') throw new HttpError(400, 'File content must be text.');
    if (Buffer.byteLength(f.content, 'utf8') > 512 * 1024) throw new HttpError(413, `${f.name} is too large to save.`);
    return { name: f.name, content: f.content };
  });

  const tests = Array.isArray(payload.tests)
    ? payload.tests.slice(0, 50).map((t) => ({
        input: typeof t.input === 'string' ? t.input.slice(0, 64 * 1024) : '',
        expected: typeof t.expected === 'string' ? t.expected.slice(0, 64 * 1024) : '',
      }))
    : [];

  return {
    files: cleanFiles,
    stdin: typeof payload.stdin === 'string' ? payload.stdin.slice(0, 256 * 1024) : '',
    tests,
    language: ['auto', 'cpp', 'c', 'java', 'python', 'javascript'].includes(payload.language) ? payload.language : 'auto',
    limits: {
      timeMs: clamp(payload.limits && payload.limits.timeMs, 100, 30000, 5000),
      memoryMB: clamp(payload.limits && payload.limits.memoryMB, 16, 4096, 256),
    },
  };
}

function clamp(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Summaries for the list; full content is only sent when a snippet is opened. */
function summarize(s) {
  return {
    id: s.id,
    name: s.name,
    language: s.language,
    files: s.files.map((f) => f.name),
    lines: s.files.reduce((n, f) => n + f.content.split(/\r?\n/).length, 0),
    tests: s.tests.length,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    bytes: s.files.reduce((n, f) => n + Buffer.byteLength(f.content, 'utf8'), 0),
  };
}

function list() {
  const db = load();
  return db.snippets
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(summarize);
}

function get(id) {
  const db = load();
  const found = db.snippets.find((s) => s.id === id);
  if (!found) throw new HttpError(404, 'Snippet not found.');
  return found;
}

function create(payload) {
  const db = load();
  if (db.snippets.length >= MAX_SNIPPETS) {
    throw new HttpError(507, `Snippet limit reached (${MAX_SNIPPETS}). Delete some first.`);
  }
  const name = sanitizeName(payload.name);
  const clean = sanitizePayload(payload);
  const now = new Date().toISOString();
  const snippet = {
    id: crypto.randomUUID(),
    name,
    ...clean,
    createdAt: now,
    updatedAt: now,
  };
  db.snippets.push(snippet);
  persist(db);
  return snippet;
}

function update(id, payload) {
  const db = load();
  const idx = db.snippets.findIndex((s) => s.id === id);
  if (idx < 0) throw new HttpError(404, 'Snippet not found.');
  const existing = db.snippets[idx];

  const next = { ...existing };
  if (payload.name !== undefined) next.name = sanitizeName(payload.name);
  if (payload.files !== undefined) Object.assign(next, sanitizePayload({ ...existing, ...payload }));
  else if (payload.stdin !== undefined || payload.tests !== undefined || payload.language !== undefined) {
    Object.assign(next, sanitizePayload({ ...existing, ...payload }));
  }
  next.updatedAt = new Date().toISOString();
  db.snippets[idx] = next;
  persist(db);
  return next;
}

function remove(id) {
  const db = load();
  const before = db.snippets.length;
  db.snippets = db.snippets.filter((s) => s.id !== id);
  if (db.snippets.length === before) throw new HttpError(404, 'Snippet not found.');
  persist(db);
  return true;
}

module.exports = { list, get, create, update, remove, HttpError, FILE };
