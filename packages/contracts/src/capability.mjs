import { RISK_LEVELS, assertEnum, assertObject, assertString, assertStringArray } from "./common.mjs";
import { canonicalToolId } from "./provider.mjs";

export function validateCanonicalTool(input) {
  const value = assertObject(input, "tool");
  assertString(value.providerId, "tool.providerId");
  assertString(value.sourceName, "tool.sourceName");
  const expectedId = canonicalToolId(value.providerId, value.sourceName);
  if (value.id !== expectedId) throw new TypeError(`tool.id must equal ${expectedId}`);
  assertString(value.description, "tool.description");
  assertStringArray(value.capabilities ?? [], "tool.capabilities");
  assertEnum(value.risk, RISK_LEVELS, "tool.risk");
  assertObject(value.inputSchema ?? {}, "tool.inputSchema");
  return value;
}
