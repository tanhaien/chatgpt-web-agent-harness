import assert from "node:assert/strict";
import {
  canonicalToolId,
  createHarnessEvent,
  eventFamily,
  isTerminalEventType,
  validateAgentResult,
  validateArtifactRef,
  validateCallContext,
  validateCanonicalTool,
  validateDelegateTaskRequest,
  validateDelegateTaskResponse,
  validateDelegationRequest,
  validateEventCursor,
  validateExecutionResult,
  validateHarnessEvent,
  validatePolicyDecision,
  validateProviderDefinition,
  validateTask,
  validateTaskCancelRequest,
  validateTaskControlResponse,
  validateTaskEventsRequest,
  validateTaskEventsResult,
  validateTaskWaitRequest,
  validateTaskWaitResult,
  validateTaskLease,
  validateTaskResumeRequest,
  validateTaskStatusRequest,
  validateTaskStatusResponse,
  validateToolCallResult
} from "../src/index.mjs";

const provider = validateProviderDefinition({
  id: "local-machine",
  displayName: "Local Machine",
  transport: "streamable-http",
  endpoint: "http://127.0.0.1:8787/mcp",
  capabilities: ["filesystem", "process"],
  trustLevel: "trusted-local"
});
assert.equal(provider.id, "local-machine");
assert.equal(canonicalToolId("local-machine", "read_file"), "local-machine/read_file");

validateCanonicalTool({
  id: "local-machine/read_file",
  providerId: "local-machine",
  sourceName: "read_file",
  description: "Read a file",
  inputSchema: { type: "object" },
  capabilities: ["filesystem.read"],
  risk: "read"
});

validateTask({
  id: "task-1",
  goal: "Build contracts",
  status: "running",
  steps: [{
    id: "step-1",
    title: "Define schemas",
    objective: "Create stable runtime contracts",
    dependsOn: [],
    requiredCapabilities: ["filesystem.write"],
    acceptanceCriteria: ["Tests pass"],
    evidenceRequired: ["Test output"],
    risk: "safe-write",
    status: "running",
    maxRetries: 2
  }]
});

// ── Event lifecycle taxonomy ───────────────────────────────────

// positive: validateHarnessEvent with required fields + payload
validateHarnessEvent({
  eventId: "event-1",
  taskId: "task-1",
  runId: "run-1",
  type: "task.created",
  sequence: 0,
  timestamp: new Date().toISOString(),
  payload: {}
});

// positive: all optional fields
validateHarnessEvent({
  eventId: "event-2",
  taskId: "task-1",
  runId: "run-1",
  type: "step.started",
  sequence: 1,
  timestamp: new Date().toISOString(),
  payload: {},
  stepId: "step-1",
  agentId: "agent-1",
  traceId: "trace-1",
  causationId: "cause-1",
  correlationId: "corr-1",
  idempotencyKey: "idem-1",
  metadata: {}
});

// negative: unknown event type
assert.throws(() => validateHarnessEvent({
  eventId: "ev", taskId: "t", runId: "r", type: "task.unknown", sequence: 0,
  timestamp: new Date().toISOString(), payload: {}
}));
// negative: malformed timestamp
assert.throws(() => validateHarnessEvent({
  eventId: "ev", taskId: "t", runId: "r", type: "task.created", sequence: 0,
  timestamp: "bad", payload: {}
}));
// negative: missing payload
assert.throws(() => validateHarnessEvent({
  eventId: "ev", taskId: "t", runId: "r", type: "task.created", sequence: 0,
  timestamp: new Date().toISOString()
}));
// negative: empty optional stepId
assert.throws(() => validateHarnessEvent({
  eventId: "ev", taskId: "t", runId: "r", type: "task.created", sequence: 0,
  timestamp: new Date().toISOString(), payload: {}, stepId: ""
}));

// ── createHarnessEvent factory ──────────────────────────────────

