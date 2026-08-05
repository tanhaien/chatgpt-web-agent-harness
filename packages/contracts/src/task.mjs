import { RISK_LEVELS, RUN_STATUSES, assertEnum, assertObject, assertString, assertStringArray } from "./common.mjs";

export function validateTaskStep(input) {
  const value = assertObject(input, "taskStep");
  assertString(value.id, "taskStep.id");
  assertString(value.title, "taskStep.title");
  assertString(value.objective, "taskStep.objective");
  assertStringArray(value.dependsOn ?? [], "taskStep.dependsOn");
  assertStringArray(value.requiredCapabilities ?? [], "taskStep.requiredCapabilities");
  assertStringArray(value.acceptanceCriteria ?? [], "taskStep.acceptanceCriteria");
  assertStringArray(value.evidenceRequired ?? [], "taskStep.evidenceRequired");
  assertEnum(value.risk, RISK_LEVELS, "taskStep.risk");
  assertEnum(value.status, RUN_STATUSES, "taskStep.status");
  if (!Number.isInteger(value.maxRetries) || value.maxRetries < 0) throw new TypeError("taskStep.maxRetries must be a non-negative integer");
  return value;
}

export function validateTask(input) {
  const value = assertObject(input, "task");
  assertString(value.id, "task.id");
  assertString(value.goal, "task.goal");
  assertEnum(value.status, RUN_STATUSES, "task.status");
  if (!Array.isArray(value.steps)) throw new TypeError("task.steps must be an array");
  value.steps.forEach(validateTaskStep);
  return value;
}
