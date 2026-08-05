import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openSqliteEventStore, EventStoreConflictError } from "../../event-store/src/index.mjs";
import { createHarnessEvent, validateHarnessEvent, validateAgentResult } from "../../contracts/src/index.mjs";
import { DelegationSupervisor, SupervisorConflictError, SupervisorNotFoundError, SupervisorStateError, SupervisorTimeoutError, projectTaskStatus } from "../src/index.mjs";

let seq = 0;
function deterministicIds() { return { taskId: () => `t-${seq++}`, runId: () => `r-${seq++}`, agentId: () => `a-${seq++}`, eventId: () => `ev-${seq++}` }; }
function freshStore() { return openSqliteEventStore({ dbPath: ":memory:" }); }
function mk(tid, rid, type, seq, overrides = {}) { return createHarnessEvent({ eventId: randomUUID(), taskId: tid, runId: rid, type, sequence: seq, payload: overrides.payload ?? {}, stepId: overrides.stepId, ...overrides }); }

// ── Projector lifecycle ────────────────────────────────────────
{
  const tid = "t1", rid = "r1";
  const e = [mk(tid,rid,"task.created",0), mk(tid,rid,"task.queued",1), mk(tid,rid,"task.started",2), mk(tid,rid,"task.completed",3,{payload:{summary:"ok",artifacts:[],evidence:[],filesChanged:[],assumptions:[],unresolvedIssues:[]}})];
  projectTaskStatus(e);
  // terminal before start -> rejected
  assert.throws(() => projectTaskStatus([mk(tid,rid,"task.created",0), mk(tid,rid,"task.completed",1,{payload:{summary:"x",artifacts:[],evidence:[],filesChanged:[],assumptions:[],unresolvedIssues:[]}})]), SupervisorStateError);
  // cancel before queued -> rejected
  assert.throws(() => projectTaskStatus([mk(tid,rid,"task.created",0), mk(tid,rid,"task.cancelled",1)]), SupervisorStateError);
  // duplicate same terminal -> rejected
  assert.throws(() => projectTaskStatus([...e, mk(tid,rid,"task.completed",4,{payload:{summary:"again",artifacts:[],evidence:[],filesChanged:[],assumptions:[],unresolvedIssues:[]}})]), /terminal/);
  // two different terminals -> rejected
  const dbl = [mk(tid,rid,"task.created",0),mk(tid,rid,"task.queued",1),mk(tid,rid,"task.started",2),mk(tid,rid,"task.blocked",3,{payload:{summary:"b",artifacts:[],evidence:[],filesChanged:[],assumptions:[],unresolvedIssues:[]}}),mk(tid,rid,"task.failed",4,{payload:{summary:"f",failure:{name:"E",message:"m"},artifacts:[],evidence:[],filesChanged:[],assumptions:[],unresolvedIssues:[]}})];
  assert.throws(() => projectTaskStatus(dbl), /terminal/);
  // non-task event after terminal -> rejected
  assert.throws(() => projectTaskStatus([...e, mk(tid,rid,"step.created",4,{stepId:"s"})]), /terminal/);
}

// ── Timestamp timezone ─────────────────────────────────────────
{
  const tid="tp",rid="rp";
  const evts = [
    createHarnessEvent({eventId:randomUUID(),taskId:tid,runId:rid,type:"task.created",sequence:0,payload:{request:{},runId:rid,agentId:"a"},timestamp:"2026-01-01T00:00:00Z"}),
    createHarnessEvent({eventId:randomUUID(),taskId:tid,runId:rid,type:"task.queued",sequence:1,payload:{role:"x",risk:"read"},timestamp:"2026-01-01T07:00:00+07:00"}),
    createHarnessEvent({eventId:randomUUID(),taskId:tid,runId:rid,type:"task.started",sequence:2,timestamp:"2026-01-01T00:30:00Z"}),
  ];
  const st = projectTaskStatus(evts);
  assert.equal(st.updatedAt, "2026-01-01T00:30:00Z");
}

