import {
  RISK_LEVELS, RUN_STATUSES,
  assertEnum, assertIsoString, assertObject, assertString, assertStringArray
} from "./common.mjs";
import { validateHarnessEvent } from "./event.mjs";

// ── Shared constants ───────────────────────────────────────────

const DELEGATE_ROLES = Object.freeze(["planner", "executor", "reviewer", "verifier", "researcher"]);
const DELEGATE_RESPONSE_STATUSES = Object.freeze(["queued", "running"]);
const TERMINAL_TASK_STATUSES = Object.freeze(["completed", "blocked", "failed", "cancelled"]);

function assertOptionalString(value, name) {
  if (value !== undefined && value !== null) assertString(value, name);
}

// ── 1. DelegateTaskRequest ─────────────────────────────────────

export function validateDelegateTaskRequest(input) {
  const value = assertObject(input, "delegateTaskRequest");
  assertString(value.goal, "delegateTaskRequest.goal");
  assertOptionalString(value.taskId, "delegateTaskRequest.taskId");
  assertOptionalString(value.parentTaskId, "delegateTaskRequest.parentTaskId");
  assertEnum(value.role, DELEGATE_ROLES, "delegateTaskRequest.role");
  assertStringArray(value.requiredCapabilities ?? [], "delegateTaskRequest.requiredCapabilities");
  const ac = assertStringArray(value.acceptanceCriteria ?? [], "delegateTaskRequest.acceptanceCriteria");
  if (ac.length === 0) throw new TypeError("delegateTaskRequest.acceptanceCriteria must be non-empty");
  assertStringArray(value.evidenceRequired ?? [], "delegateTaskRequest.evidenceRequired");
  assertEnum(value.risk, RISK_LEVELS, "delegateTaskRequest.risk");
  if (!Number.isInteger(value.maxToolCalls) || value.maxToolCalls < 1 || value.maxToolCalls > 10000) throw new TypeError("delegateTaskRequest.maxToolCalls must be an integer between 1 and 10000");
  if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 86400000) throw new TypeError("delegateTaskRequest.timeoutMs must be an integer between 1000 and 86400000");
  if (value.metadata !== undefined) assertObject(value.metadata, "delegateTaskRequest.metadata");
  assertOptionalString(value.idempotencyKey, "delegateTaskRequest.idempotencyKey");
  return value;
}

// ── 2. DelegateTaskResponse ────────────────────────────────────

export function validateDelegateTaskResponse(input) {
  const value = assertObject(input, "delegateTaskResponse");
  assertString(value.taskId, "delegateTaskResponse.taskId");
  assertString(value.runId, "delegateTaskResponse.runId");
  assertString(value.agentId, "delegateTaskResponse.agentId");
  assertEnum(value.status, DELEGATE_RESPONSE_STATUSES, "delegateTaskResponse.status");
  assertIsoString(value.createdAt, "delegateTaskResponse.createdAt");
  if (typeof value.accepted !== "boolean") throw new TypeError("delegateTaskResponse.accepted must be a boolean");
  if (value.status === "running" && !value.accepted) throw new TypeError("delegateTaskResponse.accepted must be true when status is running");
  return value;
}

// ── 3. TaskStatusRequest ───────────────────────────────────────

export function validateTaskStatusRequest(input) {
  const value = assertObject(input, "taskStatusRequest");
  assertString(value.taskId, "taskStatusRequest.taskId");
  return value;
}

// ── 4. TaskStatusResponse ──────────────────────────────────────

