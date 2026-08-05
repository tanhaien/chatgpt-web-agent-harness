import assert from "node:assert/strict";
import { openSqliteEventStore } from "../../event-store/src/index.mjs";
import { DelegationSupervisor } from "../../supervisor/src/index.mjs";
import { TaskReadService } from "../../task-stream/src/index.mjs";
import { LocalClosedLoopController, ControllerEvaluationError } from "../src/index.mjs";

let counter = 0;
function deterministicIds() { return { taskId: () => `t-${counter++}`, runId: () => `r-${counter++}`, agentId: () => `a-${counter++}`, eventId: () => `ev-${counter++}` }; }

function fresh() {
  const store = openSqliteEventStore({ dbPath: ":memory:" });
  const sv = new DelegationSupervisor({ eventStore: store, executor: { execute: async () => ({ status: "completed", summary: "ok", artifacts: [], evidence: [], filesChanged: [], assumptions: [], unresolvedIssues: [] }) }, clock: () => new Date().toISOString(), ids: deterministicIds() });
  return { store, sv, trs: new TaskReadService({ eventStore: store, supervisor: sv, pollIntervalMs: 5 }) };
}

// ── accept: root===final, no orphan ────────────────────────────
{
  const { sv, trs } = fresh();
  const ctrl = new LocalClosedLoopController({ supervisor: sv, taskReadService: trs, evaluator: { evaluate: async () => ({ decision: "accept", reason: "good" }) } });
  const result = await ctrl.execute({ goal: "g", role: "executor", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 30000 });
  assert.equal(result.rootTaskId, result.finalTaskId);
  assert.equal(result.rootTaskId, result.cycles[0].taskId);
}

// ── retry: child parentTaskId, nextGoal, idempotencyKey ────────
{
  const { sv, trs, store } = fresh();
  let ctx2;
  const ctrl = new LocalClosedLoopController({ supervisor: sv, taskReadService: trs, maxCycles: 3,
    evaluator: { evaluate: async (ctx) => { ctx2 = ctx; return ctx.cycle === 1 ? { decision: "retry", reason: "again", nextGoal: "improved" } : { decision: "accept", reason: "done" }; } } });
  const result = await ctrl.execute({ goal: "g", role: "executor", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 5, timeoutMs: 120000, idempotencyKey: "user-key" });
  assert.equal(result.cycles.length, 2);
  const c2Evts = store.list({ taskId: result.cycles[1].taskId, afterSequence: -1 });
  const created = c2Evts.find(e => e.type === "task.created");
  assert.equal(created.payload.request.parentTaskId, result.rootTaskId);
  assert.equal(created.payload.request.goal, "improved");
  assert.equal(created.idempotencyKey, ctx2.currentRequest.idempotencyKey);
}

// ── two independent executions, disjoint child taskIds ─────────
{
  const { sv, trs } = fresh();
  const ctrl = new LocalClosedLoopController({ supervisor: sv, taskReadService: trs, maxCycles: 2, evaluator: { evaluate: async () => ({ decision: "retry", reason: "again" }) } });
  const [a, b] = await Promise.all([ctrl.execute({ goal: "ga", role: "executor", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 30000 }), ctrl.execute({ goal: "gb", role: "executor", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 30000 })]);
  assert.equal(new Set([...a.cycles.map(c => c.taskId), ...b.cycles.map(c => c.taskId)]).size, 4);
}

// ── custom retry key = original key => rejected ────────────────
{
  const { sv, trs } = fresh();
  const ctrl = new LocalClosedLoopController({ supervisor: sv, taskReadService: trs, maxCycles: 3,
    makeIdempotencyKey: () => "original-key",
    evaluator: { evaluate: async () => ({ decision: "retry", reason: "again" }) } });
  try { await ctrl.execute({ goal: "g", role: "executor", idempotencyKey: "original-key", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 30000 }); assert.fail("expected"); } catch (e) { assert.ok(e instanceof ControllerEvaluationError); }
}

// ── evaluator throws null/string/number -> ControllerEvaluationError ─
{
  const { sv, trs } = fresh();
  for (const bad of [null, "boom", 42]) {
    const ctrl = new LocalClosedLoopController({ supervisor: sv, taskReadService: trs, evaluator: { evaluate: async () => { throw bad; } } });
    try { await ctrl.execute({ goal: "g", role: "executor", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 30000 }); assert.fail(`expected for ${bad}`); } catch (e) { assert.ok(e instanceof ControllerEvaluationError); assert.ok(e.message.length > 0); }
  }
}