// ── Step lifecycle ─────────────────────────────────────────────
{
  const tid="sl",rid="rl";
  const e = [mk(tid,rid,"task.created",0),mk(tid,rid,"task.queued",1),mk(tid,rid,"step.created",2,{stepId:"a"}),mk(tid,rid,"step.created",3,{stepId:"b"}),mk(tid,rid,"step.started",4,{stepId:"b"}),mk(tid,rid,"task.started",5)];
  const st = projectTaskStatus(e);
  assert.equal(st.currentStepId, "b"); // b's step.started(4) > a's step.created(2)
  assert.equal(st.progress.totalSteps, 2);
  // all terminal step types clear activity
  const allTerm = [...e, mk(tid,rid,"step.completed",6,{stepId:"a"}), mk(tid,rid,"step.blocked",7,{stepId:"b"})];
  const at = projectTaskStatus(allTerm);
  assert.equal(at.currentStepId, undefined);
}

// ── delegate + idempotent replay ───────────────────────────────
{
  const { supervisor, store } = (() => { const st = freshStore(); const s = new DelegationSupervisor({ eventStore: st, executor: { execute: async () => ({ status: "completed", summary: "ok", artifacts: [], evidence: [], filesChanged: [], assumptions: [], unresolvedIssues: [] }) }, clock: () => new Date().toISOString(), ids: deterministicIds() }); return { supervisor: s, store: st }; })();
  const r1 = supervisor.delegate({ goal: "g", role: "executor", taskId: "dt1", idempotencyKey: "id1", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 1000 });
  assert.equal(r1.status, "queued");
  // derived idempotency
  const r2 = supervisor.delegate({ goal: "g", role: "executor", idempotencyKey: "derive1", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 1000 });
  const r2r = supervisor.delegate({ goal: "g", role: "executor", idempotencyKey: "derive1", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 1000 });
  assert.equal(r2.taskId, r2r.taskId);
  assert.equal(store.list({ taskId: r2.taskId, afterSequence: -1 }).length, 3);
  // explicit conflict
  assert.throws(() => supervisor.delegate({ goal: "g", role: "executor", taskId: "dt1", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 1000 }), SupervisorConflictError);
}

// ── status null/queued ─────────────────────────────────────────
{
  const { supervisor } = (() => { const s = new DelegationSupervisor({ eventStore: freshStore(), executor: { execute: async () => ({ status: "completed", summary: "ok", artifacts: [], evidence: [], filesChanged: [], assumptions: [], unresolvedIssues: [] }) }, clock: () => new Date().toISOString(), ids: deterministicIds() }); return { supervisor: s }; })();
  assert.equal(supervisor.status("none"), null);
  const r = supervisor.delegate({ goal: "g", role: "executor", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 1000 });
  assert.equal(supervisor.status(r.taskId).status, "queued");
}

// ── completed/blocked mappings ─────────────────────────────────
async function runWith(r) {
  const st = freshStore(); const s = new DelegationSupervisor({ eventStore: st, executor: { execute: async () => r }, clock: () => new Date().toISOString(), ids: deterministicIds() });
  const resp = s.delegate({ goal: "g", role: "executor", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 30000 });
  return { status: await s.run(resp.taskId), store: st };
}
{
  const c = await runWith({ status: "completed", summary: "ok", artifacts: [], evidence: [], filesChanged: [], assumptions: [], unresolvedIssues: [] });
  assert.equal(c.status.status, "completed");
}
{
  const b = await runWith({ status: "blocked", summary: "stuck", artifacts: [], evidence: [], filesChanged: [], assumptions: [], unresolvedIssues: [] });
  assert.equal(b.status.status, "blocked");
}

