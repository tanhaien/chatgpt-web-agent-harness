import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openSqliteEventStore,
  EventStoreConflictError,
  EventStoreClosedError
} from "../src/index.mjs";
import { createHarnessEvent } from "../../contracts/src/index.mjs";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "event-store-test-"));
}

function freshStore(opts = {}) {
  const dir = opts.memory ? null : tmpDir();
  const path = opts.memory ? ":memory:" : join(dir, "test.db");
  const store = openSqliteEventStore({ dbPath: path, busyTimeoutMs: opts.busyTimeoutMs ?? 5000 });
  return {
    store,
    path,
    dir,
    cleanup() {
      try { store.close(); } catch (_) { /* already closed */ }
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  };
}

function makeEvent(overrides = {}) {
  return createHarnessEvent({
    taskId: "task-1",
    runId: "run-1",
    type: "task.created",
    sequence: overrides.sequence ?? 0,
    ...overrides
  });
}

// ── open / migration ───────────────────────────────────────────

{
  const { store, cleanup } = freshStore();
  assert.equal(store.latestSequence("task-1"), -1);
  cleanup();
}

{
  const { store, path, cleanup } = freshStore();
  store.close();
  // Verify migration evidence: schema_migrations has version 1, events table, indexes
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(path);
  const mig = db.prepare("SELECT version, applied_at FROM schema_migrations").all();
  assert.equal(mig.length, 1);
  assert.equal(mig[0].version, 1);
  assert.ok(mig[0].applied_at);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").all();
  assert.equal(tables.length, 1);
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'").all();
  const names = indexes.map(r => r.name);
  assert.ok(names.some(n => n.includes("task_seq")));
  assert.ok(names.some(n => n.includes("run")));
  assert.ok(names.some(n => n.includes("idempotency")));
  db.close();
  cleanup();
}

{
  // idempotent reopen does not add duplicate migration rows
  const dir = tmpDir();
  const p = join(dir, "test.db");
  openSqliteEventStore({ dbPath: p }).close();
  openSqliteEventStore({ dbPath: p }).close();
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(p);
  const mig = db.prepare("SELECT version FROM schema_migrations").all();
  assert.equal(mig.length, 1);
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// ── append / getById round-trip ────────────────────────────────

{
  const { store, cleanup } = freshStore();
  const ev = makeEvent({
    stepId: "step-1", agentId: "agent-1", traceId: "trace-1",
    causationId: "cause-1", correlationId: "corr-1", idempotencyKey: "idem-1",
    payload: { key: "value" }, metadata: { source: "test" }
  });
  const stored = store.append(ev);
  assert.equal(stored.eventId, ev.eventId);
  assert.equal(stored.taskId, "task-1");
  assert.equal(stored.stepId, "step-1");
  assert.equal(stored.agentId, "agent-1");
  assert.equal(stored.traceId, "trace-1");
  assert.equal(stored.causationId, "cause-1");
  assert.equal(stored.correlationId, "corr-1");
  assert.equal(stored.idempotencyKey, "idem-1");
  assert.deepEqual(stored.payload, { key: "value" });
  assert.deepEqual(stored.metadata, { source: "test" });

  const found = store.getById(ev.eventId);
  assert.deepEqual(found, stored);

  const byKey = store.getByIdempotencyKey("task-1", "idem-1");
  assert.deepEqual(byKey, stored);

  assert.equal(store.getById("nonexistent"), null);
  assert.equal(store.getByIdempotencyKey("task-1", "missing"), null);

  cleanup();
}

// ── metadata defaults to {} ────────────────────────────────────

{
  const { store, cleanup } = freshStore();
  const ev = createHarnessEvent({
    taskId: "t", runId: "r", type: "task.created", sequence: 0
  });
  const stored = store.append(ev);
  assert.deepEqual(stored.metadata, {});
  cleanup();
}

// ── optional fields absent when not provided ───────────────────

{
  const { store, cleanup } = freshStore();
  const ev = createHarnessEvent({
    taskId: "t", runId: "r", type: "tool.started", sequence: 5
  });
  const stored = store.append(ev);
  assert.equal(stored.stepId, undefined);
  assert.equal(stored.agentId, undefined);
  assert.equal(stored.idempotencyKey, undefined);
  cleanup();
}

// ── list ordering and cursor (afterSequence -1 sentinel) ───────

{
  const { store, cleanup } = freshStore();
  for (let i = 0; i < 5; i++) {
    const ev = createHarnessEvent({ taskId: "task-x", runId: "r", type: "step.started", sequence: i });
    store.append(ev);
  }
  // start-of-stream: afterSequence=-1 returns all including sequence 0
  const all = store.list({ taskId: "task-x", afterSequence: -1 });
  assert.equal(all.length, 5);
  assert.equal(all[0].sequence, 0);
  assert.equal(all[4].sequence, 4);
  // strict cursor (default limit 100)
  const from2 = store.list({ taskId: "task-x", afterSequence: 2 });
  assert.equal(from2.length, 2);
  assert.equal(from2[0].sequence, 3);
  // explicit limit
  const limited = store.list({ taskId: "task-x", afterSequence: -1, limit: 2 });
  assert.equal(limited.length, 2);
  assert.equal(limited[0].sequence, 0);
  // empty task
  assert.equal(store.list({ taskId: "other", afterSequence: -1 }).length, 0);
  cleanup();
}

// ── latestSequence ──────────────────────────────────────────────

{
  const { store, cleanup } = freshStore();
  assert.equal(store.latestSequence("task-seq"), -1);
  store.append(makeEvent({ taskId: "task-seq", sequence: 0 }));
  assert.equal(store.latestSequence("task-seq"), 0);
  store.append(makeEvent({ taskId: "task-seq", sequence: 7 }));
  assert.equal(store.latestSequence("task-seq"), 7);
  assert.equal(store.latestSequence("other-task"), -1);
  cleanup();
}

// ── conflict classification ────────────────────────────────────

{
  const { store, cleanup } = freshStore();
  const ev = makeEvent();
  store.append(ev);
  assert.throws(() => store.append(ev), EventStoreConflictError);
  try { store.append(ev); } catch (e) { assert.equal(e.code, "EVENT_ID_CONFLICT"); }

  const evSeq = makeEvent({ eventId: "e2", sequence: 0 });
  assert.throws(() => store.append(evSeq), EventStoreConflictError);
  try { store.append(evSeq); } catch (e) { assert.equal(e.code, "SEQUENCE_CONFLICT"); }

  const evIdem = makeEvent({ eventId: "e3", sequence: 1, idempotencyKey: "dup" });
  store.append(evIdem);
  const evIdemDup = makeEvent({ eventId: "e4", sequence: 2, idempotencyKey: "dup" });
  assert.throws(() => store.append(evIdemDup), EventStoreConflictError);
  try { store.append(evIdemDup); } catch (e) { assert.equal(e.code, "IDEMPOTENCY_CONFLICT"); }

  cleanup();
}

// ── idempotency key is task-scoped ─────────────────────────────

{
  const { store, cleanup } = freshStore();
  store.append(makeEvent({ taskId: "task-a", eventId: "ea", sequence: 0, idempotencyKey: "same" }));
  store.append(makeEvent({ taskId: "task-b", eventId: "eb", sequence: 0, idempotencyKey: "same" }));
  cleanup();
}

// ── appendMany atomic rollback ─────────────────────────────────

{
  const { store, cleanup } = freshStore();
  const good = makeEvent({ taskId: "t", eventId: "g1", sequence: 0 });
  const bad = makeEvent({ taskId: "t", eventId: "g1", sequence: 1 });
  assert.throws(() => store.appendMany([good, bad]), EventStoreConflictError);
  assert.equal(store.latestSequence("t"), -1);
  cleanup();
}

// ── appendMany conflict classification — intra-batch ───────────

{
  const { store, cleanup } = freshStore();
  // intra-batch duplicate eventId
  const e1 = makeEvent({ taskId: "x", eventId: "dup", sequence: 0 });
  const e2 = makeEvent({ taskId: "x", eventId: "dup", sequence: 1 });
  assert.throws(() => store.appendMany([e1, e2]), EventStoreConflictError);
  try { store.appendMany([e1, e2]); } catch (err) { assert.equal(err.code, "EVENT_ID_CONFLICT"); }
  assert.equal(store.latestSequence("x"), -1);

  // intra-batch duplicate (taskId, sequence)
  const s1 = makeEvent({ taskId: "x", eventId: "s1", sequence: 10 });
  const s2 = makeEvent({ taskId: "x", eventId: "s2", sequence: 10 });
  assert.throws(() => store.appendMany([s1, s2]), EventStoreConflictError);
  try { store.appendMany([s1, s2]); } catch (err) { assert.equal(err.code, "SEQUENCE_CONFLICT"); }

  // intra-batch duplicate idempotency
  const i1 = makeEvent({ taskId: "x", eventId: "i1", sequence: 20, idempotencyKey: "dup-idem" });
  const i2 = makeEvent({ taskId: "x", eventId: "i2", sequence: 21, idempotencyKey: "dup-idem" });
  assert.throws(() => store.appendMany([i1, i2]), EventStoreConflictError);
  try { store.appendMany([i1, i2]); } catch (err) { assert.equal(err.code, "IDEMPOTENCY_CONFLICT"); }

  cleanup();
}

// ── appendMany conflict against existing rows ──────────────────

{
  const { store, cleanup } = freshStore();
  store.append(makeEvent({ taskId: "ec", eventId: "pre1", sequence: 0 }));

  // against existing eventId
  const dupId = [makeEvent({ taskId: "ec", eventId: "pre1", sequence: 99 })];
  assert.throws(() => store.appendMany(dupId), EventStoreConflictError);
  try { store.appendMany(dupId); } catch (e) { assert.equal(e.code, "EVENT_ID_CONFLICT"); }

  // against existing (taskId, sequence)
  const dupSeq = [makeEvent({ taskId: "ec", eventId: "s99", sequence: 0 })];
  assert.throws(() => store.appendMany(dupSeq), EventStoreConflictError);
  try { store.appendMany(dupSeq); } catch (e) { assert.equal(e.code, "SEQUENCE_CONFLICT"); }

  // against existing idempotency
  store.append(makeEvent({ taskId: "ec", eventId: "pre2", sequence: 1, idempotencyKey: "exist" }));
  const dupIdem = [makeEvent({ taskId: "ec", eventId: "pre3", sequence: 2, idempotencyKey: "exist" })];
  assert.throws(() => store.appendMany(dupIdem), EventStoreConflictError);
  try { store.appendMany(dupIdem); } catch (e) { assert.equal(e.code, "IDEMPOTENCY_CONFLICT"); }

  // multi-violation: same eventId + same (taskId,sequence) → reports EVENT_ID_CONFLICT
  const multi = makeEvent({ taskId: "ec", eventId: "pre1", sequence: 0 });
  assert.throws(() => store.appendMany([multi]), EventStoreConflictError);
  try { store.appendMany([multi]); } catch (e) { assert.equal(e.code, "EVENT_ID_CONFLICT"); }

  cleanup();
}

// ── appendMany success ─────────────────────────────────────────

{
  const { store, cleanup } = freshStore();
  const e1 = makeEvent({ taskId: "t", eventId: "a1", sequence: 0 });
  const e2 = makeEvent({ taskId: "t", eventId: "a2", sequence: 1 });
  const results = store.appendMany([e1, e2]);
  assert.equal(results.length, 2);
  assert.equal(results[0].eventId, "a1");
  assert.equal(results[1].eventId, "a2");
  assert.equal(store.latestSequence("t"), 1);
  assert.throws(() => store.appendMany([]), TypeError);
  cleanup();
}

// ── validation failure causes no write ─────────────────────────

{
  const { store, cleanup } = freshStore();
  const good = makeEvent({ eventId: "good", sequence: 0 });
  store.append(good);
  assert.throws(() => store.append({ eventId: "bad", taskId: "t", runId: "r", sequence: 1 }), TypeError);
  assert.equal(store.latestSequence("task-1"), 0);
  cleanup();
}

{
  const { store, cleanup } = freshStore();
  const valid = makeEvent({ taskId: "t", eventId: "v1", sequence: 0 });
  const invalid = { eventId: "inv", taskId: "t", runId: "r", sequence: 1 };
  assert.throws(() => store.appendMany([valid, invalid]), TypeError);
  assert.equal(store.latestSequence("t"), -1);
  cleanup();
}

// ── persistence across close/reopen ────────────────────────────

{
  const dir = tmpDir();
  const p = join(dir, "persist.db");
  const s1 = openSqliteEventStore({ dbPath: p });
  s1.append(makeEvent({ taskId: "p", eventId: "p1", sequence: 0 }));
  s1.close();

  const s2 = openSqliteEventStore({ dbPath: p });
  assert.equal(s2.latestSequence("p"), 0);
  assert.equal(s2.getById("p1").taskId, "p");
  s2.append(makeEvent({ taskId: "p", eventId: "p2", sequence: 1 }));
  s2.close();

  const s3 = openSqliteEventStore({ dbPath: p });
  assert.equal(s3.latestSequence("p"), 1);
  assert.equal(s3.list({ taskId: "p", afterSequence: -1 }).length, 2);
  s3.close();
  rmSync(dir, { recursive: true, force: true });
}

// ── close idempotent / operations after close fail ─────────────

{
  const { store, cleanup } = freshStore();
  store.close();
  store.close();
  assert.throws(() => store.append(makeEvent()), EventStoreClosedError);
  assert.throws(() => store.appendMany([makeEvent()]), EventStoreClosedError);
  assert.throws(() => store.getById("x"), EventStoreClosedError);
  assert.throws(() => store.getByIdempotencyKey("t", "k"), EventStoreClosedError);
  assert.throws(() => store.list({ taskId: "t", afterSequence: 0 }), EventStoreClosedError);
  assert.throws(() => store.latestSequence("t"), EventStoreClosedError);
  cleanup();
}

// ── in-memory store ────────────────────────────────────────────

{
  const { store } = freshStore({ memory: true });
  assert.equal(store.latestSequence("t"), -1);
  store.append(makeEvent({ taskId: "t", eventId: "mem", sequence: 0 }));
  assert.equal(store.latestSequence("t"), 0);
  assert.equal(store.getById("mem").eventId, "mem");
  store.close();
}

// ── public methods do not mutate caller inputs ─────────────────

{
  const { store, cleanup } = freshStore();
  const input = {
    taskId: "t", runId: "r", type: "task.created", eventId: "e1", sequence: 0, timestamp: new Date().toISOString(), payload: { x: 1 }
  };
  const inputCopy = JSON.parse(JSON.stringify(input));
  store.append(input);
  assert.deepEqual(input, inputCopy);

  const arr = [
    createHarnessEvent({ taskId: "t2", runId: "r", type: "task.created", eventId: "e3", sequence: 0 }),
    createHarnessEvent({ taskId: "t2", runId: "r", type: "step.started", eventId: "e4", sequence: 1 })
  ];
  const arrCopy = JSON.parse(JSON.stringify(arr));
  store.appendMany(arr);
  assert.deepEqual(arr, arrCopy);

  const cursor = { taskId: "t", afterSequence: 0, limit: 5 };
  const cCopy = { ...cursor };
  store.list(cursor);
  assert.deepEqual(cursor, cCopy);

  cleanup();
}

// ── options validation ─────────────────────────────────────────

{
  assert.throws(() => openSqliteEventStore({}), TypeError);
  assert.throws(() => openSqliteEventStore({ dbPath: "" }), TypeError);
  assert.throws(() => openSqliteEventStore({ dbPath: "  " }), TypeError);
  assert.throws(() => openSqliteEventStore({ dbPath: "x.db", busyTimeoutMs: -1 }), TypeError);
  assert.throws(() => openSqliteEventStore({ dbPath: "x.db", busyTimeoutMs: 60001 }), TypeError);
  assert.throws(() => openSqliteEventStore({ dbPath: "x.db", busyTimeoutMs: 5.5 }), TypeError);
  assert.throws(() => openSqliteEventStore(null), TypeError);
  assert.throws(() => openSqliteEventStore("x.db"), TypeError);
}

// ── scalar input validation ────────────────────────────────────

{
  const { store, cleanup } = freshStore();
  assert.throws(() => store.getById(""), TypeError);
  assert.throws(() => store.getByIdempotencyKey("", "k"), TypeError);
  assert.throws(() => store.getByIdempotencyKey("t", ""), TypeError);
  assert.throws(() => store.latestSequence(""), TypeError);
  cleanup();
}

console.log("event-store: all assertions passed");
