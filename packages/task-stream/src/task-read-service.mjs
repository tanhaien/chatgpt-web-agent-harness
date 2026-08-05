import {
  validateTaskStatusRequest, validateTaskEventsRequest, validateTaskWaitRequest,
  validateTaskEventsResult, validateTaskWaitResult
} from "../../contracts/src/index.mjs";

function normalizeAbortError(reason) {
  if (reason && typeof reason === "object" && reason.name === "AbortError") return reason;
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw normalizeAbortError(signal.reason);
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const onAbort = () => { clearTimeout(id); reject(normalizeAbortError(signal?.reason)); };
    signal?.addEventListener("abort", onAbort, { once: true });
    const id = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  });
}

function paginateAll(store, taskId, after) {
  const all = [];
  let cursor = after;
  while (true) {
    const page = store.list({ taskId, afterSequence: cursor, limit: 1000 });
    if (page.length === 0) break;
    all.push(...page);
    cursor = page[page.length - 1].sequence;
  }
  return all;
}

function computeHasMore(store, taskId, events, limit) {
  if (events.length < limit) return false;
  const lastSeq = events[events.length - 1].sequence;
  return store.latestSequence(taskId) > lastSeq;
}

export class TaskReadService {
  #eventStore;
  #supervisor;
  #sleep;
  #pollMs;

  constructor(options) {
    if (!options || typeof options !== "object") throw new TypeError("options required");
    const es = options.eventStore;
    if (!es || typeof es.list !== "function" || typeof es.latestSequence !== "function") throw new TypeError("eventStore must have list, latestSequence");
    const sv = options.supervisor;
    if (!sv || typeof sv.status !== "function") throw new TypeError("supervisor must have status");
    this.#eventStore = es;
    this.#supervisor = sv;
    this.#pollMs = options.pollIntervalMs ?? 50;
    if (!Number.isInteger(this.#pollMs) || this.#pollMs < 1 || this.#pollMs > 5000) throw new TypeError("pollIntervalMs must be 1..5000");
    this.#sleep = options.sleep || defaultSleep;
  }

  status(input) {
    validateTaskStatusRequest(input);
    const st = this.#supervisor.status(input.taskId);
    return st ?? null;
  }

  events(input, opts = {}) {
    const req = { afterSequence: -1, limit: 100, waitMs: 0, ...input };
    validateTaskEventsRequest(req);
    const signal = opts.signal;
    throwIfAborted(signal);
    const events = this.#eventStore.list({ taskId: req.taskId, afterSequence: req.afterSequence, limit: req.limit });
    if (events.length > 0 || req.waitMs <= 0) {
      const hasMore = computeHasMore(this.#eventStore, req.taskId, events, req.limit);
      return validateTaskEventsResult({ taskId: req.taskId, events, nextSequence: events.length > 0 ? events[events.length - 1].sequence : req.afterSequence, hasMore });
    }
    return this.#eventsPollLoop(req, signal);
  }

  async #eventsPollLoop(req, signal) {
    const deadline = req.waitMs > 0 ? Date.now() + req.waitMs : 0;
    while (true) {
      throwIfAborted(signal);
      const events = this.#eventStore.list({ taskId: req.taskId, afterSequence: req.afterSequence, limit: req.limit });
      if (events.length > 0 || (deadline > 0 && Date.now() >= deadline)) {
        const hasMore = computeHasMore(this.#eventStore, req.taskId, events, req.limit);
        return validateTaskEventsResult({ taskId: req.taskId, events, nextSequence: events.length > 0 ? events[events.length - 1].sequence : req.afterSequence, hasMore });
      }
      const remaining = deadline > 0 ? Math.min(deadline - Date.now(), this.#pollMs) : this.#pollMs;
      if (remaining <= 0) {
        return validateTaskEventsResult({ taskId: req.taskId, events: [], nextSequence: req.afterSequence, hasMore: false });
      }
      await this.#sleep(remaining, signal);
    }
  }

  async wait(input, opts = {}) {
    const req = { timeoutMs: 300000, terminalStatuses: ["completed","blocked","failed","cancelled"], ...input };
    validateTaskWaitRequest(req);
    const signal = opts.signal;
    throwIfAborted(signal);
    const cursor = opts.afterSequence ?? -1;
    const deadline = req.timeoutMs > 0 ? Date.now() + req.timeoutMs : 0;

    const first = this.#supervisor.status(req.taskId);
    if (!first) return null;

    const isTerminal = (s) => ["completed","blocked","failed","cancelled"].includes(s.status);
    if (isTerminal(first)) {
      const all = paginateAll(this.#eventStore, req.taskId, cursor);
      return validateTaskWaitResult({
        taskId: req.taskId, status: first.status, terminal: true, timedOut: false,
        events: all, nextSequence: all.length > 0 ? all[all.length - 1].sequence : cursor
      });
    }

    if (req.timeoutMs === 0) {
      const events = paginateAll(this.#eventStore, req.taskId, cursor);
      return validateTaskWaitResult({
        taskId: req.taskId, status: first.status, terminal: false, timedOut: true,
        events, nextSequence: events.length > 0 ? events[events.length - 1].sequence : cursor
      });
    }

    while (true) {
      throwIfAborted(signal);
      const current = this.#supervisor.status(req.taskId);
      if (!current) return null;
      if (isTerminal(current)) {
        const all = paginateAll(this.#eventStore, req.taskId, cursor);
        return validateTaskWaitResult({
          taskId: req.taskId, status: current.status, terminal: true, timedOut: false,
          events: all, nextSequence: all.length > 0 ? all[all.length - 1].sequence : cursor
        });
      }
      if (deadline > 0 && Date.now() >= deadline) {
        const events = paginateAll(this.#eventStore, req.taskId, cursor);
        return validateTaskWaitResult({
          taskId: req.taskId, status: current.status, terminal: false, timedOut: true,
          events, nextSequence: events.length > 0 ? events[events.length - 1].sequence : cursor
        });
      }
      const remaining = deadline > 0 ? Math.min(deadline - Date.now(), this.#pollMs) : this.#pollMs;
      await this.#sleep(remaining, signal);
    }
  }
}