// ── emit persists step/tool/control ────────────────────────────
{
  const st = freshStore(); const s = new DelegationSupervisor({ eventStore: st, executor: { execute: async ({ emit }) => { emit({ type: "step.created", stepId: "s1", payload: {} }); emit({ type: "tool.started", payload: {} }); return { status: "completed", summary: "ok", artifacts: [], evidence: [], filesChanged: [], assumptions: [], unresolvedIssues: [] }; } }, clock: () => new Date().toISOString(), ids: deterministicIds() });
  const resp = s.delegate({ goal: "g", role: "executor", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 5, timeoutMs: 30000 });
  await s.run(resp.taskId);
  const evts = st.list({ taskId: resp.taskId, afterSequence: -1 });
  const types = evts.map(e => e.type);
  assert.ok(types.includes("step.created"));
  assert.ok(types.includes("tool.started"));
}

// ── emit null/array spec rejected ──────────────────────────────
{
  const st = freshStore();
  const s = new DelegationSupervisor({ eventStore: st, executor: { execute: async ({ emit }) => { emit([]); return { status: "completed", summary: "ok", artifacts: [], evidence: [], filesChanged: [], assumptions: [], unresolvedIssues: [] }; } }, clock: () => new Date().toISOString(), ids: deterministicIds() });
  const r = s.delegate({ goal: "g", role: "executor", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 30000 });
  const status = await s.run(r.taskId);
  assert.equal(status.status, "failed");
}

// ── terminal rerun no executor ─────────────────────────────────
{
  const st = freshStore(); let calls = 0;
  const s = new DelegationSupervisor({ eventStore: st, executor: { execute: async () => { calls++; return { status: "completed", summary: "ok", artifacts: [], evidence: [], filesChanged: [], assumptions: [], unresolvedIssues: [] }; } }, clock: () => new Date().toISOString(), ids: deterministicIds() });
  const r = s.delegate({ goal: "g", role: "executor", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 30000 });
  await s.run(r.taskId); assert.equal(calls, 1);
  await s.run(r.taskId); assert.equal(calls, 1);
}

// ── missing task / non-queued state ────────────────────────────
{
  const s = new DelegationSupervisor({ eventStore: freshStore(), executor: { execute: async () => ({ status: "completed", summary: "ok", artifacts: [], evidence: [], filesChanged: [], assumptions: [], unresolvedIssues: [] }) }, clock: () => new Date().toISOString(), ids: deterministicIds() });
  try { await s.run("nonexistent"); assert.fail("expected"); } catch (e) { assert.ok(e instanceof SupervisorNotFoundError); }
  const r = s.delegate({ goal: "g", role: "executor", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 30000 });
  // non-queued: manually set to created state
  const st2 = freshStore();
  st2.appendMany([mk(r.taskId, "run-x", "task.created", 0)]);
  const s2 = new DelegationSupervisor({ eventStore: st2, executor: { execute: async () => ({ status: "completed", summary: "ok", artifacts: [], evidence: [], filesChanged: [], assumptions: [], unresolvedIssues: [] }) }, clock: () => new Date().toISOString(), ids: deterministicIds() });
  try { await s2.run(r.taskId); assert.fail("expected"); } catch (e) { assert.ok(e instanceof SupervisorStateError); }
}

// ── throw null/string executor ─────────────────────────────────
{
  for (const bad of [null, "kaboom", 42]) {
    const st = freshStore(); const s = new DelegationSupervisor({ eventStore: st, executor: { execute: async () => { throw bad; } }, clock: () => new Date().toISOString(), ids: deterministicIds() });
    const r = s.delegate({ goal: "g", role: "executor", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 30000 });
    const status = await s.run(r.taskId);
    assert.equal(status.status, "failed");
    assert.equal(status.failure.stack, undefined);
  }
}

