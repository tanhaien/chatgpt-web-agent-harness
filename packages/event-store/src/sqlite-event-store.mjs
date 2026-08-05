import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { validateHarnessEvent, validateEventCursor } from "../../contracts/src/index.mjs";

// ── Error classes ───────────────────────────────────────────────

export class EventStoreConflictError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EventStoreConflictError";
    this.code = code;
  }
}

export class EventStoreClosedError extends Error {
  constructor() {
    super("Event store is closed");
    this.name = "EventStoreClosedError";
  }
}

// ── Constants ───────────────────────────────────────────────────

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    event_id       TEXT PRIMARY KEY,
    task_id        TEXT NOT NULL,
    run_id         TEXT NOT NULL,
    step_id        TEXT,
    agent_id       TEXT,
    trace_id       TEXT,
    causation_id   TEXT,
    correlation_id TEXT,
    idempotency_key TEXT,
    type           TEXT NOT NULL,
    sequence       INTEGER NOT NULL,
    timestamp      TEXT NOT NULL,
    payload_json   TEXT NOT NULL,
    metadata_json  TEXT NOT NULL,
    UNIQUE(task_id, sequence)
  );

  CREATE INDEX IF NOT EXISTS idx_events_task_seq ON events(task_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idempotency
    ON events(task_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
`;

const DEFAULT_LIMIT = 100;
const VERSION = 1;

// ── Helpers ─────────────────────────────────────────────────────

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function rowToEvent(row) {
  const event = {
    eventId: row.event_id,
    taskId: row.task_id,
    runId: row.run_id,
    type: row.type,
    sequence: row.sequence,
    timestamp: row.timestamp,
    payload: JSON.parse(row.payload_json),
    metadata: JSON.parse(row.metadata_json)
  };
  if (row.step_id !== null) event.stepId = row.step_id;
  if (row.agent_id !== null) event.agentId = row.agent_id;
  if (row.trace_id !== null) event.traceId = row.trace_id;
  if (row.causation_id !== null) event.causationId = row.causation_id;
  if (row.correlation_id !== null) event.correlationId = row.correlation_id;
  if (row.idempotency_key !== null) event.idempotencyKey = row.idempotency_key;
  return event;
}

function classifyError(err) {
  const code = err?.code ?? "";
  const msg = err?.message ?? "";
  if (code === "SQLITE_CONSTRAINT_PRIMARYKEY") return "EVENT_ID_CONFLICT";
  if (code === "SQLITE_CONSTRAINT_UNIQUE") {
    if (msg.includes("idempotency")) return "IDEMPOTENCY_CONFLICT";
    return "SEQUENCE_CONFLICT";
  }
  return null;
}

// ── Store class ─────────────────────────────────────────────────

export class SqliteEventStore {
  #db = null;
  #appendStmt = null;
  #getByIdStmt = null;
  #getIdempotencyStmt = null;
  #latestSeqStmt = null;

  constructor(options) {
    if (!options || typeof options !== "object") throw new TypeError("options must be an object");
    const dbPath = options.dbPath;
    if (typeof dbPath !== "string" || dbPath.trim() === "") throw new TypeError("dbPath must be a non-empty string");
    const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60000) throw new TypeError("busyTimeoutMs must be an integer between 0 and 60000");

    const memory = dbPath === ":memory:";
    if (!memory) mkdirSync(dirname(dbPath), { recursive: true });

    const db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    if (!memory) db.pragma("journal_mode = WAL");
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);

    db.transaction(() => {
      db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
      const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get();
      const current = row?.v ?? 0;
      if (current < VERSION) {
        db.exec(SCHEMA_SQL);
        db.prepare("INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(VERSION, new Date().toISOString());
      }
    })();

    this.#db = db;
    this.#appendStmt = db.prepare(
      "INSERT INTO events (event_id, task_id, run_id, step_id, agent_id, trace_id, causation_id, correlation_id, idempotency_key, type, sequence, timestamp, payload_json, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    this.#getByIdStmt = db.prepare("SELECT * FROM events WHERE event_id = ?");
    this.#getIdempotencyStmt = db.prepare("SELECT * FROM events WHERE task_id = ? AND idempotency_key = ?");
    this.#latestSeqStmt = db.prepare("SELECT MAX(sequence) AS seq FROM events WHERE task_id = ?");
  }

  #ensureOpen() {
    if (!this.#db) throw new EventStoreClosedError();
  }

  append(event) {
    this.#ensureOpen();
    validateHarnessEvent(event);
    // Pre-check for precise conflict classification
    if (this.#getByIdStmt.get(event.eventId)) throw new EventStoreConflictError("EVENT_ID_CONFLICT", `event ${event.eventId} already exists`);
    const seqCheck = this.#db.prepare("SELECT 1 FROM events WHERE task_id = ? AND sequence = ?").get(event.taskId, event.sequence);
    if (seqCheck) throw new EventStoreConflictError("SEQUENCE_CONFLICT", `sequence ${event.sequence} already exists for task ${event.taskId}`);
    if (event.idempotencyKey !== undefined) {
      const idemCheck = this.#getIdempotencyStmt.get(event.taskId, event.idempotencyKey);
      if (idemCheck) throw new EventStoreConflictError("IDEMPOTENCY_CONFLICT", `idempotency key '${event.idempotencyKey}' already used for task ${event.taskId}`);
    }
    try {
      this.#appendStmt.run(
        event.eventId, event.taskId, event.runId,
        event.stepId ?? null, event.agentId ?? null, event.traceId ?? null,
        event.causationId ?? null, event.correlationId ?? null, event.idempotencyKey ?? null,
        event.type, event.sequence, event.timestamp,
        JSON.stringify(event.payload), JSON.stringify(event.metadata ?? {})
      );
    } catch (err) {
      const code = classifyError(err);
      if (code) throw new EventStoreConflictError(code, err.message);
      throw err;
    }
    return this.getById(event.eventId);
  }

  appendMany(events) {
    this.#ensureOpen();
    if (!Array.isArray(events) || events.length === 0) throw new TypeError("events must be a non-empty array");
    // Validate all before writing
    for (const e of events) validateHarnessEvent(e);
    // Intra-batch duplicate detection — stable priority: eventId, then taskId+sequence, then idempotency
    const seenIds = new Set();
    const seenSeq = new Map();
    const seenIdem = new Map();
    for (const e of events) {
      if (seenIds.has(e.eventId)) throw new EventStoreConflictError("EVENT_ID_CONFLICT", `duplicate eventId ${e.eventId} in batch`);
      seenIds.add(e.eventId);
      const seqKey = `${e.taskId}\x00${e.sequence}`;
      if (seenSeq.has(seqKey)) throw new EventStoreConflictError("SEQUENCE_CONFLICT", `duplicate (${e.taskId},${e.sequence}) in batch`);
      seenSeq.set(seqKey, true);
      if (e.idempotencyKey !== undefined) {
        const idemKey = `${e.taskId}\x00${e.idempotencyKey}`;
        if (seenIdem.has(idemKey)) throw new EventStoreConflictError("IDEMPOTENCY_CONFLICT", `duplicate idempotency key '${e.idempotencyKey}' for task ${e.taskId} in batch`);
        seenIdem.set(idemKey, true);
      }
    }
    const insert = this.#appendStmt;
    const txn = this.#db.transaction((evts) => {
      for (const e of evts) {
        // Preflight existing DB conflicts — stable priority
        if (this.#getByIdStmt.get(e.eventId)) throw new EventStoreConflictError("EVENT_ID_CONFLICT", `event ${e.eventId} already exists`);
        if (this.#db.prepare("SELECT 1 FROM events WHERE task_id = ? AND sequence = ?").get(e.taskId, e.sequence)) {
          throw new EventStoreConflictError("SEQUENCE_CONFLICT", `sequence ${e.sequence} already exists for task ${e.taskId}`);
        }
        if (e.idempotencyKey !== undefined) {
          if (this.#getIdempotencyStmt.get(e.taskId, e.idempotencyKey)) throw new EventStoreConflictError("IDEMPOTENCY_CONFLICT", `idempotency key '${e.idempotencyKey}' already used for task ${e.taskId}`);
        }
        try {
          insert.run(
            e.eventId, e.taskId, e.runId,
            e.stepId ?? null, e.agentId ?? null, e.traceId ?? null,
            e.causationId ?? null, e.correlationId ?? null, e.idempotencyKey ?? null,
            e.type, e.sequence, e.timestamp,
            JSON.stringify(e.payload), JSON.stringify(e.metadata ?? {})
          );
        } catch (err) {
          const code = classifyError(err);
          if (code) throw new EventStoreConflictError(code, err.message);
          throw err;
        }
      }
      return evts;
    });
    const inserted = txn(events);
    return inserted.map((e) => this.getById(e.eventId));
  }

  getById(eventId) {
    this.#ensureOpen();
    assertNonEmptyString(eventId, "eventId");
    const row = this.#getByIdStmt.get(eventId);
    return row ? rowToEvent(row) : null;
  }

  getByIdempotencyKey(taskId, key) {
    this.#ensureOpen();
    assertNonEmptyString(taskId, "taskId");
    assertNonEmptyString(key, "key");
    const row = this.#getIdempotencyStmt.get(taskId, key);
    return row ? rowToEvent(row) : null;
  }

  list(cursor) {
    this.#ensureOpen();
    validateEventCursor(cursor);
    const limit = cursor.limit ?? DEFAULT_LIMIT;
    const rows = this.#db.prepare(
      "SELECT * FROM events WHERE task_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?"
    ).all(cursor.taskId, cursor.afterSequence, limit);
    return rows.map(rowToEvent);
  }

  latestSequence(taskId) {
    this.#ensureOpen();
    assertNonEmptyString(taskId, "taskId");
    const row = this.#latestSeqStmt.get(taskId);
    return row?.seq ?? -1;
  }

  close() {
    if (this.#db) {
      this.#db.close();
      this.#db = null;
      this.#appendStmt = null;
      this.#getByIdStmt = null;
      this.#getIdempotencyStmt = null;
      this.#latestSeqStmt = null;
    }
  }

}

export function openSqliteEventStore(options) {
  return new SqliteEventStore(options);
}