const factoryEvent = createHarnessEvent({
  taskId: "task-1",
  runId: "run-1",
  type: "task.created",
  stepId: "step-1",
  causationId: "cause-1"
});
assert.equal(factoryEvent.taskId, "task-1");
assert.equal(factoryEvent.runId, "run-1");
assert.equal(factoryEvent.type, "task.created");
assert.equal(factoryEvent.stepId, "step-1");
assert.equal(factoryEvent.causationId, "cause-1");
// defaults
assert.equal(factoryEvent.sequence, 0);
assert.deepEqual(factoryEvent.payload, {});
assert.deepEqual(factoryEvent.metadata, {});
assert.ok(/^[0-9a-f-]{36}$/.test(factoryEvent.eventId));
assert.ok(!isNaN(new Date(factoryEvent.timestamp).getTime()));

// factory: preserves explicit sequence=0
const seq0 = createHarnessEvent({
  taskId: "t", runId: "r", type: "task.created", sequence: 0
});
assert.equal(seq0.sequence, 0);

// factory: does not mutate caller input
const callerInput = { taskId: "t", runId: "r", type: "task.created", extra: "keep" };
const beforeKeys = Object.keys(callerInput).slice();
createHarnessEvent(callerInput);
assert.deepEqual(Object.keys(callerInput), beforeKeys);
assert.equal(callerInput.extra, "keep");

// ── isTerminalEventType ─────────────────────────────────────────

// terminal from each family
assert.equal(isTerminalEventType("task.completed"), true);
assert.equal(isTerminalEventType("task.blocked"), true);
assert.equal(isTerminalEventType("task.failed"), true);
assert.equal(isTerminalEventType("task.cancelled"), true);
assert.equal(isTerminalEventType("step.completed"), true);
assert.equal(isTerminalEventType("step.blocked"), true);
assert.equal(isTerminalEventType("step.failed"), true);
assert.equal(isTerminalEventType("step.skipped"), true);
assert.equal(isTerminalEventType("tool.completed"), true);
assert.equal(isTerminalEventType("tool.failed"), true);
assert.equal(isTerminalEventType("agent.completed"), true);
assert.equal(isTerminalEventType("agent.failed"), true);
assert.equal(isTerminalEventType("agent.cancelled"), true);

// non-terminal
assert.equal(isTerminalEventType("task.created"), false);
assert.equal(isTerminalEventType("task.started"), false);
assert.equal(isTerminalEventType("step.created"), false);
assert.equal(isTerminalEventType("tool.started"), false);
assert.equal(isTerminalEventType("retry.scheduled"), false);
assert.equal(isTerminalEventType("agent.spawned"), false);

// ── eventFamily ─────────────────────────────────────────────────

assert.equal(eventFamily("task.created"), "task");
assert.equal(eventFamily("task.completed"), "task");
assert.equal(eventFamily("step.started"), "step");
assert.equal(eventFamily("step.skipped"), "step");
assert.equal(eventFamily("tool.started"), "tool");
assert.equal(eventFamily("tool.failed"), "tool");
assert.equal(eventFamily("tool-call.requested"), "tool-call");
assert.equal(eventFamily("tool-call.started"), "tool-call");
assert.equal(eventFamily("tool-call.succeeded"), "tool-call");
assert.equal(eventFamily("tool-call.failed"), "tool-call");
assert.equal(eventFamily("retry.scheduled"), "control");
assert.equal(eventFamily("replan.requested"), "control");
assert.equal(eventFamily("checkpoint.created"), "control");
assert.equal(eventFamily("checkpoint.restored"), "checkpoint");
assert.equal(eventFamily("approval.requested"), "control");
assert.equal(eventFamily("approval.granted"), "control");
assert.equal(eventFamily("approval.denied"), "control");
assert.equal(eventFamily("agent.spawned"), "agent");
assert.equal(eventFamily("agent.cancelled"), "agent");

