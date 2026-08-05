import assert from "node:assert/strict";
import { createOmoEventAdapter, SOURCE_RECORD_TYPES } from "../src/index.mjs";

const adapter = createOmoEventAdapter();

// ── agent family ────────────────────────────────────────────────

{
  const spec = adapter.map({ type: "agent:started", agentId: "agent-1" });
  assert.equal(spec.type, "agent.started");
  assert.equal(spec.agentId, "agent-1");
  assert.deepEqual(spec.metadata, { source: "omo", sourceType: "agent:started" });
}

{
  const spec = adapter.map({ type: "agent:completed", agentId: "a2", message: "done", correlationId: "c1" });
  assert.equal(spec.type, "agent.completed");
  assert.equal(spec.payload.message, "done");
  assert.equal(spec.correlationId, "c1");
}

{
  const spec = adapter.map({ type: "agent:failed", agentId: "a3", error: { name: "E", message: "boom", code: "ERR" } });
  assert.equal(spec.type, "agent.failed");
  assert.deepEqual(spec.payload.error, { name: "E", message: "boom", code: "ERR" });
}

{
  const spec = adapter.map({ type: "agent:cancelled", agentId: "a4" });
  assert.equal(spec.type, "agent.cancelled");
}

// ── tool-call family (one-to-one semantic) ──────────────────────

{
  const spec = adapter.map({ type: "tool:requested", toolId: "read_file", providerId: "local" });
  assert.equal(spec.type, "tool-call.requested");
  assert.equal(spec.payload.toolId, "read_file");
  assert.equal(spec.payload.providerId, "local");
  assert.equal(spec.providerId, undefined);
}

{
  const spec = adapter.map({ type: "tool:started", toolId: "write" });
  assert.equal(spec.type, "tool-call.started");
}

{
  const spec = adapter.map({ type: "tool:succeeded", toolId: "exec", message: "ok" });
  assert.equal(spec.type, "tool-call.succeeded");
  assert.equal(spec.payload.message, "ok");
}

{
  const spec = adapter.map({ type: "tool:failed", toolId: "exec", error: { name: "Timeout", message: "took too long" } });
  assert.equal(spec.type, "tool-call.failed");
  assert.equal(spec.payload.error.name, "Timeout");
}

// ── step family ─────────────────────────────────────────────────

{
  const spec = adapter.map({ type: "step:started", stepId: "step-1" });
  assert.equal(spec.type, "step.started");
}

{
  const spec = adapter.map({ type: "step:waiting", stepId: "step-w" });
  assert.equal(spec.type, "step.waiting");
}

{
  const spec = adapter.map({ type: "step:completed", stepId: "step-2", message: "done" });
  assert.equal(spec.type, "step.completed");
}

{
  const spec = adapter.map({ type: "step:failed", stepId: "step-3", error: { name: "Assert", message: "failed" } });
  assert.equal(spec.type, "step.failed");
}

// ── checkpoint ──────────────────────────────────────────────────

{
  const spec = adapter.map({ type: "checkpoint:created" });
  assert.equal(spec.type, "checkpoint.created");
}

{
  const spec = adapter.map({ type: "checkpoint:restored" });
  assert.equal(spec.type, "checkpoint.restored");
}

// ── approval ────────────────────────────────────────────────────

{
  const spec = adapter.map({ type: "approval:requested", message: "please approve" });
  assert.equal(spec.type, "approval.requested");
}

{
  const spec = adapter.map({ type: "approval:granted" });
  assert.equal(spec.type, "approval.granted");
}

{
  const spec = adapter.map({ type: "approval:denied" });
  assert.equal(spec.type, "approval.denied");
}

// ── metadata merge ──────────────────────────────────────────────

{
  const spec = adapter.map({ type: "agent:started", agentId: "a", metadata: { custom: 42 } });
  assert.deepEqual(spec.metadata, { custom: 42, source: "omo", sourceType: "agent:started" });
}

// ── error: no stack/code when absent ───────────────────────────

{
  const spec = adapter.map({ type: "tool:failed", toolId: "t", error: { name: "E", message: "m", stack: "at ..." } });
  assert.equal(spec.payload.error.stack, undefined);
  assert.equal(spec.payload.error.code, undefined);
}

assert.throws(() => adapter.map({ type: "tool:failed", toolId: "t" }), /failed.*error/);
assert.throws(() => adapter.map({ type: "tool:failed", toolId: "t", error: { name: "", message: "m" } }), /error.name/);

// ── validation ──────────────────────────────────────────────────

assert.throws(() => adapter.map(null), /plain object/);
assert.throws(() => adapter.map([]), /plain object/);
assert.throws(() => adapter.map({}), /type/);
assert.throws(() => adapter.map({ type: "unknown:type" }), /unsupported/);
assert.throws(() => adapter.map({ type: "agent:started" }), /agentId/);
assert.throws(() => adapter.map({ type: "tool:started" }), /toolId/);
assert.throws(() => adapter.map({ type: "step:started" }), /stepId/);

// ── override rejection ─────────────────────────────────────────

for (const f of ["eventId","taskId","runId","sequence","timestamp"]) {
  assert.throws(() => adapter.map({ type: "agent:started", agentId: "a", [f]: "override" }), /override/);
}

// ── non-mutation / clone ────────────────────────────────────────

{
  const record = { type: "agent:started", agentId: "a", payload: { extra: "keep" }, metadata: { m: 1 } };
  const copy = JSON.parse(JSON.stringify(record));
  const spec = adapter.map(record);
  assert.deepEqual(record, copy);
  assert.notStrictEqual(spec.payload, record.payload);
  assert.notStrictEqual(spec.metadata, record.metadata);
}

// ── taxonomy completeness ───────────────────────────────────────

const covered = new Set();
for (const t of SOURCE_RECORD_TYPES) {
  covered.add(t);
  adapter.map({ type: t, agentId: t.startsWith("agent:") ? "a" : undefined, toolId: t.startsWith("tool:") ? "t" : undefined, stepId: t.startsWith("step:") ? "s" : undefined, error: t.endsWith(":failed") ? { name: "E", message: "m" } : undefined });
}
assert.equal(covered.size, SOURCE_RECORD_TYPES.length);

console.log("omo-adapter: all assertions passed");