export function validateTaskStatusResponse(input) {
  const value = assertObject(input, "taskStatusResponse");
  assertString(value.taskId, "taskStatusResponse.taskId");
  assertString(value.runId, "taskStatusResponse.runId");
  assertEnum(value.status, RUN_STATUSES, "taskStatusResponse.status");
  assertIsoString(value.createdAt, "taskStatusResponse.createdAt");
  assertIsoString(value.updatedAt, "taskStatusResponse.updatedAt");
  if (value.startedAt !== undefined) assertIsoString(value.startedAt, "taskStatusResponse.startedAt");
  if (value.finishedAt !== undefined) assertIsoString(value.finishedAt, "taskStatusResponse.finishedAt");
  const caEpoch = new Date(value.createdAt).getTime();
  const uaEpoch = new Date(value.updatedAt).getTime();
  if (uaEpoch < caEpoch) throw new TypeError("taskStatusResponse.updatedAt must be >= createdAt");
  if (value.startedAt !== undefined && new Date(value.startedAt).getTime() < caEpoch) throw new TypeError("taskStatusResponse.startedAt must be >= createdAt");
  if (value.finishedAt !== undefined) {
    const fiEpoch = new Date(value.finishedAt).getTime();
    if (fiEpoch < caEpoch) throw new TypeError("taskStatusResponse.finishedAt must be >= createdAt");
    if (value.startedAt !== undefined && fiEpoch < new Date(value.startedAt).getTime()) throw new TypeError("taskStatusResponse.finishedAt must be >= startedAt");
  }
  assertOptionalString(value.currentStepId, "taskStatusResponse.currentStepId");
  const progress = assertObject(value.progress, "taskStatusResponse.progress");
  if (!Number.isInteger(progress.completedSteps) || progress.completedSteps < 0) throw new TypeError("taskStatusResponse.progress.completedSteps must be a non-negative integer");
  if (!Number.isInteger(progress.totalSteps) || progress.totalSteps < 0) throw new TypeError("taskStatusResponse.progress.totalSteps must be a non-negative integer");
  if (progress.completedSteps > progress.totalSteps) throw new TypeError("taskStatusResponse.progress.completedSteps must not exceed totalSteps");
  assertOptionalString(value.summary, "taskStatusResponse.summary");
  if (value.failure !== undefined) assertObject(value.failure, "taskStatusResponse.failure");
  return value;
}

// ── 5. TaskEventsRequest ───────────────────────────────────────

export function validateTaskEventsRequest(input) {
  const value = assertObject(input, "taskEventsRequest");
  assertString(value.taskId, "taskEventsRequest.taskId");
  if (!Number.isInteger(value.afterSequence) || value.afterSequence < -1) throw new TypeError("taskEventsRequest.afterSequence must be an integer >= -1");
  if (value.limit !== undefined) {
    if (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 1000) throw new TypeError("taskEventsRequest.limit must be an integer between 1 and 1000");
  }
  if (value.waitMs !== undefined) {
    if (!Number.isInteger(value.waitMs) || value.waitMs < 0 || value.waitMs > 60000) throw new TypeError("taskEventsRequest.waitMs must be an integer between 0 and 60000");
  }
  return value;
}

// ── 6. TaskWaitRequest ─────────────────────────────────────────

export function validateTaskWaitRequest(input) {
  const value = assertObject(input, "taskWaitRequest");
  assertString(value.taskId, "taskWaitRequest.taskId");
  if (value.timeoutMs !== undefined) {
    if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 0 || value.timeoutMs > 86400000) throw new TypeError("taskWaitRequest.timeoutMs must be an integer between 0 and 86400000");
  }
  if (value.terminalStatuses !== undefined) {
    if (!Array.isArray(value.terminalStatuses) || value.terminalStatuses.length === 0) throw new TypeError("taskWaitRequest.terminalStatuses must be a non-empty array");
    if (new Set(value.terminalStatuses).size !== value.terminalStatuses.length) throw new TypeError("taskWaitRequest.terminalStatuses must not contain duplicates");
    for (const s of value.terminalStatuses) {
      assertEnum(s, TERMINAL_TASK_STATUSES, "taskWaitRequest.terminalStatuses");
    }
  }
  return value;
}

// ── 7. TaskCancelRequest ───────────────────────────────────────

export function validateTaskCancelRequest(input) {
  const value = assertObject(input, "taskCancelRequest");
  assertString(value.taskId, "taskCancelRequest.taskId");
  assertOptionalString(value.reason, "taskCancelRequest.reason");
  assertOptionalString(value.requestedBy, "taskCancelRequest.requestedBy");
  return value;
}