// ── durable snapshot: missing-taskId/mismatch rejected ─────────
{
  const { sv } = fresh();
  const noTaskFake = { wait: async () => ({ status: "running", terminal: true, timedOut: false, events: [], nextSequence: -1 }) };
  const ctrl = new LocalClosedLoopController({ supervisor: sv, taskReadService: noTaskFake, evaluator: { evaluate: async () => ({ decision: "accept", reason: "no" }) } });
  try { await ctrl.execute({ goal: "g", role: "executor", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 30000 }); assert.fail("expected"); } catch (e) { assert.ok(e instanceof ControllerEvaluationError); }
}

{
  const { sv } = fresh();
  const mismatchFake = { wait: async () => ({ taskId: "wrong", status: "completed", terminal: true, timedOut: false, events: [], nextSequence: -1 }) };
  const ctrl2 = new LocalClosedLoopController({ supervisor: sv, taskReadService: mismatchFake, evaluator: { evaluate: async () => ({ decision: "accept", reason: "no" }) } });
  try { await ctrl2.execute({ goal: "g", role: "executor", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 30000 }); assert.fail("expected"); } catch (e) { assert.ok(e instanceof ControllerEvaluationError); }
}

// ── maxCycles exhausted ────────────────────────────────────────
{
  const { sv, trs } = fresh();
  const ctrl = new LocalClosedLoopController({ supervisor: sv, taskReadService: trs, maxCycles: 2, evaluator: { evaluate: async () => ({ decision: "retry", reason: "keep" }) } });
  const result = await ctrl.execute({ goal: "g", role: "executor", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 30000 });
  assert.equal(result.status, "exhausted");
}

// ── clock: decreasing rejected ─────────────────────────────────
{
  const store = openSqliteEventStore({ dbPath: ":memory:" });
  let t = 0;
  const sv = new DelegationSupervisor({ eventStore: store, executor: { execute: async () => ({ status: "completed", summary: "ok", artifacts: [], evidence: [], filesChanged: [], assumptions: [], unresolvedIssues: [] }) }, clock: () => new Date().toISOString(), ids: { taskId: () => crypto.randomUUID(), runId: () => "r", agentId: () => "a", eventId: () => crypto.randomUUID() } });
  const trs = new TaskReadService({ eventStore: store, supervisor: sv, pollIntervalMs: 5 });
  const ctrl = new LocalClosedLoopController({ supervisor: sv, taskReadService: trs, evaluator: { evaluate: async () => ({ decision: "accept", reason: "x" }) }, clock: () => { t++; return t === 1 ? "2026-01-01T00:00:05Z" : "2026-01-01T00:00:01Z"; } });
  try { await ctrl.execute({ goal: "g", role: "executor", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 30000 }); assert.fail("expected"); } catch (e) { assert.ok(e instanceof ControllerEvaluationError); }
}

// ── timezone-offset equal epoch accepted ───────────────────────
{
  const store = openSqliteEventStore({ dbPath: ":memory:" });
  const sv = new DelegationSupervisor({ eventStore: store, executor: { execute: async () => ({ status: "completed", summary: "ok", artifacts: [], evidence: [], filesChanged: [], assumptions: [], unresolvedIssues: [] }) }, clock: () => new Date().toISOString(), ids: { taskId: () => "t", runId: () => "r", agentId: () => "a", eventId: () => crypto.randomUUID() } });
  const trs = new TaskReadService({ eventStore: store, supervisor: sv, pollIntervalMs: 5 });
  const ctrl = new LocalClosedLoopController({ supervisor: sv, taskReadService: trs, evaluator: { evaluate: async () => ({ decision: "accept", reason: "x" }) }, clock: () => "2026-01-01T07:00:00+07:00" });
  await ctrl.execute({ goal: "g", role: "executor", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 30000 });
  // equal epoch (00:00Z = 07:00+07:00) => >= passes
}

// ── caller request non-mutation ────────────────────────────────
{
  const { sv, trs } = fresh();
  const ctrl = new LocalClosedLoopController({ supervisor: sv, taskReadService: trs, evaluator: { evaluate: async () => ({ decision: "accept", reason: "good" }) } });
  const req = { goal: "g", role: "executor", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 30000, extra: "keep" };
  const cp = JSON.parse(JSON.stringify(req));
  await ctrl.execute(req);
  assert.deepEqual(req, cp);
}

// ── abort before start ─────────────────────────────────────────
{
  const { sv, trs } = fresh();
  const ctrl = new LocalClosedLoopController({ supervisor: sv, taskReadService: trs, evaluator: { evaluate: async () => ({ decision: "accept", reason: "x" }) } });
  const ac = new AbortController(); ac.abort("custom-reason");
  try { await ctrl.execute({ goal: "g", role: "executor", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 30000 }, { signal: ac.signal }); assert.fail("expected"); } catch (e) { assert.equal(e.name, "AbortError"); }
}

console.log("controller: all assertions passed");
