import { validateDelegateTaskRequest, validateTaskWaitResult } from "../../contracts/src/index.mjs";

export const DECISIONS = Object.freeze(["accept", "retry", "block"]);
const TERMINAL = new Set(["completed","blocked","failed","cancelled"]);

export class ControllerEvaluationError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "ControllerEvaluationError";
    if (cause) this.cause = cause;
  }
}

function normalizeAbortError(reason) {
  if (reason && typeof reason === "object" && reason.name === "AbortError") return reason;
  const err = new Error("Aborted"); err.name = "AbortError"; return err;
}

function deepClone(v) { return v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)); }

function defaultMakeIdempotencyKey({ rootTaskId, cycle, originalKey }) {
  return `${originalKey || rootTaskId}:cycle:${cycle}`;
}

function validateEvaluatorResult(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ControllerEvaluationError("evaluator result must be a plain object");
  if (!DECISIONS.includes(v.decision)) throw new ControllerEvaluationError("evaluator decision must be accept|retry|block");
  if (typeof v.reason !== "string" || v.reason.trim() === "") throw new ControllerEvaluationError("evaluator reason must be a non-empty string");
  if (v.nextGoal !== undefined && (typeof v.nextGoal !== "string" || v.nextGoal.trim() === "")) throw new ControllerEvaluationError("evaluator nextGoal must be a non-empty string");
  if (v.metadata !== undefined && (!v.metadata || typeof v.metadata !== "object" || Array.isArray(v.metadata))) throw new ControllerEvaluationError("evaluator metadata must be a plain object");
  return deepClone(v);
}

function safeEvalMessage(e) {
  if (e && typeof e.message === "string" && e.message.trim()) return e.message;
  if (e === null || e === undefined) return "unknown evaluator error";
  return String(e);
}

function assertDurableSnapshot(result, taskId) {
  if (!result) throw new ControllerEvaluationError(`task ${taskId} disappeared after run`);
  try { validateTaskWaitResult(result); } catch (e) { throw new ControllerEvaluationError(`task ${taskId} wait snapshot invalid: ${e.message}`); }
  if (result.taskId !== taskId) throw new ControllerEvaluationError(`wait result taskId ${result.taskId} mismatches expected ${taskId}`);
  if (result.terminal !== true) throw new ControllerEvaluationError(`task ${taskId} wait snapshot not terminal`);
  if (result.timedOut !== false) throw new ControllerEvaluationError(`task ${taskId} wait snapshot timed out`);
  if (!TERMINAL.has(result.status)) throw new ControllerEvaluationError(`task ${taskId} wait snapshot status ${result.status} not durable terminal`);
  return result;
}

function buildChildRequest(originalRequest, rootTaskId, idemKey, currentGoal) {
  return {
    goal: currentGoal, parentTaskId: rootTaskId,
    role: originalRequest.role,
    requiredCapabilities: originalRequest.requiredCapabilities || [],
    acceptanceCriteria: originalRequest.acceptanceCriteria,
    evidenceRequired: originalRequest.evidenceRequired || [],
    risk: originalRequest.risk,
    maxToolCalls: originalRequest.maxToolCalls,
    timeoutMs: originalRequest.timeoutMs,
    metadata: originalRequest.metadata,
    idempotencyKey: idemKey,
  };
}

export class LocalClosedLoopController {
  #supervisor; #taskReadService; #evaluator; #maxCycles; #clock; #makeIdempotencyKey;

