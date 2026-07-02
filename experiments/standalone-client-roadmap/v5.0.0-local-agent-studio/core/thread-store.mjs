import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class ThreadStore {
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    try { chmodSync(file, 0o600); } catch {}
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        workspace TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        role TEXT,
        content TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE(thread_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_threads_updated ON threads(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_items_thread_seq ON items(thread_id, seq);
    `);
  }

  createThread({ title = "New thread", provider = "openai", model = "", workspace = "" } = {}) {
    const id = `thr_${randomUUID().replaceAll("-", "")}`;
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO threads (id,title,provider,model,workspace,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, cleanTitle(title), provider, model, workspace, now, now);
    return this.getThread(id);
  }

  listThreads({ limit = 50, includeArchived = false } = {}) {
    const size = Math.max(1, Math.min(Number(limit) || 50, 200));
    const sql = includeArchived
      ? `SELECT * FROM threads ORDER BY updated_at DESC LIMIT ?`
      : `SELECT * FROM threads WHERE status != 'archived' ORDER BY updated_at DESC LIMIT ?`;
    return this.db.prepare(sql).all(size).map(mapThread);
  }

  getThread(id) {
    const row = this.db.prepare(`SELECT * FROM threads WHERE id=?`).get(id);
    return row ? mapThread(row) : null;
  }

  archiveThread(id) {
    this.db.prepare(`UPDATE threads SET status='archived', updated_at=? WHERE id=?`).run(new Date().toISOString(), id);
    return this.getThread(id);
  }

  startTurn(threadId) {
    this.requireThread(threadId);
    const id = `turn_${randomUUID().replaceAll("-", "")}`;
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO turns (id,thread_id,status,created_at) VALUES (?,?,'running',?)`).run(id, threadId, now);
    this.touch(threadId, now);
    return { id, threadId, status: "running", createdAt: now };
  }

  finishTurn(turnId, { status = "completed", error = null } = {}) {
    const completedAt = new Date().toISOString();
    this.db.prepare(`UPDATE turns SET status=?, error=?, completed_at=? WHERE id=?`).run(status, error, completedAt, turnId);
    return this.db.prepare(`SELECT * FROM turns WHERE id=?`).get(turnId) || null;
  }

  appendItem(threadId, { turnId = null, type = "message", role = null, content = "", metadata = {} } = {}) {
    this.requireThread(threadId);
    const id = `item_${randomUUID().replaceAll("-", "")}`;
    const createdAt = new Date().toISOString();
    const seq = Number(this.db.prepare(`SELECT COALESCE(MAX(seq),0)+1 AS next FROM items WHERE thread_id=?`).get(threadId).next);
    this.db.prepare(`INSERT INTO items (id,thread_id,turn_id,seq,type,role,content,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, threadId, turnId, seq, type, role, String(content), JSON.stringify(metadata || {}), createdAt);
    this.touch(threadId, createdAt);
    return { id, threadId, turnId, seq, type, role, content: String(content), metadata, createdAt };
  }

  listItems(threadId, { limit = 100, beforeSeq = null } = {}) {
    this.requireThread(threadId);
    const size = Math.max(1, Math.min(Number(limit) || 100, 500));
    const rows = beforeSeq == null
      ? this.db.prepare(`SELECT * FROM items WHERE thread_id=? ORDER BY seq DESC LIMIT ?`).all(threadId, size)
      : this.db.prepare(`SELECT * FROM items WHERE thread_id=? AND seq<? ORDER BY seq DESC LIMIT ?`).all(threadId, Number(beforeSeq), size);
    return rows.reverse().map(mapItem);
  }

  recentMessages(threadId, limit = 40) {
    const size = Math.max(1, Math.min(Number(limit) || 40, 200));
    return this.db.prepare(`SELECT * FROM items WHERE thread_id=? AND type='message' AND role IN ('user','assistant') ORDER BY seq DESC LIMIT ?`)
      .all(threadId, size).reverse().map(mapItem);
  }

  setSummary(threadId, summary) {
    this.requireThread(threadId);
    this.db.prepare(`UPDATE threads SET summary=?, updated_at=? WHERE id=?`).run(String(summary || ""), new Date().toISOString(), threadId);
    return this.getThread(threadId);
  }

  close() {
    this.db.close();
  }

  requireThread(id) {
    const thread = this.getThread(id);
    if (!thread) throw new Error(`Thread not found: ${id}`);
    return thread;
  }

  touch(id, at = new Date().toISOString()) {
    this.db.prepare(`UPDATE threads SET updated_at=? WHERE id=?`).run(at, id);
  }
}

function mapThread(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    provider: row.provider,
    model: row.model,
    workspace: row.workspace,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapItem(row) {
  return {
    id: row.id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    seq: row.seq,
    type: row.type,
    role: row.role,
    content: row.content,
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at
  };
}

function parseJson(value) {
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

function cleanTitle(value) {
  return String(value || "New thread").replace(/\s+/g, " ").trim().slice(0, 120) || "New thread";
}
