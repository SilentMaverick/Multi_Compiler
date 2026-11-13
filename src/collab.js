'use strict';

/**
 * Live sharing / collaborative editing.
 *
 * A room holds one document (the file being edited) plus a revision counter and a
 * bounded history of operations. Clients apply their own edits immediately, then
 * send the {@link op} (a single splice: position, delete count, inserted text)
 * together with the revision it was based on.
 *
 * The server transforms that op against everything applied since (classic
 * operational transformation for single-splice edits), so concurrent typing in
 * two browsers does not clobber each other - the same idea as OT in Google Docs,
 * minus the full document model. Clients receive the transformed op over SSE and
 * apply it with echo suppression.
 */

const crypto = require('crypto');

const ROOMS = new Map();
const HISTORY_LIMIT = 500;
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const GUEST_COLORS = ['#4f8cff', '#2ecc8f', '#f0b429', '#ff5c6c', '#a78bfa', '#38bdf8'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function clamp(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/** Apply one splice to a string. */
function applyOp(doc, op) {
  const pos = clamp(op.pos, 0, doc.length);
  const del = clamp(op.del, 0, doc.length - pos);
  return doc.slice(0, pos) + op.ins + doc.slice(pos + del);
}

/**
 * Transform `op` (based on a document) so it can be applied *after* `against`.
 * Both are single splices; the overlap case is resolved conservatively by keeping
 * the remote insertion and trimming the local deletion to what survives.
 */
function transform(op, against) {
  let pos = clamp(op.pos, 0, Number.MAX_SAFE_INTEGER);
  let del = Math.max(0, Number(op.del) || 0);
  const ins = String(op.ins || '');

  const bStart = clamp(against.pos, 0, Number.MAX_SAFE_INTEGER);
  const bEnd = bStart + Math.max(0, Number(against.del) || 0);
  const aStart = pos;
  const aEnd = pos + del;
  const shift = String(against.ins || '').length - (Number(against.del) || 0);

  if (bEnd <= aStart) {
    // the other edit happened entirely before us: shift right by its net change
    pos += shift;
  } else if (bStart >= aEnd) {
    // entirely after us: nothing to do
  } else {
    // overlapping edits: place our insertion after theirs and keep the tail
    pos = bStart + String(against.ins || '').length;
    del = Math.max(0, aEnd - Math.max(bStart, bEnd));
  }

  return { pos: Math.max(0, pos), del, ins };
}

function sanitizeOp(raw) {
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'An operation is required.');
  const pos = Number(raw.pos);
  const del = Number(raw.del);
  const ins = typeof raw.ins === 'string' ? raw.ins.slice(0, 100000) : '';
  if (!Number.isFinite(pos) || !Number.isFinite(del)) throw new HttpError(400, 'Operation needs numeric pos and del.');
  return { pos: clamp(pos, 0, Number.MAX_SAFE_INTEGER), del: clamp(del, 0, 100000), ins };
}

class Room {
  constructor({ id, fileName, language, doc }) {
    this.id = id;
    this.fileName = fileName;
    this.language = language;
    this.doc = doc;
    this.rev = 0;
    this.history = [];
    this.clients = new Map();
    this.subscribers = new Set();
    this.createdAt = Date.now();
    this.touchedAt = Date.now();
  }

  emit(event) {
    for (const send of this.subscribers) {
      try {
        send(event);
      } catch {
        /* disconnected subscriber */
      }
    }
  }

  presence() {
    return [...this.clients.values()].map((c) => ({ id: c.id, name: c.name, color: c.color }));
  }

  broadcastPresence() {
    this.emit({ t: 'presence', clients: this.presence() });
  }

  apply(clientId, baseRev, op) {
    this.touchedAt = Date.now();
    const oldest = this.rev - this.history.length;
    if (baseRev < oldest) return { resync: true };

    let transformed = op;
    for (const entry of this.history) {
      if (entry.rev > baseRev) transformed = transform(transformed, entry.op);
    }

    this.doc = applyOp(this.doc, transformed);
    this.rev += 1;
    this.history.push({ rev: this.rev, op: transformed });
    if (this.history.length > HISTORY_LIMIT) this.history.shift();

    this.emit({ t: 'ops', rev: this.rev, op: transformed, by: clientId });
    return { rev: this.rev, doc: this.doc };
  }
}

function touch(room) {
  room.touchedAt = Date.now();
}

function createRoom(body) {
  const fileName = typeof body.fileName === 'string' && body.fileName.trim() ? body.fileName.trim().slice(0, 96) : 'main.cpp';
  const language = typeof body.language === 'string' ? body.language : 'auto';
  const content = typeof body.content === 'string' ? body.content.slice(0, 512 * 1024) : '';
  const id = crypto.randomBytes(5).toString('base64url');
  const room = new Room({ id, fileName, language, doc: content });
  ROOMS.set(id, room);
  return { id, fileName, language, rev: room.rev };
}

function getRoom(id) {
  const room = ROOMS.get(id);
  if (!room) throw new HttpError(404, 'That shared session does not exist (or expired).');
  touch(room);
  return room;
}

function join(roomId, clientId, name) {
  const room = getRoom(roomId);
  const id = String(clientId || crypto.randomBytes(4).toString('hex')).slice(0, 64);
  if (!room.clients.has(id)) {
    const color = GUEST_COLORS[room.clients.size % GUEST_COLORS.length];
    room.clients.set(id, {
      id,
      name: String(name || 'guest').slice(0, 32),
      color,
      joinedAt: Date.now(),
    });
    room.broadcastPresence();
  }
  return room;
}

function leave(roomId, clientId) {
  const room = ROOMS.get(roomId);
  if (!room) return;
  if (room.clients.delete(String(clientId))) room.broadcastPresence();
}

function submit(roomId, body) {
  const room = getRoom(roomId);
  const op = sanitizeOp(body.op);
  const baseRev = Number.isFinite(Number(body.rev)) ? Number(body.rev) : room.rev;
  return room.apply(String(body.clientId || 'anon').slice(0, 64), baseRev, op);
}

function snapshot(roomId) {
  const room = getRoom(roomId);
  return {
    id: room.id,
    fileName: room.fileName,
    language: room.language,
    doc: room.doc,
    rev: room.rev,
    clients: room.presence(),
  };
}

function list() {
  return [...ROOMS.values()].map((r) => ({
    id: r.id,
    fileName: r.fileName,
    rev: r.rev,
    clients: r.clients.size,
    createdAt: r.createdAt,
  }));
}

/** Drop rooms nobody has touched for an hour. */
function sweep() {
  const now = Date.now();
  for (const [id, room] of ROOMS) {
    if (room.subscribers.size === 0 && now - room.touchedAt > IDLE_TIMEOUT_MS) ROOMS.delete(id);
  }
}

const sweeper = setInterval(sweep, 10 * 60 * 1000);
sweeper.unref?.();

module.exports = {
  createRoom,
  getRoom,
  join,
  leave,
  submit,
  snapshot,
  list,
  applyOp,
  transform,
  HttpError,
  ROOMS,
};
