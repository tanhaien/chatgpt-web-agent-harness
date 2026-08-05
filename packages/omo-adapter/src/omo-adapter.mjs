import { EVENT_TYPES } from "../../contracts/src/index.mjs";

export const SOURCE_RECORD_TYPES = Object.freeze([
  "agent:started", "agent:completed", "agent:failed", "agent:cancelled",
  "tool:requested", "tool:started", "tool:succeeded", "tool:failed",
  "step:started", "step:waiting", "step:completed", "step:failed",
  "checkpoint:created", "checkpoint:restored",
  "approval:requested", "approval:granted", "approval:denied"
]);

const CANONICAL_MAP = {
  "agent:started":       "agent.started",
  "agent:completed":     "agent.completed",
  "agent:failed":        "agent.failed",
  "agent:cancelled":     "agent.cancelled",
  "tool:requested":      "tool-call.requested",
  "tool:started":        "tool-call.started",
  "tool:succeeded":      "tool-call.succeeded",
  "tool:failed":         "tool-call.failed",
  "step:started":        "step.started",
  "step:waiting":        "step.waiting",
  "step:completed":      "step.completed",
  "step:failed":         "step.failed",
  "checkpoint:created":  "checkpoint.created",
  "checkpoint:restored": "checkpoint.restored",
  "approval:requested":  "approval.requested",
  "approval:granted":    "approval.granted",
  "approval:denied":     "approval.denied",
};

const FORBIDDEN = new Set(["eventId","taskId","runId","sequence","timestamp"]);

function assertNonEmptyString(v, name) {
  if (typeof v !== "string" || v.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}
function assertOptionalNonEmptyString(v, name) {
  if (v !== undefined && v !== null) assertNonEmptyString(v, name);
}
function assertPlainObject(v, name) {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new TypeError(`${name} must be a plain object`);
}

function structErr(e) {
  if (!e || typeof e !== "object") throw new TypeError("error must be an object");
  assertNonEmptyString(e.name, "error.name");
  assertNonEmptyString(e.message, "error.message");
  const out = { name: e.name, message: e.message };
  if (e.code !== undefined) { assertNonEmptyString(e.code, "error.code"); out.code = e.code; }
  return out;
}

function familyOf(type) {
  if (type.startsWith("agent:")) return "agent";
  if (type.startsWith("tool:"))  return "tool-call";
  if (type.startsWith("step:"))  return "step";
  return "generic";
}

export function createOmoEventAdapter() {
  return { map };

  function map(record) {
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new TypeError("record must be a plain object");
    const type = record.type;
    if (!type || typeof type !== "string") throw new TypeError("record.type is required");
    if (!SOURCE_RECORD_TYPES.includes(type)) throw new TypeError(`unsupported source type: ${type}`);
    const canon = CANONICAL_MAP[type];
    if (!EVENT_TYPES.includes(canon)) throw new TypeError(`canonical type ${canon} not in EVENT_TYPES — contract mismatch`);

    for (const f of FORBIDDEN) {
      if (record[f] !== undefined) throw new TypeError(`record.${f} override is rejected`);
    }

    const family = familyOf(type);
    if (family === "agent") assertNonEmptyString(record.agentId, "record.agentId");
    if (family === "step")  assertNonEmptyString(record.stepId, "record.stepId");
    if (family === "tool-call") {
      assertNonEmptyString(record.toolId, "record.toolId");
      assertOptionalNonEmptyString(record.providerId, "record.providerId");
    }
    assertOptionalNonEmptyString(record.correlationId, "record.correlationId");
    assertOptionalNonEmptyString(record.causationId, "record.causationId");
    assertOptionalNonEmptyString(record.idempotencyKey, "record.idempotencyKey");
    assertOptionalNonEmptyString(record.message, "record.message");
    if (record.payload !== undefined) assertPlainObject(record.payload, "record.payload");
    if (record.metadata !== undefined) assertPlainObject(record.metadata, "record.metadata");

    const spec = { type: canon };

    // Payload
    const payload = {};
    if (record.payload) Object.assign(payload, record.payload);
    if (record.message !== undefined) payload.message = record.message;

    if (type.endsWith(":failed") && canon.endsWith(".failed")) {
      if (!record.error) throw new TypeError("failed record must have error");
      payload.error = structErr(record.error);
    }

    // Identities in payload
    if (family === "agent") spec.agentId = record.agentId;
    if (family === "step")  spec.stepId = record.stepId;
    if (family === "tool-call") {
      payload.toolId = record.toolId;
      payload.providerId = record.providerId || "omo";
    }

    spec.payload = payload;

    // Metadata: source provenance (shallow clone)
    const metadata = record.metadata ? { ...record.metadata } : {};
    metadata.source = "omo";
    metadata.sourceType = type;
    spec.metadata = metadata;

    if (record.correlationId) spec.correlationId = record.correlationId;
    if (record.causationId) spec.causationId = record.causationId;
    if (record.idempotencyKey) spec.idempotencyKey = record.idempotencyKey;

    return spec;
  }
}