// ── 8. TaskResumeRequest ───────────────────────────────────────

export function validateTaskResumeRequest(input) {
  const value = assertObject(input, "taskResumeRequest");
  assertString(value.taskId, "taskResumeRequest.taskId");
  assertOptionalString(value.fromStepId, "taskResumeRequest.fromStepId");
  assertOptionalString(value.reason, "taskResumeRequest.reason");
  assertOptionalString(value.idempotencyKey, "taskResumeRequest.idempotencyKey");
  return value;
}

// ── 9. TaskControlResponse ─────────────────────────────────────

export function validateTaskControlResponse(input) {
  const value = assertObject(input, "taskControlResponse");
  assertString(value.taskId, "taskControlResponse.taskId");
  assertString(value.runId, "taskControlResponse.runId");
  if (typeof value.accepted !== "boolean") throw new TypeError("taskControlResponse.accepted must be a boolean");
  assertEnum(value.status, RUN_STATUSES, "taskControlResponse.status");
  assertIsoString(value.timestamp, "taskControlResponse.timestamp");
  assertOptionalString(value.message, "taskControlResponse.message");
  return value;
}

// ── 10. TaskEventsResult ─────────────────────────────────────────

export function validateTaskEventsResult(input) {
  const value = assertObject(input, "taskEventsResult");
  assertString(value.taskId, "taskEventsResult.taskId");
  if (!Array.isArray(value.events)) throw new TypeError("taskEventsResult.events must be an array");
  for (const e of value.events) {
    validateHarnessEvent(e);
    if (e.taskId !== value.taskId) throw new TypeError("taskEventsResult.events must all have the same taskId");
  }
  for (let i = 1; i < value.events.length; i++) {
    if (value.events[i].sequence <= value.events[i - 1].sequence) throw new TypeError("taskEventsResult.events must be strictly increasing by sequence");
  }
  if (!Number.isInteger(value.nextSequence) || value.nextSequence < -1) throw new TypeError("taskEventsResult.nextSequence must be an integer >= -1");
  if (typeof value.hasMore !== "boolean") throw new TypeError("taskEventsResult.hasMore must be a boolean");
  if (value.events.length > 0 && value.nextSequence !== value.events[value.events.length - 1].sequence) throw new TypeError("taskEventsResult.nextSequence must equal the last event sequence when events is non-empty");
  return value;
}

// ── 11. TaskWaitResult ──────────────────────────────────────────

export function validateTaskWaitResult(input) {
  const value = assertObject(input, "taskWaitResult");
  assertString(value.taskId, "taskWaitResult.taskId");
  assertEnum(value.status, RUN_STATUSES, "taskWaitResult.status");
  if (typeof value.terminal !== "boolean") throw new TypeError("taskWaitResult.terminal must be a boolean");
  const isTermStatus = ["completed","blocked","failed","cancelled"].includes(value.status);
  if (value.terminal !== isTermStatus) throw new TypeError("taskWaitResult.terminal must match whether status is a durable terminal type");
  if (typeof value.timedOut !== "boolean") throw new TypeError("taskWaitResult.timedOut must be a boolean");
  if (value.terminal && value.timedOut) throw new TypeError("taskWaitResult.timedOut must be false when terminal is true");
  if (!Array.isArray(value.events)) throw new TypeError("taskWaitResult.events must be an array");
  for (const e of value.events) {
    validateHarnessEvent(e);
    if (e.taskId !== value.taskId) throw new TypeError("taskWaitResult.events must all have the same taskId");
  }
  for (let i = 1; i < value.events.length; i++) {
    if (value.events[i].sequence <= value.events[i - 1].sequence) throw new TypeError("taskWaitResult.events must be strictly increasing by sequence");
  }
  if (!Number.isInteger(value.nextSequence) || value.nextSequence < -1) throw new TypeError("taskWaitResult.nextSequence must be an integer >= -1");
  if (value.events.length > 0 && value.nextSequence !== value.events[value.events.length - 1].sequence) throw new TypeError("taskWaitResult.nextSequence must equal the last event sequence when events is non-empty");
  return value;
}
