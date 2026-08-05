import { randomUUID } from "node:crypto";
import { assertIsoString, assertObject, assertString, nowIso } from "./common.mjs";

// ── Canonical lifecycle taxonomy ────────────────────────────────

export const EVENT_TYPES = Object.freeze([
  // task
  "task.created", "task.queued", "task.started", "task.updated",
  "task.waiting", "task.verifying", "task.completed", "task.blocked",
  "task.failed", "task.cancelled",
  // step
  "step.created", "step.started", "step.completed", "step.blocked",
  "step.failed", "step.skipped", "step.ready", "step.waiting",
  "step.retry-scheduled", "step.cancelled",
  // tool call (legacy)
  "tool.started", "tool.completed", "tool.failed",
  // tool-call (new)
  "tool-call.requested", "tool-call.started", "tool-call.succeeded", "tool-call.failed",
  // control flow
  "retry.scheduled", "replan.requested", "checkpoint.created", "checkpoint.restored",
  "approval.requested", "approval.granted", "approval.denied",
  // agent
  "agent.spawned", "agent.completed", "agent.failed", "agent.cancelled",
  "agent.delegated", "agent.started"
]);

export const TERMINAL_EVENT_TYPES = Object.freeze([
  "task.completed", "task.blocked", "task.failed", "task.cancelled",
  "step.completed", "step.blocked", "step.failed", "step.skipped", "step.cancelled",
  "tool.completed", "tool.failed",
  "tool-call.succeeded", "tool-call.failed",
  "agent.completed", "agent.failed", "agent.cancelled"
]);
const TERMINAL_SET = new Set(TERMINAL_EVENT_TYPES);

// ── Family mapping ──────────────────────────────────────────────

const FAMILY_MAP = Object.create(null);
for (const t of EVENT_TYPES) {
  const dot = t.indexOf(".");
  FAMILY_MAP[t] = t.slice(0, dot);
}
// The three control-flow events don't share a single prefix — override.
FAMILY_MAP["retry.scheduled"] = "control";
FAMILY_MAP["replan.requested"] = "control";
FAMILY_MAP["checkpoint.created"] = "control";
FAMILY_MAP["checkpoint.restored"] = "checkpoint";
FAMILY_MAP["approval.requested"] = "control";
FAMILY_MAP["approval.granted"] = "control";
FAMILY_MAP["approval.denied"] = "control";
FAMILY_MAP["tool-call.requested"] = "tool-call";
FAMILY_MAP["tool-call.started"] = "tool-call";
FAMILY_MAP["tool-call.succeeded"] = "tool-call";
FAMILY_MAP["tool-call.failed"] = "tool-call";

export function eventFamily(type) {
  const family = FAMILY_MAP[type];
  if (family === undefined) throw new TypeError(`Unknown event type: ${type}`);
  return family;
}

// ── Helpers ─────────────────────────────────────────────────────

function assertOptionalString(value, name) {
  if (value !== undefined && value !== null) assertString(value, name);
}

export function isTerminalEventType(type) {
  return TERMINAL_SET.has(type);
}

// ── Validator ───────────────────────────────────────────────────

export function validateHarnessEvent(input) {
  const value = assertObject(input, "event");
  assertString(value.eventId, "event.eventId");
  assertString(value.taskId, "event.taskId");
  assertString(value.runId, "event.runId");
  assertString(value.type, "event.type");
  if (!EVENT_TYPES.includes(value.type)) throw new TypeError(`Unsupported event type: ${value.type}`);
  if (!Number.isInteger(value.sequence) || value.sequence < 0) throw new TypeError("event.sequence must be a non-negative integer");
  assertIsoString(value.timestamp, "event.timestamp");
  assertObject(value.payload, "event.payload");
  if (value.metadata !== undefined) assertObject(value.metadata, "event.metadata");
  assertOptionalString(value.stepId, "event.stepId");
  assertOptionalString(value.agentId, "event.agentId");
  assertOptionalString(value.traceId, "event.traceId");
  assertOptionalString(value.causationId, "event.causationId");
  assertOptionalString(value.correlationId, "event.correlationId");
  assertOptionalString(value.idempotencyKey, "event.idempotencyKey");
  return value;
}

// ── Factory ─────────────────────────────────────────────────────

export function createHarnessEvent(input) {
  assertObject(input, "event");
  assertString(input.type, "event.type");
  const event = {
    eventId: input.eventId ?? randomUUID(),
    taskId: input.taskId,
    runId: input.runId,
    type: input.type,
    sequence: input.sequence ?? 0,
    timestamp: input.timestamp ?? nowIso(),
    payload: input.payload ?? {},
    metadata: input.metadata ?? {}
  };
  if (input.stepId !== undefined) event.stepId = input.stepId;
  if (input.agentId !== undefined) event.agentId = input.agentId;
  if (input.traceId !== undefined) event.traceId = input.traceId;
  if (input.causationId !== undefined) event.causationId = input.causationId;
  if (input.correlationId !== undefined) event.correlationId = input.correlationId;
  if (input.idempotencyKey !== undefined) event.idempotencyKey = input.idempotencyKey;
  return validateHarnessEvent(event);
}