// terminal classification
assert.equal(isTerminalEventType("step.cancelled"), true);
assert.equal(isTerminalEventType("tool-call.succeeded"), true);
assert.equal(isTerminalEventType("tool-call.failed"), true);
assert.equal(isTerminalEventType("tool-call.started"), false);

// eventFamily rejects unknown
assert.throws(() => eventFamily("unknown.type"));
assert.throws(() => eventFamily("task.unknown"));

validateDelegationRequest({
  taskId: "task-1",
  goal: "Implement one bounded change",
  role: "executor",
  requiredCapabilities: ["filesystem.write"],
  acceptanceCriteria: ["Tests pass"],
  risk: "safe-write",
  maxToolCalls: 20,
  timeoutMs: 120000
});

validateAgentResult({
  status: "completed",
  summary: "Done",
  artifacts: [],
  evidence: [],
  filesChanged: [],
  assumptions: [],
  unresolvedIssues: []
});

validateArtifactRef({
  id: "artifact-1",
  kind: "test-log",
  uri: "file:///tmp/test.log",
  createdAt: new Date().toISOString()
});

assert.throws(() => validateProviderDefinition({ id: "bad" }));
assert.throws(() => validateCanonicalTool({
  id: "wrong",
  providerId: "local-machine",
  sourceName: "read_file",
  description: "Read",
  inputSchema: {},
  capabilities: [],
  risk: "read"
}));

// ── PolicyDecision ─────────────────────────────────────────────
const policy = validatePolicyDecision({
  action: "allow",
  risk: "low",
  reasons: ["matches allowlist"],
  constraints: { scope: "read-only" },
  approvalScope: {}
});
assert.equal(policy.action, "allow");
assert.equal(policy.risk, "low");

// negative: bad action
assert.throws(() => validatePolicyDecision({ action: "block", risk: "low", reasons: ["nope"] }));
// negative: bad risk
assert.throws(() => validatePolicyDecision({ action: "allow", risk: "unknown", reasons: ["nope"] }));
// negative: empty reasons array
assert.throws(() => validatePolicyDecision({ action: "allow", risk: "low", reasons: [] }));

// ── CallContext ────────────────────────────────────────────────
const callCtx = validateCallContext({
  traceId: "trace-1",
  taskId: "task-1",
  runId: "run-1",
  stepId: "step-1",
  agentId: "agent-1",
  providerId: "local-machine",
  toolId: "read_file",
  idempotencyKey: "idem-1",
  deadlineAt: new Date(Date.now() + 60000).toISOString(),
  attempt: 1,
  metadata: {}
});
assert.equal(callCtx.traceId, "trace-1");
assert.equal(callCtx.attempt, 1);

// negative: missing providerId
assert.throws(() => validateCallContext({ traceId: "t", toolId: "t", attempt: 1, metadata: {} }));
// negative: attempt < 1
assert.throws(() => validateCallContext({ traceId: "t", providerId: "p", toolId: "t", attempt: 0, metadata: {} }));
// negative: malformed deadlineAt
assert.throws(() => validateCallContext({ traceId: "t", providerId: "p", toolId: "t", attempt: 1, metadata: {}, deadlineAt: "not-a-date" }));

// ── ToolCallResult ─────────────────────────────────────────────
const now = new Date().toISOString();
const later = new Date(Date.now() + 500).toISOString();
const okResult = validateToolCallResult({
  ok: true,
  providerId: "local-machine",
  toolId: "read_file",
  startedAt: now,
  finishedAt: later,
  durationMs: 500,
  output: "content",
  artifacts: [],
  retryable: false
});
assert.equal(okResult.ok, true);

const errResult = validateToolCallResult({
  ok: false,
  providerId: "local-machine",
  toolId: "read_file",
  startedAt: now,
  finishedAt: later,
  durationMs: 500,
  error: "timeout",
  artifacts: [],
  retryable: true
});
assert.equal(errResult.ok, false);

