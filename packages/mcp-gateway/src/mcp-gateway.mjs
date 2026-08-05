import {
  RISK_LEVELS,
  PROVIDER_TRUST_LEVELS,
  PROVIDER_HEALTH,
  validateProviderDefinition,
  validateCanonicalTool,
  validateCallContext,
  validateToolCallResult,
  assertObject,
  assertString
} from "../../contracts/src/index.mjs";

// ── Circuit breaker states ──────────────────────────────────────
export const CIRCUIT_STATES = Object.freeze(["closed", "open", "half-open"]);

// ── Error classes ───────────────────────────────────────────────
export class GatewayRegistrationError extends Error {
  constructor(message) {
    super(message);
    this.name = "GatewayRegistrationError";
  }
}

export class GatewayResolutionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "GatewayResolutionError";
    this.code = code;
  }
}

export class GatewayBusyError extends Error {
  constructor(message) {
    super(message);
    this.name = "GatewayBusyError";
  }
}

export class GatewayClosedError extends Error {
  constructor(message) {
    super(message);
    this.name = "GatewayClosedError";
  }
}

// ── Internal deadline tag ───────────────────────────────────────
function createDeadlineError() {
  const err = new DOMException("timeout", "AbortError");
  err.__gatewayDeadline = true;
  return err;
}

function isGatewayDeadline(err) {
  return err && err.__gatewayDeadline === true;
}

// ── Helpers ─────────────────────────────────────────────────────

function assertIntInRange(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  }
}

