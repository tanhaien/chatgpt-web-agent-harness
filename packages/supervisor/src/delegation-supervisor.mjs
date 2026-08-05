import { createHash, randomUUID } from "node:crypto";
import { createHarnessEvent, nowIso, validateAgentResult, validateDelegateTaskRequest, validateDelegateTaskResponse, validateEventCursor } from "../../contracts/src/index.mjs";
import { projectTaskStatus, SupervisorStateError } from "./task-projector.mjs";

export { SupervisorStateError };

export class SupervisorConflictError extends Error {
  constructor(message) { super(message); this.name = "SupervisorConflictError"; this.code = "TASK_EXISTS"; }
}
export class SupervisorNotFoundError extends Error {
  constructor(message) { super(message); this.name = "SupervisorNotFoundError"; this.code = "TASK_NOT_FOUND"; }
}
export class SupervisorTimeoutError extends Error {
  constructor(message) { super(message); this.name = "SupervisorTimeoutError"; this.code = "TASK_TIMEOUT"; }
}

const TERMINAL_STATUSES = new Set(["completed","blocked","failed","cancelled"]);

function sanitizeError(err) {
  if (err === null || err === undefined) return { name: "Error", message: "Unknown error" };
  if (typeof err === "string" || typeof err === "number") return { name: "Error", message: String(err) };
  const failure = { name: typeof err.name === "string" && err.name.trim() ? err.name : "Error", message: typeof err.message === "string" && err.message.trim() ? err.message : "Unknown error" };
  if (typeof err.code === "string" && err.code.trim()) failure.code = err.code;
  return failure;
}

