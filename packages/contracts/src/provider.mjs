import { assertEnum, assertObject, assertString, assertStringArray } from "./common.mjs";

export const PROVIDER_TRANSPORTS = Object.freeze(["streamable-http", "stdio", "sse"]);
export const PROVIDER_TRUST_LEVELS = Object.freeze(["trusted-local", "sandboxed", "external"]);
export const PROVIDER_HEALTH = Object.freeze(["unknown", "healthy", "degraded", "offline"]);

export function validateProviderDefinition(input) {
  const value = assertObject(input, "provider");
  assertString(value.id, "provider.id");
  assertString(value.displayName, "provider.displayName");
  assertEnum(value.transport, PROVIDER_TRANSPORTS, "provider.transport");
  assertStringArray(value.capabilities ?? [], "provider.capabilities");
  assertEnum(value.trustLevel, PROVIDER_TRUST_LEVELS, "provider.trustLevel");
  if (value.transport === "stdio") assertString(value.command, "provider.command");
  if (value.transport !== "stdio") assertString(value.endpoint, "provider.endpoint");
  return value;
}

export function canonicalToolId(providerId, sourceName) {
  return `${assertString(providerId, "providerId")}/${assertString(sourceName, "sourceName")}`;
}