// negative: ok=true must not have error
assert.throws(() => validateToolCallResult({
  ok: true, providerId: "p", toolId: "t", startedAt: now, finishedAt: later,
  durationMs: 1, error: "bad", artifacts: [], retryable: false
}));
// negative: ok=false must have error
assert.throws(() => validateToolCallResult({
  ok: false, providerId: "p", toolId: "t", startedAt: now, finishedAt: later,
  durationMs: 1, artifacts: [], retryable: false
}));
// negative: durationMs < 0
assert.throws(() => validateToolCallResult({
  ok: true, providerId: "p", toolId: "t", startedAt: now, finishedAt: later,
  durationMs: -1, artifacts: [], retryable: false
}));
// negative: malformed startedAt
assert.throws(() => validateToolCallResult({
  ok: true, providerId: "p", toolId: "t", startedAt: "bad-date", finishedAt: later,
  durationMs: 1, artifacts: [], retryable: false
}));
// negative: malformed finishedAt
assert.throws(() => validateToolCallResult({
  ok: true, providerId: "p", toolId: "t", startedAt: now, finishedAt: "bad-date",
  durationMs: 1, artifacts: [], retryable: false
}));

// ── ExecutionResult ────────────────────────────────────────────
const execResult = validateExecutionResult({
  status: "completed",
  summary: "All steps succeeded",
  toolCalls: [],
  artifacts: [],
  evidence: ["screenshot.png"],
  failure: { reason: "none" }
});
assert.equal(execResult.status, "completed");

// negative: bad status
assert.throws(() => validateExecutionResult({
  status: "running", summary: "x", toolCalls: [], artifacts: [], evidence: []
}));

// ── TaskLease ──────────────────────────────────────────────────
const lease = validateTaskLease({
  taskId: "task-1",
  stepId: "step-1",
  workerId: "worker-1",
  acquiredAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-01T00:05:00.000Z",
  fencingToken: 1
});
assert.equal(lease.taskId, "task-1");
assert.equal(lease.fencingToken, 1);

// negative: expiresAt <= acquiredAt
assert.throws(() => validateTaskLease({
  taskId: "t", stepId: "s", workerId: "w",
  acquiredAt: "2026-01-01T00:05:00.000Z", expiresAt: "2026-01-01T00:05:00.000Z",
  fencingToken: 1
}));
// negative: fencingToken < 1
assert.throws(() => validateTaskLease({
  taskId: "t", stepId: "s", workerId: "w",
  acquiredAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T00:05:00.000Z",
  fencingToken: 0
}));
// negative: malformed acquiredAt
assert.throws(() => validateTaskLease({
  taskId: "t", stepId: "s", workerId: "w",
  acquiredAt: "not-a-date", expiresAt: "2026-01-01T00:05:00.000Z",
  fencingToken: 1
}));
// negative: malformed expiresAt
assert.throws(() => validateTaskLease({
  taskId: "t", stepId: "s", workerId: "w",
  acquiredAt: "2026-01-01T00:00:00.000Z", expiresAt: "not-a-date",
  fencingToken: 1
}));
// positive: timezone-offset ISO proves parsed comparison, not lexical.
// "2026-01-01T07:00:00+07:00" = 2026-01-01T00:00:00Z; lexically
// "2026-01-01T07:..." > "2026-01-01T00:...", but parsed epoch is equal.
const tzLease = validateTaskLease({
  taskId: "t", stepId: "s", workerId: "w",
  acquiredAt: "2026-01-01T07:00:00+07:00",
  expiresAt: "2026-01-01T00:05:00.000Z",
  fencingToken: 1
});
assert.equal(tzLease.acquiredAt, "2026-01-01T07:00:00+07:00");
// same epoch must reject (expiresAt <= acquiredAt using parsed ms)
assert.throws(() => validateTaskLease({
  taskId: "t", stepId: "s", workerId: "w",
  acquiredAt: "2026-01-01T07:00:00+07:00",
  expiresAt: "2026-01-01T00:00:00.000Z",
  fencingToken: 1
}));

