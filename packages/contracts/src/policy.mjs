import { assertEnum, assertObject, assertStringArray } from "./common.mjs";

export const POLICY_ACTIONS = Object.freeze(["allow", "deny", "require-approval"]);
export const POLICY_RISK_LEVELS = Object.freeze(["low", "medium", "high", "critical"]);

export function validatePolicyDecision(input) {
  const value = assertObject(input, "policyDecision");
  assertEnum(value.action, POLICY_ACTIONS, "policyDecision.action");
  assertEnum(value.risk, POLICY_RISK_LEVELS, "policyDecision.risk");
  assertStringArray(value.reasons, "policyDecision.reasons");
  if (value.reasons.length === 0) throw new TypeError("policyDecision.reasons must be non-empty");
  if (value.constraints !== undefined) assertObject(value.constraints, "policyDecision.constraints");
  if (value.approvalScope !== undefined) assertObject(value.approvalScope, "policyDecision.approvalScope");
  return value;
}