// ── infrastructure error propagates ────────────────────────────
{
  const realStore = openSqliteEventStore({ dbPath: ":memory:" });
  const ids = deterministicIds();
  const setup = new DelegationSupervisor({ eventStore: realStore, executor: { execute: async () => ({ status: "completed", summary: "ok", artifacts: [], evidence: [], filesChanged: [], assumptions: [], unresolvedIssues: [] }) }, clock: () => new Date().toISOString(), ids });
  const resp = setup.delegate({ goal: "infra", role: "executor", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 5, timeoutMs: 30000 });
  const tid = resp.taskId;
  const badStore = {
    latestSequence: () => realStore.latestSequence(tid),
    list: (opts) => realStore.list(opts),
    getByIdempotencyKey: () => null,
    appendMany: (events) => { if (events.length > 1) throw new Error("db-down"); return []; }
  };
  const s = new DelegationSupervisor({ eventStore: badStore, executor: { execute: async ({ emit }) => { emit({ type: "step.created", stepId: "s", payload: {} }); return { status: "completed", summary: "ok", artifacts: [], evidence: [], filesChanged: [], assumptions: [], unresolvedIssues: [] }; } }, clock: () => new Date().toISOString(), ids: { taskId: () => tid, runId: () => resp.runId, agentId: () => resp.agentId, eventId: () => crypto.randomUUID() } });
  try { await s.run(tid); assert.fail("expected"); } catch (e) { assert.equal(e.message, "db-down"); }
}

// ── Promise coalescing no unhandledRejection ───────────────────
{
  const uhr = [];
  const orig = process.listeners("unhandledRejection").length;
  const st = freshStore(); const s = new DelegationSupervisor({ eventStore: st, executor: { execute: async () => ({ status: "completed", summary: "ok", artifacts: [], evidence: [], filesChanged: [], assumptions: [], unresolvedIssues: [] }) }, clock: () => new Date().toISOString(), ids: deterministicIds() });
  const p = s.run("nonexistent"); // rejects SupervisorNotFoundError
  try { await p; } catch (_) {}
  await new Promise(r => setTimeout(r, 20));
  assert.equal(process.listeners("unhandledRejection").length, orig);
}

// ── constructor validation ─────────────────────────────────────
{
  assert.throws(() => new DelegationSupervisor(), TypeError);
  assert.throws(() => new DelegationSupervisor({}), TypeError);
  assert.throws(() => new DelegationSupervisor({ eventStore: {} }), TypeError);
}

// ── timeout ignores signal ─────────────────────────────────────
{
  const st = freshStore(); const s = new DelegationSupervisor({ eventStore: st, executor: { execute: async () => new Promise(() => {}) }, clock: () => new Date().toISOString(), ids: deterministicIds() });
  const r = s.delegate({ goal: "g", role: "executor", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 1000 });
  const status = await s.run(r.taskId);
  assert.equal(status.status, "failed");
  assert.equal(status.failure.name, "SupervisorTimeoutError");
  assert.equal(status.failure.code, "TASK_TIMEOUT");
}

// ── concurrent Promise identity ────────────────────────────────
{
  const st = freshStore(); let calls = 0;
  const s = new DelegationSupervisor({ eventStore: st, executor: { execute: async () => { calls++; await new Promise(r => setTimeout(r, 30)); return { status: "completed", summary: "ok", artifacts: [], evidence: [], filesChanged: [], assumptions: [], unresolvedIssues: [] }; } }, clock: () => new Date().toISOString(), ids: deterministicIds() });
  const r = s.delegate({ goal: "g", role: "executor", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 30000 });
  const [a, b] = [s.run(r.taskId), s.run(r.taskId)];
  assert.strictEqual(a, b); await Promise.all([a, b]); assert.equal(calls, 1);
}

// ── >100-event pagination: status sees terminal beyond page ────