// ── EventCursor ────────────────────────────────────────────────
const cursor = validateEventCursor({ taskId: "task-1", afterSequence: 0, limit: 100 });
assert.equal(cursor.taskId, "task-1");
assert.equal(cursor.limit, 100);

// EventCursor without limit (optional)
const cursorNoLimit = validateEventCursor({ taskId: "task-1", afterSequence: 5 });
assert.equal(cursorNoLimit.afterSequence, 5);

// negative: afterSequence < -1
assert.throws(() => validateEventCursor({ taskId: "t", afterSequence: -2 }));
// positive: afterSequence -1 is start-of-stream sentinel
validateEventCursor({ taskId: "task-1", afterSequence: -1 });
// negative: limit < 1
assert.throws(() => validateEventCursor({ taskId: "t", afterSequence: 0, limit: 0 }));
// negative: limit > 1000
assert.throws(() => validateEventCursor({ taskId: "t", afterSequence: 0, limit: 1001 }));

// ── DelegateTaskRequest ────────────────────────────────────────
const dtr = validateDelegateTaskRequest({
  goal: "Build authentication module",
  taskId: "task-1",
  parentTaskId: "parent-1",
  role: "executor",
  requiredCapabilities: ["filesystem.write"],
  acceptanceCriteria: ["Tests pass"],
  evidenceRequired: ["test-output.log"],
  risk: "safe-write",
  maxToolCalls: 50,
  timeoutMs: 120000,
  metadata: { source: "manual" },
  idempotencyKey: "idem-1"
});
assert.equal(dtr.goal, "Build authentication module");
assert.equal(dtr.role, "executor");
assert.equal(dtr.maxToolCalls, 50);

// negative: bad role
assert.throws(() => validateDelegateTaskRequest({
  goal: "g", role: "viewer", requiredCapabilities: [], acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 1000
}));
// negative: empty acceptanceCriteria
assert.throws(() => validateDelegateTaskRequest({
  goal: "g", role: "executor", requiredCapabilities: [], acceptanceCriteria: [], risk: "read", maxToolCalls: 1, timeoutMs: 1000
}));
// negative: maxToolCalls < 1
assert.throws(() => validateDelegateTaskRequest({
  goal: "g", role: "executor", requiredCapabilities: [], acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 0, timeoutMs: 1000
}));
// negative: maxToolCalls > 10000
assert.throws(() => validateDelegateTaskRequest({
  goal: "g", role: "executor", requiredCapabilities: [], acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 10001, timeoutMs: 1000
}));
// negative: timeoutMs < 1000
assert.throws(() => validateDelegateTaskRequest({
  goal: "g", role: "executor", requiredCapabilities: [], acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 999
}));
// negative: timeoutMs > 86400000
assert.throws(() => validateDelegateTaskRequest({
  goal: "g", role: "executor", requiredCapabilities: [], acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 86400001
}));
// non-mutation
const dtrInput = { goal: "g", role: "executor", acceptanceCriteria: ["a"], risk: "read", maxToolCalls: 1, timeoutMs: 1000 };
const dtrKeys = Object.keys(dtrInput).slice();
validateDelegateTaskRequest(dtrInput);
assert.deepEqual(Object.keys(dtrInput), dtrKeys);

// ── DelegateTaskResponse ───────────────────────────────────────
const dtResp = validateDelegateTaskResponse({
  taskId: "task-1",
  runId: "run-1",
  agentId: "agent-1",
  status: "queued",
  createdAt: new Date().toISOString(),
  accepted: true
});
assert.equal(dtResp.status, "queued");
assert.equal(dtResp.accepted, true);

// positive: queued + accepted=false is valid (rejected prior to start)
const dtRejected = validateDelegateTaskResponse({
  taskId: "t", runId: "r", agentId: "a", status: "queued", createdAt: new Date().toISOString(), accepted: false
});
assert.equal(dtRejected.accepted, false);