  constructor(options) {
    if (!options || typeof options !== "object") throw new TypeError("options required");
    const sv = options.supervisor;
    if (!sv || typeof sv.delegate !== "function" || typeof sv.run !== "function") throw new TypeError("supervisor must have delegate and run");
    const trs = options.taskReadService;
    if (!trs || typeof trs.wait !== "function") throw new TypeError("taskReadService must have wait");
    const ev = options.evaluator;
    if (!ev || typeof ev.evaluate !== "function") throw new TypeError("evaluator must have evaluate");
    this.#supervisor = sv; this.#taskReadService = trs; this.#evaluator = ev;
    this.#maxCycles = options.maxCycles ?? 3;
    if (!Number.isInteger(this.#maxCycles) || this.#maxCycles < 1 || this.#maxCycles > 20) throw new TypeError("maxCycles must be 1..20");
    const clock = options.clock || (() => new Date().toISOString());
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    this.#clock = clock;
    const mk = options.makeIdempotencyKey || defaultMakeIdempotencyKey;
    if (typeof mk !== "function") throw new TypeError("makeIdempotencyKey must be a function");
    this.#makeIdempotencyKey = mk;
  }

  async execute(request, options = {}) {
    const signal = options.signal;
    if (signal?.aborted) throw normalizeAbortError(signal.reason);

    const originalRequest = deepClone(validateDelegateTaskRequest(request));
    const rootResp = this.#supervisor.delegate(originalRequest);
    const rootTaskId = rootResp.taskId;
    const cycles = [];
    const seenTaskIds = new Set([rootTaskId]);
    const seenKeys = new Set();
    if (originalRequest.idempotencyKey) seenKeys.add(originalRequest.idempotencyKey);
    let currentGoal = originalRequest.goal;
    let resultMetadata = {};

    for (let cycle = 1; cycle <= this.#maxCycles; cycle++) {
      if (signal?.aborted) throw normalizeAbortError(signal.reason);

      let taskId, runId, currentRequest;
      if (cycle === 1) {
        taskId = rootResp.taskId;
        runId = rootResp.runId;
        currentRequest = deepClone(originalRequest);
      } else {
        const idemKey = this.#makeIdempotencyKey({ rootTaskId, cycle, originalKey: originalRequest.idempotencyKey || "" });
        if (typeof idemKey !== "string" || idemKey.trim() === "") throw new ControllerEvaluationError(`makeIdempotencyKey returned invalid key for cycle ${cycle}`);
        if (seenKeys.has(idemKey)) throw new ControllerEvaluationError(`duplicate idempotency key ${idemKey} at cycle ${cycle}`);
        seenKeys.add(idemKey);
        currentRequest = buildChildRequest(originalRequest, rootTaskId, idemKey, currentGoal);
        const resp = this.#supervisor.delegate(currentRequest);
        taskId = resp.taskId;
        runId = resp.runId;
        if (seenTaskIds.has(taskId)) throw new ControllerEvaluationError(`child task ${taskId} at cycle ${cycle} reuses a prior taskId`);
        seenTaskIds.add(taskId);
      }

      if (signal?.aborted) throw normalizeAbortError(signal.reason);

      const startedAt = this.#clock();
      if (typeof startedAt !== "string" || isNaN(new Date(startedAt).getTime())) throw new ControllerEvaluationError("clock returned invalid ISO string for startedAt");

      await this.#supervisor.run(taskId);

      if (signal?.aborted) throw normalizeAbortError(signal.reason);

      const waitResult = assertDurableSnapshot(await this.#taskReadService.wait(
        { taskId, timeoutMs: 0 }, { afterSequence: -1, signal }
      ), taskId);

      const finishedAt = this.#clock();
      if (typeof finishedAt !== "string" || isNaN(new Date(finishedAt).getTime())) throw new ControllerEvaluationError("clock returned invalid ISO string for finishedAt");
      if (new Date(finishedAt).getTime() < new Date(startedAt).getTime()) throw new ControllerEvaluationError(`finishedAt ${finishedAt} < startedAt ${startedAt}`);

      const cycleRecord = {
        cycle, taskId, runId, taskStatus: waitResult.status, decision: null, reason: null,
        goal: currentGoal, eventCount: waitResult.events.length, nextSequence: waitResult.nextSequence,
        startedAt, finishedAt,
      };

      if (waitResult.status === "cancelled") {
        cycleRecord.decision = "cancelled"; cycleRecord.reason = "task was cancelled";
        cycles.push(cycleRecord);
        return freezeResult({ accepted: false, status: "cancelled", rootTaskId, finalTaskId: taskId, cycles, summary: "task was cancelled", metadata: {} });
      }

      if (signal?.aborted) throw normalizeAbortError(signal.reason);

      const context = {
        cycle, maxCycles: this.#maxCycles, rootTaskId, taskId, runId,
        originalRequest: deepClone(originalRequest),
        currentRequest: deepClone(currentRequest),
        status: deepClone(waitResult), events: deepClone(waitResult.events),
        priorCycles: deepClone(cycles),
      };

      let evalResult;
      try {
        evalResult = validateEvaluatorResult(await this.#evaluator.evaluate(context));
      } catch (e) {
        if (e && typeof e === "object" && (e.name === "AbortError" || e.name === "ControllerEvaluationError")) throw e;
        throw new ControllerEvaluationError(`evaluator threw: ${safeEvalMessage(e)}`, (e && typeof e === "object") ? e : undefined);
      }
      if (signal?.aborted) throw normalizeAbortError(signal.reason);

      if (evalResult.decision === "accept") {
        if (waitResult.status !== "completed") throw new ControllerEvaluationError("accept decision only valid for completed durable status");
        cycleRecord.decision = "accept"; cycleRecord.reason = evalResult.reason;
        cycles.push(cycleRecord);
        return freezeResult({ accepted: true, status: "completed", rootTaskId, finalTaskId: taskId, cycles, summary: evalResult.reason, metadata: deepClone(evalResult.metadata) || {} });
      }

      if (evalResult.decision === "block") {
        if (!["completed","blocked","failed"].includes(waitResult.status)) throw new ControllerEvaluationError(`block decision incompatible with ${waitResult.status}`);
        cycleRecord.decision = "block"; cycleRecord.reason = evalResult.reason;
        cycles.push(cycleRecord);
        return freezeResult({ accepted: false, status: "blocked", rootTaskId, finalTaskId: taskId, cycles, summary: evalResult.reason, metadata: deepClone(evalResult.metadata) || {} });
      }

      cycleRecord.decision = "retry"; cycleRecord.reason = evalResult.reason;
      if (evalResult.nextGoal) currentGoal = evalResult.nextGoal;
      resultMetadata = deepClone(evalResult.metadata) || {};
      cycles.push(cycleRecord);
    }

    return freezeResult({ accepted: false, status: "exhausted", rootTaskId, finalTaskId: cycles[cycles.length - 1].taskId, cycles, summary: `maxCycles ${this.#maxCycles} reached`, metadata: resultMetadata });
  }
}

function freezeResult(r) {
  r.cycles = deepClone(r.cycles); Object.freeze(r.cycles);
  r.cycles.forEach(c => Object.freeze(c));
  r.metadata = deepClone(r.metadata) || {};
  return Object.freeze(r);
}
