import { validateHarnessEvent } from "../../contracts/src/index.mjs";
import { validateTaskStatusResponse } from "../../contracts/src/index.mjs";

export class SupervisorStateError extends Error {
  constructor(message) {
    super(message);
    this.name = "SupervisorStateError";
    this.code = "INVALID_TASK_STATE";
  }
}

const TERMINAL_TASK_TYPES = new Set(["task.completed", "task.blocked", "task.failed", "task.cancelled"]);
const TASK_LIFECYCLE = {
  "task.created": "created", "task.queued": "queued", "task.started": "running",
  "task.waiting": "waiting", "task.verifying": "verifying",
  "task.completed": "completed", "task.blocked": "blocked",
  "task.failed": "failed", "task.cancelled": "cancelled"
};
const LIFECYCLE_ORDER = ["created","queued","running","waiting","verifying","completed","blocked","failed","cancelled"];
const TERMINAL_STEP_TYPES = new Set(["step.completed","step.skipped","step.blocked","step.failed"]);
const COMPLETED_STEP_TYPES = new Set(["step.completed","step.skipped"]);

function maxTimestamp(events) {
  let max = events[0].timestamp;
  let maxEpoch = new Date(max).getTime();
  for (let i = 1; i < events.length; i++) {
    const e = new Date(events[i].timestamp).getTime();
    if (e > maxEpoch) { maxEpoch = e; max = events[i].timestamp; }
  }
  return max;
}

function validateLifecycle(sorted) {
  if (sorted[0].type !== "task.created") throw new SupervisorStateError("task.created must be the first event");
  if (sorted.filter(e => e.type === "task.created").length !== 1) throw new SupervisorStateError("exactly one task.created is required");

  let queued = false, started = false, terminal = false;
  for (let i = 1; i < sorted.length; i++) {
    const t = sorted[i].type;
    if (terminal) throw new SupervisorStateError("events after terminal task event");
    if (TERMINAL_TASK_TYPES.has(t)) {
      if (terminal) throw new SupervisorStateError("duplicate terminal task event");
      if (t === "task.cancelled") {
        if (!queued && !started) throw new SupervisorStateError("task.cancelled before task.queued");
      } else {
        if (!started) throw new SupervisorStateError(`${t} before task.started`);
      }
      terminal = true;
      continue;
    }
    if (t === "task.queued") {
      if (queued) throw new SupervisorStateError("duplicate task.queued");
      if (started) throw new SupervisorStateError("task.queued after task.started");
      queued = true;
    }
    if (t === "task.started") {
      if (started) throw new SupervisorStateError("duplicate task.started");
      if (!queued) throw new SupervisorStateError("task.started before task.queued");
      started = true;
    }
    if (t === "task.waiting" || t === "task.verifying") {
      if (!started) throw new SupervisorStateError(`${t} before task.started`);
    }
  }

  // Step lifecycle
  const stepById = new Map();
  for (const e of sorted) {
    if (e.type.startsWith("step.")) {
      if (!e.stepId) throw new SupervisorStateError("step event missing stepId");
      if (!stepById.has(e.stepId)) stepById.set(e.stepId, []);
      stepById.get(e.stepId).push(e);
    }
  }
  for (const [stepId, evts] of stepById) {
    if (evts[0].type !== "step.created") throw new SupervisorStateError(`step ${stepId}: must start with step.created`);
    if (evts.filter(e => e.type === "step.created").length > 1) throw new SupervisorStateError(`step ${stepId}: duplicate step.created`);
    let stepTerminal = false;
    for (let i = 1; i < evts.length; i++) {
      if (stepTerminal) throw new SupervisorStateError(`step ${stepId}: events after terminal step`);
      if (TERMINAL_STEP_TYPES.has(evts[i].type)) stepTerminal = true;
    }
  }
}

export function projectTaskStatus(events) {
  if (!Array.isArray(events) || events.length === 0) throw new TypeError("events must be a non-empty array");
  const sorted = events.map(e => validateHarnessEvent(e)).sort((a, b) => a.sequence - b.sequence);
  const seqs = new Set();
  for (const ev of sorted) { if (seqs.has(ev.sequence)) throw new SupervisorStateError(`duplicate sequence ${ev.sequence}`); seqs.add(ev.sequence); }
  const first = sorted[0];
  for (const ev of sorted) { if (ev.taskId !== first.taskId || ev.runId !== first.runId) throw new SupervisorStateError("mixed taskId/runId"); }

  validateLifecycle(sorted);

  let status = "created";
  for (const ev of sorted) { const m = TASK_LIFECYCLE[ev.type]; if (m && LIFECYCLE_ORDER.indexOf(m) > LIFECYCLE_ORDER.indexOf(status)) status = m; }

  const createdAt = sorted[0].timestamp;
  const updatedAt = maxTimestamp(sorted);
  const startedAt = sorted.find(e => e.type === "task.started")?.timestamp;
  const terminalEvent = sorted.find(e => TERMINAL_TASK_TYPES.has(e.type));
  const finishedAt = terminalEvent ? terminalEvent.timestamp : undefined;

  // Progress: only step lifecycle events for steps that were explicitly created.
  const stepById = new Map();
  for (const e of sorted) {
    if (e.type === "step.created") stepById.set(e.stepId, []);
  }
  for (const e of sorted) {
    if (e.type.startsWith("step.") && stepById.has(e.stepId)) {
      stepById.get(e.stepId).push(e);
    }
  }
  const totalSteps = stepById.size;
  let completedSteps = 0;
  for (const [, evts] of stepById) {
    if (evts.some(e => COMPLETED_STEP_TYPES.has(e.type))) completedSteps++;
  }

  // currentStepId: active non-terminal step with greatest latest-sequence
  let currentStepId = undefined;
  let bestSeq = -1;
  for (const [sid, evts] of stepById) {
    const latest = evts[evts.length - 1];
    if (!TERMINAL_STEP_TYPES.has(latest.type) && latest.sequence > bestSeq) {
      bestSeq = latest.sequence; currentStepId = sid;
    }
  }

  let summary = undefined, failure = undefined;
  if (terminalEvent) {
    if (terminalEvent.type === "task.completed" || terminalEvent.type === "task.blocked") summary = terminalEvent.payload.summary;
    if (terminalEvent.type === "task.failed") { failure = terminalEvent.payload.failure; summary = terminalEvent.payload.summary; }
  }

  return validateTaskStatusResponse({ taskId: first.taskId, runId: first.runId, status, createdAt, updatedAt, startedAt, finishedAt, currentStepId, progress: { completedSteps, totalSteps }, summary, failure });
}