// negative: bad status
assert.throws(() => validateDelegateTaskResponse({
  taskId: "t", runId: "r", agentId: "a", status: "completed", createdAt: new Date().toISOString(), accepted: false
}));
// negative: running must have accepted=true
assert.throws(() => validateDelegateTaskResponse({
  taskId: "t", runId: "r", agentId: "a", status: "running", createdAt: new Date().toISOString(), accepted: false
}));

// ── TaskStatusRequest ──────────────────────────────────────────
const tsReq = validateTaskStatusRequest({ taskId: "task-1" });
assert.equal(tsReq.taskId, "task-1");

// negative: missing taskId
assert.throws(() => validateTaskStatusRequest({}));

// ── TaskStatusResponse ─────────────────────────────────────────
const tsResp = validateTaskStatusResponse({
  taskId: "task-1",
  runId: "run-1",
  status: "running",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:05:00.000Z",
  startedAt: "2026-01-01T00:01:00.000Z",
  finishedAt: undefined,
  currentStepId: "step-2",
  progress: { completedSteps: 3, totalSteps: 5 },
  summary: "In progress",
  failure: { reason: "none" }
});
assert.equal(tsResp.status, "running");
assert.equal(tsResp.progress.completedSteps, 3);
assert.equal(tsResp.progress.totalSteps, 5);

// negative: bad status
assert.throws(() => validateTaskStatusResponse({
  taskId: "t", runId: "r", status: "invalid", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", progress: { completedSteps: 0, totalSteps: 0 }
}));
// negative: completedSteps > totalSteps
assert.throws(() => validateTaskStatusResponse({
  taskId: "t", runId: "r", status: "running", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", progress: { completedSteps: 5, totalSteps: 3 }
}));
// negative: malformed createdAt
assert.throws(() => validateTaskStatusResponse({
  taskId: "t", runId: "r", status: "running", createdAt: "bad", updatedAt: "2026-01-01T00:00:00.000Z", progress: { completedSteps: 0, totalSteps: 0 }
}));
// negative: updatedAt < createdAt
assert.throws(() => validateTaskStatusResponse({
  taskId: "t", runId: "r", status: "running", createdAt: "2026-01-01T00:05:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", progress: { completedSteps: 0, totalSteps: 0 }
}));
// negative: startedAt < createdAt
assert.throws(() => validateTaskStatusResponse({
  taskId: "t", runId: "r", status: "running", createdAt: "2026-01-01T00:05:00.000Z", updatedAt: "2026-01-01T00:10:00.000Z", startedAt: "2026-01-01T00:00:00.000Z", progress: { completedSteps: 0, totalSteps: 0 }
}));
// negative: finishedAt < createdAt
assert.throws(() => validateTaskStatusResponse({
  taskId: "t", runId: "r", status: "completed", createdAt: "2026-01-01T00:05:00.000Z", updatedAt: "2026-01-01T00:10:00.000Z", finishedAt: "2026-01-01T00:00:00.000Z", progress: { completedSteps: 5, totalSteps: 5 }
}));
// negative: finishedAt < startedAt
assert.throws(() => validateTaskStatusResponse({
  taskId: "t", runId: "r", status: "completed", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:10:00.000Z", startedAt: "2026-01-01T00:05:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z", progress: { completedSteps: 5, totalSteps: 5 }
}));
// positive: full temporal chain (createdAt <= startedAt <= finishedAt <= updatedAt)
validateTaskStatusResponse({
  taskId: "t", runId: "r", status: "completed",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:30:00.000Z",
  startedAt: "2026-01-01T00:01:00.000Z",
  finishedAt: "2026-01-01T00:25:00.000Z",
  progress: { completedSteps: 5, totalSteps: 5 }
});

