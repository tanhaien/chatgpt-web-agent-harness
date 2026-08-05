import { assertIsoString, assertObject, assertString } from "./common.mjs";

// ── CallContext ────────────────────────────────────────────────
export function validateCallContext(input) {
  const value = assertObject(input, "callContext");
  assertString(value.traceId, "callContext.traceId");
  assertString(value.providerId, "callContext.providerId");
  assertString(value.toolId, "callContext.toolId");
  if (!Number.isInteger(value.attempt) || value.attempt < 1) throw new TypeError("callContext.attempt must be a positive integer");
  if (value.deadlineAt !== undefined) assertIsoString(value.deadlineAt, "callContext.deadlineAt");
  if (value.idempotencyKey !== undefined) assertString(value.idempotencyKey, "callContext.idempotencyKey");
  if (value.taskId !== undefined) assertString(value.taskId, "callContext.taskId");
  if (value.runId !== undefined) assertString(value.runId, "callContext.runId");
  if (value.stepId !== undefined) assertString(value.stepId, "callContext.stepId");
  if (value.agentId !== undefined) assertString(value.agentId, "callContext.agentId");
  assertObject(value.metadata, "callContext.metadata");
  return value;
}

// ── ToolCallResult ─────────────────────────────────────────────
export function validateToolCallResult(input) {
  const value = assertObject(input, "toolCallResult");
  if (typeof value.ok !== "boolean") throw new TypeError("toolCallResult.ok must be a boolean");
  assertString(value.providerId, "toolCallResult.providerId");
  assertString(value.toolId, "toolCallResult.toolId");
  assertIsoString(value.startedAt, "toolCallResult.startedAt");
  assertIsoString(value.finishedAt, "toolCallResult.finishedAt");
  if (!Number.isInteger(value.durationMs) || value.durationMs < 0) throw new TypeError("toolCallResult.durationMs must be a non-negative integer");
  if (!Array.isArray(value.artifacts)) throw new TypeError("toolCallResult.artifacts must be an array");
  if (typeof value.retryable !== "boolean") throw new TypeError("toolCallResult.retryable must be a boolean");
  if (value.idempotencyKey !== undefined) assertString(value.idempotencyKey, "toolCallResult.idempotencyKey");
  if (value.ok) {
    if (value.error !== undefined) throw new TypeError("toolCallResult.error must not be present when ok=true");
  } else {
    if (value.error === undefined) throw new TypeError("toolCallResult.error is required when ok=false");
  }
  return value;
}

// ── ExecutionResult ────────────────────────────────────────────
const EXECUTION_STATUSES = Object.freeze(["completed", "failed", "blocked", "cancelled"]);

export function validateExecutionResult(input) {
  const value = assertObject(input, "executionResult");
  if (!EXECUTION_STATUSES.includes(value.status)) throw new TypeError(`executionResult.status must be one of: ${EXECUTION_STATUSES.join(", ")}`);
  assertString(value.summary, "executionResult.summary");
  if (!Array.isArray(value.toolCalls)) throw new TypeError("executionResult.toolCalls must be an array");
  if (!Array.isArray(value.artifacts)) throw new TypeError("executionResult.artifacts must be an array");
  if (!Array.isArray(value.evidence)) throw new TypeError("executionResult.evidence must be an array");
  if (value.failure !== undefined) assertObject(value.failure, "executionResult.failure");
  return value;
}

// ── TaskLease ──────────────────────────────────────────────────
export function validateTaskLease(input) {
  const value = assertObject(input, "taskLease");
  assertString(value.taskId, "taskLease.taskId");
  assertString(value.stepId, "taskLease.stepId");
  assertString(value.workerId, "taskLease.workerId");
  assertIsoString(value.acquiredAt, "taskLease.acquiredAt");
  assertIsoString(value.expiresAt, "taskLease.expiresAt");
  if (!Number.isInteger(value.fencingToken) || value.fencingToken < 1) throw new TypeError("taskLease.fencingToken must be a positive integer");
  if (new Date(value.expiresAt).getTime() <= new Date(value.acquiredAt).getTime()) throw new TypeError("taskLease.expiresAt must be later than acquiredAt");
  return value;
}

// ── EventCursor ────────────────────────────────────────────────
export function validateEventCursor(input) {
  const value = assertObject(input, "eventCursor");
  assertString(value.taskId, "eventCursor.taskId");
  if (!Number.isInteger(value.afterSequence) || value.afterSequence < -1) throw new TypeError("eventCursor.afterSequence must be an integer >= -1");
  if (value.limit !== undefined) {
    if (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 1000) {
      throw new TypeError("eventCursor.limit must be an integer between 1 and 1000");
    }
  }
  return value;
}