{
  const store = openSqliteEventStore({ dbPath: ":memory:" });
  const tid = "t-big"; const rid = "r-big"; const agentId = "a-big";
  // Create delegate events (seq 0,1,2) + task.started (3)
  const base = [
    createHarnessEvent({ eventId: "e0", taskId: tid, runId: rid, type: "task.created", sequence: 0, payload: { request: {}, runId: rid, agentId } }),
    createHarnessEvent({ eventId: "e1", taskId: tid, runId: rid, type: "task.queued", sequence: 1, payload: { role: "executor", risk: "read" } }),
    createHarnessEvent({ eventId: "e2", taskId: tid, runId: rid, type: "agent.spawned", sequence: 2, payload: { role: "executor" }, agentId }),
    createHarnessEvent({ eventId: "e3", taskId: tid, runId: rid, type: "task.started", sequence: 3, payload: {} }),
  ];
  store.appendMany(base);
  // Add 100 dummy events to push past the default 100-item page
  for (let i = 0; i < 100; i++) {
    const evt = createHarnessEvent({ eventId: `extra-${i}`, taskId: tid, runId: rid, type: "step.created", sequence: 4 + i, stepId: `s-${i}`, payload: {} });
    store.append(evt);
  }
  // Append terminal event at sequence 104 (beyond first 100)
  store.appendMany([
    createHarnessEvent({ eventId: "agc", taskId: tid, runId: rid, type: "agent.completed", sequence: 104, payload: { result: { status: "completed", summary: "done", artifacts: [], evidence: [], filesChanged: [], assumptions: [], unresolvedIssues: [] } }, agentId }),
    createHarnessEvent({ eventId: "term", taskId: tid, runId: rid, type: "task.completed", sequence: 105, payload: { summary: "big-done", artifacts: [], evidence: [], filesChanged: [], assumptions: [], unresolvedIssues: [] } }),
  ]);
  // Total: 106 events (base 4 + 100 dummy + 2 terminal)

  const s = new DelegationSupervisor({ eventStore: store, executor: { execute: async () => ({ status: "completed", summary: "ok", artifacts: [], evidence: [], filesChanged: [], assumptions: [], unresolvedIssues: [] }) }, clock: () => new Date().toISOString(), ids: deterministicIds() });
  const status = s.status(tid);
  assert.equal(status.status, "completed");
  assert.equal(status.summary, "big-done");
}

// ── >100-event pagination: rerun terminal task no executor ─────

{
  const store = openSqliteEventStore({ dbPath: ":memory:" });
  const tid = "t-big2"; const rid = "r-big2"; const agentId = "a-big2";
  const base = [
    createHarnessEvent({ eventId: "e0", taskId: tid, runId: rid, type: "task.created", sequence: 0, payload: { request: {}, runId: rid, agentId } }),
    createHarnessEvent({ eventId: "e1", taskId: tid, runId: rid, type: "task.queued", sequence: 1, payload: { role: "executor", risk: "read" } }),
    createHarnessEvent({ eventId: "e2", taskId: tid, runId: rid, type: "agent.spawned", sequence: 2, payload: { role: "executor" }, agentId }),
    createHarnessEvent({ eventId: "e3", taskId: tid, runId: rid, type: "task.started", sequence: 3, payload: {} }),
  ];
  store.appendMany(base);
  for (let i = 0; i < 100; i++) {
    store.append(createHarnessEvent({ eventId: `x-${i}`, taskId: tid, runId: rid, type: "step.created", sequence: 4 + i, stepId: `s-${i}`, payload: {} }));
  }
  store.appendMany([
    createHarnessEvent({ eventId: "ac", taskId: tid, runId: rid, type: "agent.completed", sequence: 104, payload: { result: { status: "completed", summary: "done", artifacts: [], evidence: [], filesChanged: [], assumptions: [], unresolvedIssues: [] } }, agentId }),
    createHarnessEvent({ eventId: "tc", taskId: tid, runId: rid, type: "task.completed", sequence: 105, payload: { summary: "big-done2", artifacts: [], evidence: [], filesChanged: [], assumptions: [], unresolvedIssues: [] } }),
  ]);

  let calls = 0;
  const s = new DelegationSupervisor({ eventStore: store, executor: { execute: async () => { calls++; return { status: "completed", summary: "ok", artifacts: [], evidence: [], filesChanged: [], assumptions: [], unresolvedIssues: [] }; } }, clock: () => new Date().toISOString(), ids: deterministicIds() });
  const status = await s.run(tid);
  assert.equal(status.status, "completed");
  assert.equal(status.summary, "big-done2");
  assert.equal(calls, 0); // executor never called
}

console.log("supervisor: all assertions passed");