// ── TaskEventsRequest ──────────────────────────────────────────
const teReq = validateTaskEventsRequest({
  taskId: "task-1",
  afterSequence: 10,
  limit: 500,
  waitMs: 30000
});
assert.equal(teReq.taskId, "task-1");
assert.equal(teReq.waitMs, 30000);
// positive: afterSequence -1 is start-of-stream sentinel
validateTaskEventsRequest({ taskId: "t", afterSequence: -1 });
// negative: afterSequence < -1
assert.throws(() => validateTaskEventsRequest({ taskId: "t", afterSequence: -2 }));
// minimal (optional fields absent)
validateTaskEventsRequest({ taskId: "t", afterSequence: 0 });

// negative: limit < 1
assert.throws(() => validateTaskEventsRequest({ taskId: "t", afterSequence: 0, limit: 0 }));
// negative: limit > 1000
assert.throws(() => validateTaskEventsRequest({ taskId: "t", afterSequence: 0, limit: 1001 }));
// negative: waitMs < 0
assert.throws(() => validateTaskEventsRequest({ taskId: "t", afterSequence: 0, waitMs: -1 }));
// negative: waitMs > 60000
assert.throws(() => validateTaskEventsRequest({ taskId: "t", afterSequence: 0, waitMs: 60001 }));

// ── TaskWaitRequest ────────────────────────────────────────────
const twReq = validateTaskWaitRequest({
  taskId: "task-1",
  timeoutMs: 30000,
  terminalStatuses: ["completed", "failed"]
});
assert.equal(twReq.taskId, "task-1");
// minimal (just taskId)
validateTaskWaitRequest({ taskId: "t" });

// negative: invalid terminal status
assert.throws(() => validateTaskWaitRequest({
  taskId: "t", terminalStatuses: ["completed", "running"]
}));
// negative: empty terminalStatuses
assert.throws(() => validateTaskWaitRequest({
  taskId: "t", terminalStatuses: []
}));
// negative: timeoutMs out of range
assert.throws(() => validateTaskWaitRequest({ taskId: "t", timeoutMs: 86400001 }));
// negative: duplicate terminalStatuses
assert.throws(() => validateTaskWaitRequest({
  taskId: "t", terminalStatuses: ["completed", "completed"]
}));

// ── TaskCancelRequest ──────────────────────────────────────────
const tcReq = validateTaskCancelRequest({
  taskId: "task-1",
  reason: "No longer needed",
  requestedBy: "user-1"
});
assert.equal(tcReq.taskId, "task-1");
// minimal
validateTaskCancelRequest({ taskId: "t" });

// negative: empty reason
assert.throws(() => validateTaskCancelRequest({ taskId: "t", reason: "" }));

// ── TaskResumeRequest ──────────────────────────────────────────
const trReq = validateTaskResumeRequest({
  taskId: "task-1",
  fromStepId: "step-2",
  reason: "Fix applied",
  idempotencyKey: "resume-1"
});
assert.equal(trReq.taskId, "task-1");
// minimal
validateTaskResumeRequest({ taskId: "t" });

// ── TaskControlResponse (shared cancel/resume ack) ─────────────
const tcr = validateTaskControlResponse({
  taskId: "task-1",
  runId: "run-1",
  accepted: true,
  status: "cancelled",
  timestamp: new Date().toISOString(),
  message: "Task cancelled by user"
});
assert.equal(tcr.taskId, "task-1");
assert.equal(tcr.accepted, true);

// negative: bad status
assert.throws(() => validateTaskControlResponse({
  taskId: "t", runId: "r", accepted: true, status: "running-custom", timestamp: new Date().toISOString()
}));
// negative: malformed timestamp
assert.throws(() => validateTaskControlResponse({
  taskId: "t", runId: "r", accepted: true, status: "cancelled", timestamp: "bad"
}));
// negative: empty message
assert.throws(() => validateTaskControlResponse({
  taskId: "t", runId: "r", accepted: true, status: "cancelled", timestamp: new Date().toISOString(), message: ""
}));

