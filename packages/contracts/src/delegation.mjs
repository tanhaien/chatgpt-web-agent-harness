import { RISK_LEVELS, assertEnum, assertObject, assertString, assertStringArray } from "./common.mjs";

export function validateDelegationRequest(input) {
  const value = assertObject(input, "delegation");
  assertString(value.taskId, "delegation.taskId");
  assertString(value.goal, "delegation.goal");
  assertString(value.role, "delegation.role");
  assertStringArray(value.requiredCapabilities ?? [], "delegation.requiredCapabilities");
  assertStringArray(value.acceptanceCriteria ?? [], "delegation.acceptanceCriteria");
  assertEnum(value.risk, RISK_LEVELS, "delegation.risk");
  if (!Number.isInteger(value.maxToolCalls) || value.maxToolCalls < 1) throw new TypeError("delegation.maxToolCalls must be a positive integer");
  if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1) throw new TypeError("delegation.timeoutMs must be a positive integer");
  return value;
}

export function validateAgentResult(input) {
  const value = assertObject(input, "agentResult");
  if (!["completed", "blocked", "failed"].includes(value.status)) throw new TypeError("agentResult.status is invalid");
  assertString(value.summary, "agentResult.summary");
  assertStringArray(value.filesChanged ?? [], "agentResult.filesChanged");
  assertStringArray(value.assumptions ?? [], "agentResult.assumptions");
  assertStringArray(value.unresolvedIssues ?? [], "agentResult.unresolvedIssues");
  if (!Array.isArray(value.artifacts ?? [])) throw new TypeError("agentResult.artifacts must be an array");
  if (!Array.isArray(value.evidence ?? [])) throw new TypeError("agentResult.evidence must be an array");
  return value;
}
