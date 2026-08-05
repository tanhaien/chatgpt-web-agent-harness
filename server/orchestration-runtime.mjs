// Runtime composition for durable orchestration.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { openSqliteEventStore } from "../packages/event-store/src/index.mjs";
import { DelegationSupervisor } from "../packages/supervisor/src/index.mjs";
import { TaskReadService, streamTaskEvents } from "../packages/task-stream/src/index.mjs";

export class OrchestrationRuntimeClosedError extends Error {
  constructor(message = "Orchestration runtime is closed") {
    super(message);
    this.name = "OrchestrationRuntimeClosedError";
    this.code = "ORCHESTRATION_RUNTIME_CLOSED";
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function createOrchestrationRuntime(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  assertNonEmptyString(options.dbPath, "dbPath");
  if (!options.executor || typeof options.executor.execute !== "function") {
    throw new TypeError("executor must have an execute function");
  }
  if (options.onRunError !== undefined && typeof options.onRunError !== "function") {
    throw new TypeError("onRunError must be a function");
  }
  if (options.executorMode !== undefined) {
    assertNonEmptyString(options.executorMode, "executorMode");
  }
  if (options.workspaceId !== undefined) {
    assertNonEmptyString(options.workspaceId, "workspaceId");
  }

  const eventStore = openSqliteEventStore({ dbPath: options.dbPath });
  const supervisor = new DelegationSupervisor({
    eventStore,
    executor: options.executor,
    clock: options.clock,
    ids: options.ids
  });
  const taskReadService = new TaskReadService({
    eventStore,
    supervisor,
    pollIntervalMs: options.pollIntervalMs
  });
  const executorMode = options.executorMode || "custom";
  const workspaceId = options.workspaceId || null;
  const onRunError = options.onRunError || (() => {});
  const inFlight = new Map();
  let closed = false;
  let closing = null;

  function assertOpen() {
    if (closed) throw new OrchestrationRuntimeClosedError();
  }

  function delegate(request) {
    assertOpen();
    return supervisor.delegate(clone(request));
  }

  function start(taskId) {
    assertOpen();
    assertNonEmptyString(taskId, "taskId");
    const current = inFlight.get(taskId);
    if (current) return current;

    const runPromise = Promise.resolve().then(() => supervisor.run(taskId));
    const observed = runPromise.finally(() => {
      if (inFlight.get(taskId) === observed) inFlight.delete(taskId);
    });
    // Mark the rejection handled even when a caller intentionally starts a task
    // without awaiting it. The original promise still rejects for callers that do await.
    observed.catch((error) => {
      try {
        onRunError(error, taskId);
      } catch {
        // Runtime error reporting must never create a second unhandled rejection.
      }
    });
    inFlight.set(taskId, observed);
    return observed;
  }

  function status(input) {
    assertOpen();
    return taskReadService.status(clone(input));
  }

  function events(input, opts = {}) {
    assertOpen();
    return taskReadService.events(clone(input), opts);
  }

  function wait(input, opts = {}) {
    assertOpen();
    return taskReadService.wait(clone(input), opts);
  }

  function streamEvents(input, opts = {}) {
    assertOpen();
    return streamTaskEvents(taskReadService, clone(input), opts);
  }

  function snapshot() {
    return Object.freeze({
      enabled: !closed,
      closed,
      executorMode,
      workspaceId,
      inFlightRuns: inFlight.size
    });
  }

  async function close() {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      await Promise.allSettled([...inFlight.values()]);
      eventStore.close();
    })();
    return closing;
  }

  return Object.freeze({
    delegate,
    start,
    run: start,
    status,
    events,
    wait,
    streamEvents,
    snapshot,
    close
  });
}