// non-mutation: TaskControlResponse
const tcrInput = { taskId: "t", runId: "r", accepted: true, status: "cancelled", timestamp: new Date().toISOString() };
const tcrKeys = Object.keys(tcrInput).slice();
  validateTaskControlResponse(tcrInput);
  assert.deepEqual(Object.keys(tcrInput), tcrKeys);

  // ── TaskEventsResult ────────────────────────────────────────────
  const ter = validateTaskEventsResult({
    taskId: "t",
    events: [
      {
        eventId: "e1", taskId: "t", runId: "r", type: "task.created", sequence: 0,
        timestamp: new Date().toISOString(), payload: {}, metadata: {}
      }
    ],
    nextSequence: 0,
    hasMore: false
  });
  assert.equal(ter.nextSequence, 0);
  assert.equal(ter.hasMore, false);

  {
    const e0 = { eventId:"e0",taskId:"t",runId:"r",type:"task.created",sequence:0,timestamp:new Date().toISOString(),payload:{},metadata:{} };
    const e1 = { eventId:"e1",taskId:"t",runId:"r",type:"task.queued",sequence:1,timestamp:new Date().toISOString(),payload:{},metadata:{} };
    validateTaskEventsResult({ taskId:"t", events:[e0,e1], nextSequence:1, hasMore:true });
  }

  // negative: bad sequence order
  assert.throws(() => validateTaskEventsResult({ taskId:"t", events:[
    {eventId:"e0",taskId:"t",runId:"r",type:"task.created",sequence:1,timestamp:new Date().toISOString(),payload:{},metadata:{}},
    {eventId:"e1",taskId:"t",runId:"r",type:"task.queued",sequence:0,timestamp:new Date().toISOString(),payload:{},metadata:{}},
  ], nextSequence:-1, hasMore:false }), /sequence/);
  // negative: nextSequence < -1
  assert.throws(() => validateTaskEventsResult({ taskId:"t", events:[], nextSequence:-2, hasMore:false }));
  // negative: mixed taskId
  assert.throws(() => validateTaskEventsResult({ taskId:"t", events:[
    {eventId:"e0",taskId:"t2",runId:"r",type:"task.created",sequence:0,timestamp:new Date().toISOString(),payload:{},metadata:{}},
  ], nextSequence:0, hasMore:false }), /taskId/);

  // ── TaskWaitResult ──────────────────────────────────────────────

  const twr = validateTaskWaitResult({
    taskId: "t", status: "completed", terminal: true, timedOut: false,
    events: [
      {eventId:"e0",taskId:"t",runId:"r",type:"task.created",sequence:0,timestamp:new Date().toISOString(),payload:{},metadata:{}},
      {eventId:"e1",taskId:"t",runId:"r",type:"task.completed",sequence:1,timestamp:new Date().toISOString(),payload:{summary:"ok",artifacts:[],evidence:[],filesChanged:[],assumptions:[],unresolvedIssues:[]},metadata:{}}
    ],
    nextSequence: 1
  });
  assert.equal(twr.terminal, true);
  assert.equal(twr.timedOut, false);

  // negative: terminal + timedOut
  assert.throws(() => validateTaskWaitResult({ taskId:"t", status:"completed", terminal:true, timedOut:true, events:[], nextSequence:-1 }));
  // negative: terminal but non-terminal status
  assert.throws(() => validateTaskWaitResult({ taskId:"t", status:"running", terminal:true, timedOut:false, events:[], nextSequence:-1 }));
  // non-mutation of events array
  const evts = [{eventId:"e0",taskId:"t",runId:"r",type:"task.created",sequence:0,timestamp:new Date().toISOString(),payload:{},metadata:{}}];
  const evtsCopy = JSON.parse(JSON.stringify(evts));
  validateTaskWaitResult({ taskId:"t", status:"completed", terminal:true, timedOut:false, events:evts, nextSequence:0 });
  assert.deepEqual(evts, evtsCopy);


console.log("contracts: all assertions passed");
