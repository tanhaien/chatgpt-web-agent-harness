import assert from "node:assert/strict";
import { openSqliteEventStore } from "../../event-store/src/index.mjs";
import { DelegationSupervisor } from "../../supervisor/src/index.mjs";
import { createHarnessEvent, validateTaskEventsResult, validateTaskWaitResult } from "../../contracts/src/index.mjs";
import { TaskReadService, encodeTaskEventSse, encodeSseHeartbeat, streamTaskEvents } from "../src/index.mjs";

function fresh() {
  const store = openSqliteEventStore({ dbPath: ":memory:" });
  const ids = { taskId: () => `t`, runId: () => `r`, agentId: () => `a`, eventId: () => crypto.randomUUID() };
  const sv = new DelegationSupervisor({ eventStore: store, executor: { execute: async () => ({ status: "completed", summary: "ok", artifacts: [], evidence: [], filesChanged: [], assumptions: [], unresolvedIssues: [] }) }, clock: () => new Date().toISOString(), ids });
  const service = new TaskReadService({ eventStore: store, supervisor: sv, pollIntervalMs: 10 });
  return { store, sv, service };
}

// ── hasMore: gapped sequence exact-limit no more => false ──────

{
  const { service, store } = fresh();
  store.append(createHarnessEvent({ eventId:"e0",taskId:"g1",runId:"r",type:"step.created",sequence:0,payload:{},stepId:"s0" }));
  store.append(createHarnessEvent({ eventId:"e7",taskId:"g1",runId:"r",type:"step.started",sequence:7,payload:{},stepId:"s7" }));
  const result = service.events({ taskId: "g1", limit: 2 });
  assert.equal(result.events.length, 2);
  assert.equal(result.hasMore, false);
}

// ── hasMore: gapped sequence exact-limit one later => true ─────

{
  const { service, store } = fresh();
  store.append(createHarnessEvent({ eventId:"e0",taskId:"g2",runId:"r",type:"step.created",sequence:0,payload:{},stepId:"s0" }));
  store.append(createHarnessEvent({ eventId:"e7",taskId:"g2",runId:"r",type:"step.started",sequence:7,payload:{},stepId:"s7" }));
  store.append(createHarnessEvent({ eventId:"e8",taskId:"g2",runId:"r",type:"step.completed",sequence:8,payload:{},stepId:"s7" }));
  const result = service.events({ taskId: "g2", limit: 2 });
  assert.equal(result.events.length, 2);
  assert.equal(result.hasMore, true);
}

// ── exact-limit no-more => hasMore=false ───────────────────────

{
  const { service, store } = fresh();
  for (let i = 0; i < 10; i++) {
    store.append(createHarnessEvent({ eventId:`e${i}`,taskId:"t1",runId:"r",type:"step.created",sequence:i,payload:{},stepId:`s${i}` }));
  }
  const result = service.events({ taskId: "t1", limit: 10 });
  assert.equal(result.events.length, 10);
  assert.equal(result.hasMore, false);
}

// ── exact-limit one more => hasMore=true ───────────────────────

{
  const { service, store } = fresh();
  for (let i = 0; i < 11; i++) {
    store.append(createHarnessEvent({ eventId:`x${i}`,taskId:"t2",runId:"r",type:"step.created",sequence:i,payload:{},stepId:`s${i}` }));
  }
  const result = service.events({ taskId: "t2", limit: 10 });
  assert.equal(result.events.length, 10);
  assert.equal(result.hasMore, true);
}

// ── limit=1000 exact/1001 ──────────────────────────────────────

{
  const { service, store } = fresh();
  for (let i = 0; i < 1000; i++) {
    store.append(createHarnessEvent({ eventId:`l${i}`,taskId:"big",runId:"r",type:"step.created",sequence:i,payload:{},stepId:`s${i}` }));
  }
  assert.equal(service.events({ taskId:"big",limit:1000 }).hasMore, false);
  store.append(createHarnessEvent({ eventId:"extra",taskId:"big",runId:"r",type:"step.started",sequence:1000,payload:{},stepId:"s1000" }));
  assert.equal(service.events({ taskId:"big",limit:1000 }).hasMore, true);
}

// ── >1000 events wait collected ────────────────────────────────