function assertNonEmptyArray(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty array`);
  }
}

function assertCallback(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }
}

function deepClone(value) {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

function cloneProviderSnapshot(entry) {
  return {
    definition: deepClone(entry.definition),
    health: entry.health,
    circuit: entry.circuit,
    active: entry.active,
    queued: entry.queue.length,
    toolCount: entry.tools.length,
    totalCalls: entry.totalCalls,
    totalSuccesses: entry.totalSuccesses,
    totalFailures: entry.totalFailures,
    consecutiveFailures: entry.consecutiveFailures,
    lastStartedAt: entry.lastStartedAt,
    lastFinishedAt: entry.lastFinishedAt,
    openedAt: entry.openedAt,
    cooldownMs: entry.cooldownMs,
    maxConcurrency: entry.maxConcurrency,
    timeoutMs: entry.timeoutMs
  };
}

function cloneHealthSnapshot(entry) {
  if (!entry) return null;
  return {
    health: entry.health,
    circuit: entry.circuit,
    active: entry.active,
    queued: entry.queue.length,
    totalCalls: entry.totalCalls,
    totalSuccesses: entry.totalSuccesses,
    totalFailures: entry.totalFailures,
    consecutiveFailures: entry.consecutiveFailures,
    lastStartedAt: entry.lastStartedAt,
    lastFinishedAt: entry.lastFinishedAt,
    openedAt: entry.openedAt,
    cooldownMs: entry.cooldownMs,
    maxConcurrency: entry.maxConcurrency,
    timeoutMs: entry.timeoutMs,
    lastError: entry.lastError ? { name: entry.lastError.name, message: entry.lastError.message, code: entry.lastError.code } : null
  };
}

function sanitizeError(err) {
  if (!(err instanceof Error)) {
    return { name: "Error", message: String(err) };
  }
  const sanitized = { name: err.name, message: err.message };
  if (err.code && typeof err.code === "string") sanitized.code = err.code;
  return sanitized;
}

function normalizeAbortReason(reason) {
  if (reason instanceof Error) return reason;
  if (reason === undefined || reason === null) return new DOMException("The operation was aborted", "AbortError");
  const err = new Error(typeof reason === "string" ? reason : "The operation was aborted");
  err.name = "AbortError";
  return err;
}

function isAbortError(err) {
  return err && (err.name === "AbortError" || err instanceof DOMException);
}

// ── Risk ordering helper ────────────────────────────────────────
const RISK_ORDER = { "read": 0, "safe-write": 1, "risky": 2, "critical": 3 };

function riskIndex(risk) {
  return RISK_ORDER[risk] ?? 999;
}

// ── Trust ordering helper ───────────────────────────────────────
const TRUST_ORDER = { "trusted-local": 0, "sandboxed": 1, "external": 2 };

function trustIndex(trust) {
  return TRUST_ORDER[trust] ?? 999;
}

// ── Health ordering helper ──────────────────────────────────────
const HEALTH_ORDER = { "healthy": 0, "unknown": 1, "degraded": 2 };

function healthIndex(health) {
  return HEALTH_ORDER[health] ?? 999;
}

function healthRank(entry, nowMs) {
  let circuit = entry.circuit;
  const now = nowMs();

  if (circuit === "open" && entry.openedAt !== null) {
    if (now - entry.openedAt >= entry.cooldownMs) {
      circuit = "half-open";
    }
  }

  if (circuit === "open") return 999;
  if (circuit === "half-open" && entry._halfOpenProbe !== null) return 998;
  return healthIndex(entry.health);
}

function assertNowMs(fn) {
  const v = fn();
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
    throw new TypeError("nowMs() must return a finite non-negative integer");
  }
  return v;
}

function assertNowIso(fn) {
  const v = fn();
  if (typeof v !== "string" || isNaN(new Date(v).getTime())) {
    throw new TypeError("nowIso() must return a valid ISO string");
  }
  return v;
}

// ── Provider entry factory ──────────────────────────────────────
function createProviderEntry(definition, tools, client, maxConcurrency, timeoutMs, gatewayDefaults) {
  return {
    definition: deepClone(definition),
    tools: tools.map(t => deepClone(t)),
    client,
    maxConcurrency,
    timeoutMs,
    cooldownMs: gatewayDefaults.cooldownMs,
    failureThreshold: gatewayDefaults.failureThreshold,
    health: "unknown",
    circuit: "closed",
    active: 0,
    queue: [],
    totalCalls: 0,
    totalSuccesses: 0,
    totalFailures: 0,
    consecutiveFailures: 0,
    openedAt: null,
    lastError: null,
    lastStartedAt: null,
    lastFinishedAt: null,
    _halfOpenProbe: null
  };
}

// ── MultiMcpGateway ─────────────────────────────────────────────

export class MultiMcpGateway {
  constructor(options = {}) {
    assertObject(options, "gatewayOptions");

    this._defaultTimeoutMs = options.defaultTimeoutMs ?? 30000;
    assertIntInRange(this._defaultTimeoutMs, 1, 300000, "defaultTimeoutMs");

    this._failureThreshold = options.failureThreshold ?? 3;
    assertIntInRange(this._failureThreshold, 1, 100, "failureThreshold");

    this._cooldownMs = options.cooldownMs ?? 30000;
    assertIntInRange(this._cooldownMs, 1, 3600000, "cooldownMs");

    this._nowMsFn = options.nowMs ?? Date.now;
    assertCallback(this._nowMsFn, "nowMs");

    this._nowIsoFn = options.nowIso ?? (() => new Date().toISOString());
    assertCallback(this._nowIsoFn, "nowIso");

    // Validate callback outputs at construction
    assertNowMs(this._nowMsFn);
    assertNowIso(this._nowIsoFn);

    this._providers = new Map();
    this._closed = false;
  }

  // ── Provider Registration ─────────────────────────────────────

  registerProvider({ definition, tools, client, maxConcurrency = 4, timeoutMs }) {
    if (this._closed) throw new GatewayClosedError("gateway is closed");

    let def = validateProviderDefinition(definition);
    def = deepClone(def);

    assertNonEmptyArray(tools, "tools");
    const validatedTools = [];
    const seenSourceNames = new Set();

    for (const t of tools) {
      let vt = validateCanonicalTool(t);
      if (vt.providerId !== def.id) {
        throw new GatewayRegistrationError(
          `tool ${vt.id} has providerId "${vt.providerId}" but expected "${def.id}"`
        );
      }
      vt = deepClone(vt);
      validatedTools.push(vt);

      if (seenSourceNames.has(vt.sourceName)) {
        throw new GatewayRegistrationError(
          `duplicate sourceName "${vt.sourceName}" within provider "${def.id}"`
        );
      }
      seenSourceNames.add(vt.sourceName);
    }

    let clientObj = assertObject(client, "client");
    if (typeof clientObj.invoke !== "function") {
      throw new GatewayRegistrationError("client.invoke must be a function");
    }

    assertIntInRange(maxConcurrency, 1, 1000, "maxConcurrency");

    if (timeoutMs !== undefined) {
      assertIntInRange(timeoutMs, 1, 300000, "timeoutMs");
    }

    for (const t of validatedTools) {
      const existing = this._findToolById(t.id);
      if (existing) {
        throw new GatewayRegistrationError(
          `duplicate canonical tool ID "${t.id}" already registered by provider "${existing.providerId}"`
        );
      }
    }

    if (this._providers.has(def.id)) {
      throw new GatewayRegistrationError(`provider "${def.id}" is already registered`);
    }

    const entry = createProviderEntry(def, validatedTools, client, maxConcurrency, timeoutMs, {
      cooldownMs: this._cooldownMs,
      failureThreshold: this._failureThreshold
    });

    this._providers.set(def.id, entry);
    return cloneProviderSnapshot(entry);
  }

  // ── Unregister ────────────────────────────────────────────────

  unregisterProvider(providerId) {
    assertString(providerId, "providerId");
    if (this._closed) throw new GatewayClosedError("gateway is closed");

    const entry = this._providers.get(providerId);
    if (!entry) return false;

    if (entry.active > 0 || entry.queue.length > 0) {
      throw new GatewayBusyError(
        `cannot unregister provider "${providerId}" while ${entry.active} active calls and ${entry.queue.length} queued waiters exist`
      );
    }

    this._providers.delete(providerId);
    return true;
  }

  // ── Read APIs ─────────────────────────────────────────────────

  listProviders() {
    if (this._closed) throw new GatewayClosedError("gateway is closed");
    const ids = [...this._providers.keys()].sort();
    return ids.map(id => {
      const entry = this._providers.get(id);
      return cloneProviderSnapshot(entry);
    });
  }

  listTools(filter = {}) {
    if (this._closed) throw new GatewayClosedError("gateway is closed");
    assertObject(filter, "filter");

    if (filter.providerId !== undefined) assertString(filter.providerId, "filter.providerId");

    if (filter.allowedTrustLevels !== undefined) {
      if (!Array.isArray(filter.allowedTrustLevels) || filter.allowedTrustLevels.length === 0) {
        throw new TypeError("allowedTrustLevels must be a non-empty array");
      }
      const unique = new Set(filter.allowedTrustLevels);
      if (unique.size !== filter.allowedTrustLevels.length) {
        throw new TypeError("allowedTrustLevels must contain unique values");
      }
      for (const lvl of filter.allowedTrustLevels) {
        if (!PROVIDER_TRUST_LEVELS.includes(lvl)) {
          throw new TypeError(`allowedTrustLevels must be one of: ${PROVIDER_TRUST_LEVELS.join(", ")}`);
        }
      }
    }

    if (filter.requiredCapabilities !== undefined) {
      if (!Array.isArray(filter.requiredCapabilities)) {
        throw new TypeError("requiredCapabilities must be an array");
      }
      for (const cap of filter.requiredCapabilities) {
        if (typeof cap !== "string" || cap.trim() === "") {
          throw new TypeError("requiredCapabilities must contain non-empty strings");
        }
      }
    }

    if (filter.maxRisk !== undefined) {
      if (!RISK_LEVELS.includes(filter.maxRisk)) {
        throw new TypeError(`maxRisk must be one of: ${RISK_LEVELS.join(", ")}`);
      }
    }

    if (filter.includeDegraded !== undefined && typeof filter.includeDegraded !== "boolean") {
      throw new TypeError("includeDegraded must be a boolean");
    }

    let tools = [];
    for (const [, entry] of this._providers) {
      if (filter.providerId !== undefined && entry.definition.id !== filter.providerId) continue;

      if (filter.allowedTrustLevels && !filter.allowedTrustLevels.includes(entry.definition.trustLevel)) continue;
      if (filter.includeDegraded === false && entry.health === "degraded") continue;

      for (const tool of entry.tools) {
        if (filter.requiredCapabilities) {
          const hasAll = filter.requiredCapabilities.every(cap => tool.capabilities.includes(cap));
          if (!hasAll) continue;
        }

        if (filter.maxRisk !== undefined && riskIndex(tool.risk) > riskIndex(filter.maxRisk)) continue;

        tools.push({
          ...deepClone(tool),
          providerTrustLevel: entry.definition.trustLevel,
          providerHealth: entry.health,
          providerCircuit: this._effectiveCircuit(entry)
        });
      }
    }

    tools.sort((a, b) => a.id.localeCompare(b.id));
    return tools;
  }

  getProviderHealth(providerId) {
    if (this._closed) throw new GatewayClosedError("gateway is closed");
    const entry = this._providers.get(providerId);
    return cloneHealthSnapshot(entry);
  }

  // ── Close ─────────────────────────────────────────────────────

  close() {
    if (this._closed) return;
    this._closed = true;

    for (const [, entry] of this._providers) {
      for (const waiter of entry.queue) {
        try { waiter.reject(new GatewayClosedError("gateway closed")); } catch (_) { /* ignore */ }
      }
      entry.queue.length = 0;
      // _halfOpenProbe release — any queued/active probes get cleaned up
      entry._halfOpenProbe = null;
    }
  }

  // ── Resolution ────────────────────────────────────────────────

  resolveTool(request) {
    if (this._closed) throw new GatewayClosedError("gateway is closed");
    assertObject(request, "request");

    const hasToolId = request.toolId !== undefined;
    const hasSourceName = request.sourceName !== undefined;

    if (hasToolId && hasSourceName) {
      throw new TypeError("request must have either toolId or sourceName, not both");
    }
    if (!hasToolId && !hasSourceName) {
      throw new TypeError("request must have either toolId or sourceName");
    }

    if (request.toolId !== undefined) assertString(request.toolId, "toolId");
    if (request.sourceName !== undefined) assertString(request.sourceName, "sourceName");

    const providerId = request.providerId;
    if (providerId !== undefined) assertString(providerId, "providerId");

    if (request.requiredCapabilities !== undefined) {
      if (!Array.isArray(request.requiredCapabilities)) {
        throw new TypeError("requiredCapabilities must be an array");
      }
      for (const cap of request.requiredCapabilities) {
        if (typeof cap !== "string" || cap.trim() === "") {
          throw new TypeError("requiredCapabilities must contain non-empty strings");
        }
      }
    }

    if (request.maxRisk !== undefined) {
      if (!RISK_LEVELS.includes(request.maxRisk)) {
        throw new TypeError(`maxRisk must be one of: ${RISK_LEVELS.join(", ")}`);
      }
    }

    if (request.allowedTrustLevels !== undefined) {
      if (!Array.isArray(request.allowedTrustLevels) || request.allowedTrustLevels.length === 0) {
        throw new TypeError("allowedTrustLevels must be a non-empty array");
      }
      const unique = new Set(request.allowedTrustLevels);
      if (unique.size !== request.allowedTrustLevels.length) {
        throw new TypeError("allowedTrustLevels must contain unique values");
      }
      for (const level of request.allowedTrustLevels) {
        if (!PROVIDER_TRUST_LEVELS.includes(level)) {
          throw new TypeError(`allowedTrustLevels must be one of: ${PROVIDER_TRUST_LEVELS.join(", ")}`);
        }
      }
    }

    const includeDegraded = request.includeDegraded !== false;

    // First check: does the tool exist at all in the registry?
    let exists = false;
    let toolExistsButExcluded = false;

    if (hasToolId) {
      for (const [, entry] of this._providers) {
        for (const tool of entry.tools) {
          if (tool.id === request.toolId) { exists = true; break; }
        }
        if (exists) break;
      }
      // Check explicit toolId + providerId disagreement
      if (exists && providerId !== undefined) {
        const prefix = request.toolId.split("/")[0];
        if (prefix !== providerId) {
          throw new GatewayResolutionError(
            `toolId "${request.toolId}" does not belong to provider "${providerId}"`,
            "TOOL_NOT_FOUND"
          );
        }
      }
    } else {
      // sourceName: check existence across all providers
      for (const [, entry] of this._providers) {
        for (const tool of entry.tools) {
          if (tool.sourceName === request.sourceName) { exists = true; break; }
        }
        if (exists) break;
      }
    }

    // Build candidates
    const candidates = [];
    const nowMs = this._nowMsFn;

    for (const [, entry] of this._providers) {
      if (providerId !== undefined && entry.definition.id !== providerId) continue;

      if (hasToolId) {
        if (request.toolId.startsWith(entry.definition.id + "/")) {
          if (providerId !== undefined && entry.definition.id !== providerId) continue;
        }
      }

      if (request.allowedTrustLevels && !request.allowedTrustLevels.includes(entry.definition.trustLevel)) continue;

      const effCircuit = this._effectiveCircuit(entry);
      if (effCircuit === "open") continue;
      // half-open providers with active probes stay eligible — invoke rejects with GatewayBusyError

      if (!includeDegraded && entry.health === "degraded") continue;

      let matched = false;
      for (const tool of entry.tools) {
        let match = false;
        if (hasToolId) {
          if (tool.id === request.toolId) match = true;
        } else {
          if (tool.sourceName === request.sourceName) match = true;
        }
        if (!match) continue;

        if (request.requiredCapabilities) {
          const hasAll = request.requiredCapabilities.every(cap => tool.capabilities.includes(cap));
          if (!hasAll) continue;
        }

        if (request.maxRisk !== undefined && riskIndex(tool.risk) > riskIndex(request.maxRisk)) continue;

        candidates.push({ entry, tool });
        matched = true;
      }
      if (matched) exists = true;
    }

    if (candidates.length === 0) {
      if (!exists) {
        const code = "TOOL_NOT_FOUND";
        throw new GatewayResolutionError("tool not found in registry", code);
      }
      throw new GatewayResolutionError("no eligible provider", "NO_ELIGIBLE_PROVIDER");
    }

    // Deterministic ranking
    candidates.sort((a, b) => {
      const ha = healthRank(a.entry, nowMs);
      const hb = healthRank(b.entry, nowMs);
      if (ha !== hb) return ha - hb;

      const ta = trustIndex(a.entry.definition.trustLevel);
      const tb = trustIndex(b.entry.definition.trustLevel);
      if (ta !== tb) return ta - tb;

      const ra = riskIndex(a.tool.risk);
      const rb = riskIndex(b.tool.risk);
      if (ra !== rb) return ra - rb;

      return a.tool.id.localeCompare(b.tool.id);
    });

    const winner = candidates[0];
    let reason = "health";
    if (candidates.length > 1) {
      const second = candidates[1];
      if (healthRank(winner.entry, nowMs) !== healthRank(second.entry, nowMs)) {
        reason = "health";
      } else if (trustIndex(winner.entry.definition.trustLevel) !== trustIndex(second.entry.definition.trustLevel)) {
        reason = "trust";
      } else if (riskIndex(winner.tool.risk) !== riskIndex(second.tool.risk)) {
        reason = "risk";
      } else {
        reason = "id";
      }
    }

    return {
      provider: deepClone(winner.entry.definition),
      tool: deepClone(winner.tool),
      reason
    };
  }

  // ── Invocation ────────────────────────────────────────────────

  async invoke(request, options = {}) {
    if (this._closed) throw new GatewayClosedError("gateway is closed");
    assertObject(request, "request");
    assertObject(options, "options");

    const signal = options.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw new TypeError("options.signal must be an AbortSignal");
    }

    if (signal?.aborted) throw normalizeAbortReason(signal.reason);

    assertObject(request.input, "input");
    const inputClone = deepClone(request.input);

    let timeoutMs = request.timeoutMs;
    if (timeoutMs !== undefined) assertIntInRange(timeoutMs, 1, 300000, "timeoutMs");

    // Context
    let context = request.context ?? {};
    assertObject(context, "context");
    context = deepClone(context);

    // Resolve candidate
    const { provider: resolvedProvider, tool: resolvedTool } = this.resolveTool(request);
    const entry = this._providers.get(resolvedProvider.id);

    // Determine final timeout
    const effectiveTimeoutMs = timeoutMs ?? entry.timeoutMs ?? this._defaultTimeoutMs;

    // Context integrity: reject conflicting fields
    if (context.providerId !== undefined && context.providerId !== resolvedProvider.id) {
      throw new TypeError(`context.providerId "${context.providerId}" conflicts with resolved provider "${resolvedProvider.id}"`);
    }
    if (context.toolId !== undefined && context.toolId !== resolvedTool.id) {
      throw new TypeError(`context.toolId "${context.toolId}" conflicts with resolved tool "${resolvedTool.id}"`);
    }
    if (context.attempt !== undefined) {
      if (!Number.isInteger(context.attempt) || context.attempt < 1) {
        throw new TypeError("context.attempt must be a positive integer");
      }
    }

    // Assign gateway-owned fields
    context.traceId = context.traceId ?? "trace-" + assertNowMs(this._nowMsFn);
    context.providerId = resolvedProvider.id;
    context.toolId = resolvedTool.id;
    if (context.attempt === undefined) context.attempt = 1;
    context.metadata = context.metadata ?? {};

    if (request.idempotencyKey !== undefined) {
      assertString(request.idempotencyKey, "idempotencyKey");
      context.idempotencyKey = request.idempotencyKey;
    }

    validateCallContext(context);

    // Half-open probe reservation (before acquiring permit)
    let probeReserved = false;
    if (this._effectiveCircuit(entry) === "half-open") {
      if (entry._halfOpenProbe !== null) {
        throw new GatewayBusyError("provider is in half-open state and a probe is already active");
      }
      entry._halfOpenProbe = { startMs: assertNowMs(this._nowMsFn) };
      probeReserved = true;
    }

    // ── Deadline / abort wiring ──────────────────────────────────
    const deadlineController = new AbortController();
    const deadlineTimer = setTimeout(() => {
      deadlineController.abort(createDeadlineError());
    }, effectiveTimeoutMs);

    const composedSignal = deadlineController.signal;
    let externalAbortListener = null;

    if (signal) {
      const onAbort = () => {
        clearTimeout(deadlineTimer);
        deadlineController.abort(signal.reason);
      };
      if (signal.aborted) {
        clearTimeout(deadlineTimer);
        deadlineController.abort(signal.reason);
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
        externalAbortListener = { signal, handler: onAbort };
      }
    }

    const cleanupTimersListeners = () => {
      clearTimeout(deadlineTimer);
      if (externalAbortListener) {
        externalAbortListener.signal.removeEventListener("abort", externalAbortListener.handler);
        externalAbortListener = null;
      }
    };

    // Validate clock callbacks at use boundary
    const startedAt = assertNowIso(this._nowIsoFn);
    const startedAtMs = assertNowMs(this._nowMsFn);
    entry.lastStartedAt = startedAt;

    // ── Acquire permit (handles queue wait + deadline + external abort) ──
    let release;
    try {
      release = await this._acquirePermit(entry, composedSignal, deadlineController, externalAbortListener);
    } catch (err) {
      cleanupTimersListeners();
      const abortErr = normalizeAbortReason(err);
      if (isGatewayDeadline(err) || isGatewayDeadline(abortErr)) {
        // Timeout while queued — no client call happened
        if (probeReserved) entry._halfOpenProbe = null;
        const finishedAt = assertNowIso(this._nowIsoFn);
        const result = this._buildResult({
          ok: false,
          providerId: resolvedProvider.id,
          toolId: resolvedTool.id,
          startedAt,
          finishedAt,
          durationMs: assertNowMs(this._nowMsFn) - startedAtMs,
          error: { name: "GatewayTimeoutError", message: "provider timed out", code: "PROVIDER_TIMEOUT" },
          retryable: true,
          idempotencyKey: context.idempotencyKey
        });
        validateToolCallResult(result);
        return result;
      }
      // External abort while queued
      if (probeReserved) entry._halfOpenProbe = null;
      throw abortErr;
    }
    // release is now a function that releases the permit

    // ── Invoke client ────────────────────────────────────────────
    try {
      let clientResult;
      try {
        // Race client invocation against composed signal abort
        const abortPromise = new Promise((_, reject) => {
          if (composedSignal.aborted) {
            reject(normalizeAbortReason(composedSignal.reason));
          } else {
            const onComposedAbort = () => {
              composedSignal.removeEventListener("abort", onComposedAbort);
              reject(normalizeAbortReason(composedSignal.reason));
            };
            composedSignal.addEventListener("abort", onComposedAbort, { once: true });
          }
        });

        clientResult = await Promise.race([
          entry.client.invoke({
            tool: deepClone(resolvedTool),
            input: inputClone,
            context: deepClone(context),
            signal: composedSignal
          }),
          abortPromise
        ]);
        // Client resolved first — success
        cleanupTimersListeners();
      } catch (err) {
        cleanupTimersListeners();
        const abortErr = normalizeAbortReason(err);

        if (isAbortError(abortErr)) {
          // Distinguish deadline from external abort
          if (isGatewayDeadline(err) || isGatewayDeadline(abortErr)) {
            // Timeout during client invocation
            release();
            this._recordFailure(entry, { name: "GatewayTimeoutError", message: "provider timed out", code: "PROVIDER_TIMEOUT" });
            if (probeReserved) {
              this._updateCircuitAfterFailure(entry);
            }
            const finishedAt = assertNowIso(this._nowIsoFn);
            const result = this._buildResult({
              ok: false,
              providerId: resolvedProvider.id,
              toolId: resolvedTool.id,
              startedAt,
              finishedAt,
              durationMs: assertNowMs(this._nowMsFn) - startedAtMs,
              error: { name: "GatewayTimeoutError", message: "provider timed out", code: "PROVIDER_TIMEOUT" },
              retryable: true,
              idempotencyKey: context.idempotencyKey
            });
            validateToolCallResult(result);
            return result;
          }
          // External abort during invocation
          release();
          if (probeReserved) entry._halfOpenProbe = null;
          throw abortErr;
        }

        // Client error (non-abort)
        release();
        this._recordFailure(entry, sanitizeError(err));
        if (probeReserved) {
          this._updateCircuitAfterFailure(entry);
        }
        const finishedAt = assertNowIso(this._nowIsoFn);
        const result = this._buildResult({
          ok: false,
          providerId: resolvedProvider.id,
          toolId: resolvedTool.id,
          startedAt,
          finishedAt,
          durationMs: assertNowMs(this._nowMsFn) - startedAtMs,
          error: sanitizeError(err),
          retryable: false,
          idempotencyKey: context.idempotencyKey
        });
        validateToolCallResult(result);
        return result;
      }

      // ── Success path ───────────────────────────────────────────
      const finishedAt = assertNowIso(this._nowIsoFn);
      const finishedAtMs = assertNowMs(this._nowMsFn);
      const durationMs = finishedAtMs - startedAtMs;

      const result = {
        ok: true,
        providerId: resolvedProvider.id,
        toolId: resolvedTool.id,
        startedAt,
        finishedAt,
        durationMs,
        artifacts: [],
        retryable: false,
        idempotencyKey: context.idempotencyKey
      };

      if (clientResult && typeof clientResult === "object" && !Array.isArray(clientResult)) {
        if ("output" in clientResult) {
          result.output = deepClone(clientResult.output);
          if (clientResult.artifacts !== undefined) result.artifacts = deepClone(clientResult.artifacts);
          if (clientResult.retryable !== undefined) result.retryable = Boolean(clientResult.retryable);
        } else {
          result.output = deepClone(clientResult);
        }
      } else {
        result.output = deepClone(clientResult);
      }

      validateToolCallResult(result);

      // Record success — close circuit
      entry.totalSuccesses++;
      entry.consecutiveFailures = 0;
      entry.circuit = "closed";
      entry.health = "healthy";
      entry.openedAt = null;
      entry._halfOpenProbe = null;
      entry.lastFinishedAt = finishedAt;

      release();
      return result;
    } finally {
      // Always attempt cleanup. release is idempotent.
      release();
    }
  }

  // ── Private helpers ───────────────────────────────────────────

  _acquirePermit(entry, signal, deadlineController, externalAbortListener) {
    const makeRelease = () => {
      let called = false;
      return () => {
        if (called) return;
        called = true;
        entry.active--;
        this._dequeueNext(entry);
      };
    };

    let release;  // defined in immediate-permit path and set before `finalize(release)`
    return new Promise((resolve, reject) => {
      let settled = false;

      const finalize = (errOrRelease) => {
        if (settled) return;
        settled = true;
        if (signal && onAbortHandler) {
          signal.removeEventListener("abort", onAbortHandler);
          onAbortHandler = null;
        }
        if (typeof errOrRelease === "function") {
          resolve(errOrRelease);
        } else {
          reject(errOrRelease);
        }
      };

      // Attach abort listener to signal
      let onAbortHandler = null;
      if (signal) {
        onAbortHandler = () => {
          // Remove waiter from queue if queued
          if (waiter && entry.queue.includes(waiter)) {
            const idx = entry.queue.indexOf(waiter);
            if (idx >= 0) entry.queue.splice(idx, 1);
          }
          finalize(normalizeAbortReason(signal.reason));
        };
        if (signal.aborted) {
          onAbortHandler();
          return;
        }
        signal.addEventListener("abort", onAbortHandler, { once: true });
      }

      let waiter = null;

      if (entry.active < entry.maxConcurrency) {
        // Immediate permit
        entry.active++;
        entry.totalCalls++;
        release = makeRelease();
        finalize(release);
        return;
      }

      // Queue
      waiter = {};
      entry.queue.push(waiter);

      const onDequeue = (release) => {
        finalize(release);
      };

      const onReject = (err) => {
        const idx = entry.queue.indexOf(waiter);
        if (idx >= 0) entry.queue.splice(idx, 1);
        finalize(err);
      };

      waiter.resolve = onDequeue;
      waiter.reject = onReject;
    });
  }

  _dequeueNext(entry) {
    while (entry.queue.length > 0 && entry.active < entry.maxConcurrency) {
      const waiter = entry.queue.shift();
      if (!waiter || !waiter.resolve) continue;
      entry.active++;
      entry.totalCalls++;
      let called = false;
      const release = () => {
        if (called) return;
        called = true;
        entry.active--;
        this._dequeueNext(entry);
      };
      try {
        waiter.resolve(release);
      } catch (_) {
        entry.active--;
      }
    }
  }

  _effectiveCircuit(entry) {
    if (entry.circuit === "open" && entry.openedAt !== null) {
      if (assertNowMs(this._nowMsFn) - entry.openedAt >= entry.cooldownMs) {
        return "half-open";
      }
    }
    return entry.circuit;
  }

  _updateCircuitAfterFailure(entry) {
    if (entry.consecutiveFailures >= entry.failureThreshold) {
      entry.circuit = "open";
      entry.health = "offline";
      entry.openedAt = assertNowMs(this._nowMsFn);
      entry._halfOpenProbe = null;
    } else {
      entry.health = "degraded";
    }
  }

  _recordFailure(entry, err) {
    entry.totalFailures++;
    entry.consecutiveFailures = (entry.consecutiveFailures ?? 0) + 1;
    entry.lastError = err;
    entry.lastFinishedAt = assertNowIso(this._nowIsoFn);
    if (entry._halfOpenProbe === null) {
      this._updateCircuitAfterFailure(entry);
    }
  }

  _findToolById(canonicalId) {
    for (const [, entry] of this._providers) {
      for (const tool of entry.tools) {
        if (tool.id === canonicalId) {
          return { providerId: entry.definition.id };
        }
      }
    }
    return null;
  }

  _buildResult(raw) {
    const r = {
      ok: raw.ok,
      providerId: raw.providerId,
      toolId: raw.toolId,
      startedAt: raw.startedAt,
      finishedAt: raw.finishedAt,
      durationMs: raw.durationMs,
      artifacts: raw.artifacts ?? [],
      retryable: raw.retryable ?? false
    };
    if (raw.ok) {
      r.output = raw.output;
    } else {
      r.error = raw.error;
    }
    if (raw.idempotencyKey !== undefined) r.idempotencyKey = raw.idempotencyKey;
    return r;
  }
}