function isPlainObject(v) {
  if (!v || typeof v !== "object") return false;
  if (Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === null || proto === Object.prototype;
}

export class DelegationSupervisor {
  #eventStore; #executor; #clock; #ids; #running = new Map();

  constructor(options) {
    if (!options || typeof options !== "object") throw new TypeError("options must be an object");
    const e = options.eventStore;
    if (!e || typeof e.appendMany !== "function" || typeof e.list !== "function" || typeof e.latestSequence !== "function" || typeof e.getByIdempotencyKey !== "function") throw new TypeError("eventStore must have appendMany, list, latestSequence, getByIdempotencyKey");
    const x = options.executor;
    if (!x || typeof x.execute !== "function") throw new TypeError("executor must have execute");
    this.#eventStore = e; this.#executor = x;
    this.#clock = options.clock || nowIso;
    this.#ids = options.ids || { taskId: () => randomUUID(), runId: () => randomUUID(), agentId: () => randomUUID(), eventId: () => randomUUID() };
    if (typeof this.#clock !== "function") throw new TypeError("clock must be a function");
    const ids = this.#ids;
    if (typeof ids.taskId !== "function" || typeof ids.runId !== "function" || typeof ids.agentId !== "function" || typeof ids.eventId !== "function") throw new TypeError("ids must have taskId, runId, agentId, eventId functions");
  }

  #readAll(taskId) {
    const s = this.#eventStore; const latest = s.latestSequence(taskId); if (latest < 0) return [];
    const all = []; let after = -1;
    while (after < latest) { const p = s.list({ taskId, afterSequence: after, limit: 1000 }); if (p.length === 0) break; all.push(...p); after = p[p.length - 1].sequence; }
    return all;
  }

  delegate(request) {
    const req = validateDelegateTaskRequest({ ...request });
    let taskId;
    if (req.taskId) { taskId = req.taskId; }
    else if (req.idempotencyKey) { taskId = `task-idem-${createHash("sha256").update(req.idempotencyKey).digest("hex").slice(0, 24)}`; }
    else { taskId = this.#ids.taskId(); }
    const latest = this.#eventStore.latestSequence(taskId);
    if (latest >= 0) {
      if (req.idempotencyKey) {
        const existing = this.#eventStore.getByIdempotencyKey(taskId, req.idempotencyKey);
        if (existing) {
          const evts = this.#readAll(taskId);
          const created = evts.find(e => e.type === "task.created");
          if (created.idempotencyKey === req.idempotencyKey) {
            const runId = created.runId; const agentId = evts.find(e => e.type === "agent.spawned")?.agentId || "";
            const started = evts.some(e => e.type === "task.started");
            return validateDelegateTaskResponse({ taskId, runId, agentId, status: started ? "running" : "queued", createdAt: created.timestamp, accepted: true });
          }
        }
      }
      throw new SupervisorConflictError(`Task ${taskId} already exists`);
    }
    const runId = this.#ids.runId(); const agentId = this.#ids.agentId(); const clock = this.#clock;
    const cs = { type: "task.created", payload: { request: structuredClone(req), runId, agentId } };
    if (req.idempotencyKey) cs.idempotencyKey = req.idempotencyKey;
    const events = [
      me(this.#ids.eventId(), taskId, runId, 0, clock, cs),
      me(this.#ids.eventId(), taskId, runId, 1, clock, { type: "task.queued", payload: { role: req.role, risk: req.risk } }),
      me(this.#ids.eventId(), taskId, runId, 2, clock, { type: "agent.spawned", payload: { role: req.role }, agentId })
    ];
    this.#eventStore.appendMany(events);
    return validateDelegateTaskResponse({ taskId, runId, agentId, status: "queued", createdAt: events[0].timestamp, accepted: true });
  }

  status(taskId) {
    if (!taskId || typeof taskId !== "string" || taskId.trim() === "") throw new TypeError("taskId must be a non-empty string");
    if (this.#eventStore.latestSequence(taskId) < 0) return null;
    return projectTaskStatus(this.#readAll(taskId));
  }

  events(cursor) { validateEventCursor(cursor); return structuredClone(this.#eventStore.list(cursor)); }

  run(taskId) {
    if (!taskId || typeof taskId !== "string" || taskId.trim() === "") throw new TypeError("taskId must be a non-empty string");
    const ex = this.#running.get(taskId); if (ex) return ex;
    const p = this.#runInternal(taskId);
    this.#running.set(taskId, p);
    p.then(
      () => { if (this.#running.get(taskId) === p) this.#running.delete(taskId); },
      () => { if (this.#running.get(taskId) === p) this.#running.delete(taskId); }
    );
    return p;
  }

  async #runInternal(taskId) {
    const store = this.#eventStore; const latest = store.latestSequence(taskId);
    if (latest < 0) throw new SupervisorNotFoundError(`Task ${taskId} not found`);
    const evts = this.#readAll(taskId); const status = projectTaskStatus(evts);
    if (TERMINAL_STATUSES.has(status.status)) return status;
    if (status.status !== "queued") throw new SupervisorStateError(`Task ${taskId} is in state ${status.status}, only queued can start`);
    const runId = status.runId; const agentId = this.#getAgentId(evts);
    const request = evts.find(e => e.type === "task.created")?.payload?.request || {};
    store.appendMany([me(this.#ids.eventId(), taskId, runId, latest + 1, this.#clock, { type: "task.started", payload: {} })]);

    const timeoutMs = request.timeoutMs ?? 300000;
    const ctrl = new AbortController(); let settled = false; let timer = null; let emitInfrastructureError = undefined;
    const tp = new Promise((_, reject) => { timer = setTimeout(() => { ctrl.abort(); reject(new SupervisorTimeoutError(`Task ${taskId} timed out after ${timeoutMs}ms`)); }, timeoutMs); });

    const emit = (spec) => {
      if (settled) throw new SupervisorStateError("executor already settled");
      if (!isPlainObject(spec)) throw new TypeError("emit: eventSpec must be a plain object");
      const type = spec.type; if (!type || typeof type !== "string") throw new TypeError("emit: type is required");
      if (Object.prototype.hasOwnProperty.call(spec, "eventId")) throw new TypeError("emit: eventId override is rejected");
      if (Object.prototype.hasOwnProperty.call(spec, "taskId")) throw new TypeError("emit: taskId override is rejected");
      if (Object.prototype.hasOwnProperty.call(spec, "runId")) throw new TypeError("emit: runId override is rejected");
      if (Object.prototype.hasOwnProperty.call(spec, "sequence")) throw new TypeError("emit: sequence override is rejected");
      if (Object.prototype.hasOwnProperty.call(spec, "timestamp")) throw new TypeError("emit: timestamp override is rejected");
      if (type.startsWith("task.")) throw new TypeError("emit: task.* events are rejected");
      try {
        store.appendMany([me(this.#ids.eventId(), taskId, runId, store.latestSequence(taskId) + 1, this.#clock, { type, payload: spec.payload ?? {}, metadata: spec.metadata ?? {}, stepId: spec.stepId, agentId: spec.agentId, traceId: spec.traceId, causationId: spec.causationId, correlationId: spec.correlationId, idempotencyKey: spec.idempotencyKey })]);
      } catch (err) {
        emitInfrastructureError = err;
        throw err;
      }
    };

    try {
      const result = await Promise.race([this.#executor.execute({ taskId, runId, agentId, request: structuredClone(request), signal: ctrl.signal, emit }), tp]);
      clearTimeout(timer); settled = true;
      if (emitInfrastructureError) throw emitInfrastructureError;
      let validated;
      try { validated = validateAgentResult(result); } catch (err) { return this.#persistFailure(taskId, runId, agentId, sanitizeError(err)); }
      const f = store.latestSequence(taskId); const one = f + 1; const two = one + 1;
      if (validated.status === "completed" || validated.status === "blocked") {
        store.appendMany([me(this.#ids.eventId(), taskId, runId, one, this.#clock, { type: "agent.completed", payload: { result: validated }, agentId }), me(this.#ids.eventId(), taskId, runId, two, this.#clock, { type: `task.${validated.status}`, payload: dp(validated) })]);
      } else {
        store.appendMany([me(this.#ids.eventId(), taskId, runId, one, this.#clock, { type: "agent.failed", payload: { error: { name: "AgentFailedError", message: validated.summary || "failed" } }, agentId }), me(this.#ids.eventId(), taskId, runId, two, this.#clock, { type: "task.failed", payload: fp(validated) })]);
      }
    } catch (err) {
      clearTimeout(timer);
      if (settled || err === emitInfrastructureError) throw err; // infrastructure error — propagate
      settled = true;
      if (err instanceof SupervisorTimeoutError) {
        return this.#persistFailure(taskId, runId, agentId, { name: "SupervisorTimeoutError", message: err.message, code: "TASK_TIMEOUT" });
      }
      return this.#persistFailure(taskId, runId, agentId, sanitizeError(err));
    }
    return projectTaskStatus(this.#readAll(taskId));
  }

  #persistFailure(taskId, runId, agentId, failure) {
    const s = this.#eventStore; const f = s.latestSequence(taskId);
    s.appendMany([me(this.#ids.eventId(), taskId, runId, f + 1, this.#clock, { type: "agent.failed", payload: { error: failure }, agentId }), me(this.#ids.eventId(), taskId, runId, f + 2, this.#clock, { type: "task.failed", payload: { summary: failure.message, failure, artifacts: [], evidence: [], filesChanged: [], assumptions: [], unresolvedIssues: [] } })]);
    return projectTaskStatus(this.#readAll(taskId));
  }

  #getAgentId(evts) { const ag = evts.find(e => e.type === "agent.spawned"); return ag?.agentId || ag?.payload?.role || "unknown"; }
}

function dp(v) { return { summary: v.summary, artifacts: v.artifacts || [], evidence: v.evidence || [], filesChanged: v.filesChanged || [], assumptions: v.assumptions || [], unresolvedIssues: v.unresolvedIssues || [] }; }
function fp(v) { return { summary: v.summary || "failed", failure: { name: "AgentFailedError", message: v.summary || "failed" }, artifacts: v.artifacts || [], evidence: v.evidence || [], filesChanged: v.filesChanged || [], assumptions: v.assumptions || [], unresolvedIssues: v.unresolvedIssues || [] }; }
function me(eventId, taskId, runId, sequence, clock, spec) { return createHarnessEvent({ eventId, taskId, runId, type: spec.type, sequence, timestamp: clock(), payload: spec.payload ?? {}, metadata: spec.metadata ?? {}, stepId: spec.stepId, agentId: spec.agentId, traceId: spec.traceId, causationId: spec.causationId, correlationId: spec.correlationId, idempotencyKey: spec.idempotencyKey }); }