{
  const { service, store } = fresh();
  const tid = "big3";
  store.append(createHarnessEvent({ eventId:"btc",taskId:tid,runId:"r",type:"task.created",sequence:0,payload:{request:{},runId:"r",agentId:"a"}}));
  store.append(createHarnessEvent({ eventId:"btq",taskId:tid,runId:"r",type:"task.queued",sequence:1,payload:{role:"x",risk:"read"}}));
  for (let i = 0; i < 1098; i++) {
    store.append(createHarnessEvent({ eventId:`w${i}`,taskId:tid,runId:"r",type:"step.created",sequence:2+i,payload:{},stepId:`s${i}` }));
  }
  store.appendMany([
    createHarnessEvent({ eventId:"ts2",taskId:tid,runId:"r",type:"task.started",sequence:1100,payload:{}}),
    createHarnessEvent({ eventId:"ac",taskId:tid,runId:"r",type:"agent.completed",sequence:1101,payload:{result:{status:"completed",summary:"ok",artifacts:[],evidence:[],filesChanged:[],assumptions:[],unresolvedIssues:[]}},agentId:"a"}),
    createHarnessEvent({ eventId:"tcc",taskId:tid,runId:"r",type:"task.completed",sequence:1102,payload:{summary:"ok",artifacts:[],evidence:[],filesChanged:[],assumptions:[],unresolvedIssues:[]}}),
  ]);
  const r = await service.wait({ taskId: tid, timeoutMs: 100 });
  assert.equal(r.events.length, 1103);
  assert.equal(r.terminal, true);
}

// ── delayed terminal returns promptly ──────────────────────────

{
  const { service, store, sv } = fresh();
  const r = sv.delegate({ goal: "g", role: "executor", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 5000 });
  setTimeout(() => { sv.run(r.taskId); }, 50);
  const start = Date.now();
  const result = await service.wait({ taskId: r.taskId, timeoutMs: 5000 });
  assert.ok(Date.now() - start < 2000);
  assert.equal(result.terminal, true);
}

// ── timeoutMs=0 nonterminal => timedOut=true ───────────────────

{
  const { service, sv } = fresh();
  const r = sv.delegate({ goal: "g", role: "executor", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 1000 });
  const result = await service.wait({ taskId: r.taskId, timeoutMs: 0 });
  assert.equal(result.timedOut, true);
  assert.equal(result.terminal, false);
}

// ── abort custom-reason yields Error with name AbortError ──────

{
  const { service } = fresh();
  const ctrl = new AbortController();
  ctrl.abort("custom-reason");
  try {
    await service.wait({ taskId: "no", timeoutMs: 5000 }, { signal: ctrl.signal });
    assert.fail("expected abort");
  } catch (e) {
    assert.equal(e.name, "AbortError");
  }
}

// ── SSE blank-line terminator ──────────────────────────────────

{
  const ev = createHarnessEvent({ eventId:"se",taskId:"t",runId:"r",type:"task.created",sequence:1,timestamp:"2026-01-01T00:00:00Z",payload:{},metadata:{} });
  assert.ok(encodeTaskEventSse(ev).endsWith("\n\n"));
}

// ── stream abort cleanly ───────────────────────────────────────

{
  const { service } = fresh();
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 20);
  const frames = [];
  for await (const f of streamTaskEvents(service, { taskId: "none", afterSequence: -1, limit: 5 }, { signal: ctrl.signal, heartbeatMs: 0 })) {
    frames.push(f);
  }
  assert.equal(frames.length, 0);
}

// ── validator checks ───────────────────────────────────────────

{
  assert.throws(() => validateTaskEventsResult({ taskId:"t",events:[{eventId:"e0",taskId:"t",runId:"r",type:"task.created",sequence:0,timestamp:new Date().toISOString(),payload:{},metadata:{}}],nextSequence:99,hasMore:false}),/nextSequence/);
  assert.throws(() => validateTaskWaitResult({ taskId:"t",status:"completed",terminal:true,timedOut:false,events:[{eventId:"e0",taskId:"t",runId:"r",type:"task.created",sequence:0,timestamp:new Date().toISOString(),payload:{},metadata:{}}],nextSequence:5}),/nextSequence/);
}

// ── non-mutation ────────────────────────────────────────────────

{
  const inp = { taskId: "t", afterSequence: -1, limit: 5, waitMs: 0 };
  const cp = JSON.parse(JSON.stringify(inp));
  const { service } = fresh();
  service.events(inp);
  assert.deepEqual(inp, cp);
}

console.log("task-stream: all assertions passed");
