// Real OpenCode HTTP executor for durable delegated tasks.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function boundedInteger(value, fallback, min, max, name) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < min || candidate > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return candidate;
}

function redactText(value, maxChars = 20_000) {
  return String(value ?? "")
    .replace(/(bearer\s+)[a-z0-9._~+\/-]+/gi, "$1<redacted>")
    .replace(/((?:api[_-]?key|token|secret|password|authorization|cookie)\s*[:=]\s*)[^\s,;]+/gi, "$1<redacted>")
    .slice(0, maxChars);
}

function safeEventValue(value, depth = 0) {
  if (depth > 6) return "<max-depth>";
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeEventValue(item, depth + 1));
  if (typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      result[key] = /(token|secret|password|authorization|cookie|api[_-]?key)/i.test(key)
        ? "<redacted>"
        : safeEventValue(item, depth + 1);
    }
    return result;
  }
  return redactText(value);
}

function sanitizeError(error) {
  const result = {
    name: typeof error?.name === "string" && error.name ? error.name : "Error",
    message: redactText(typeof error?.message === "string" && error.message ? error.message : String(error), 4_000)
  };
  if (typeof error?.code === "string") result.code = error.code;
  return result;
}

function parseModel(value) {
  const text = String(value || "opencode-go/deepseek-v4-pro").trim();
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) throw new TypeError("model must use provider/model format");
  return { providerID: text.slice(0, slash), modelID: text.slice(slash + 1) };
}

function agentForRole(role, configured) {
  if (configured) return configured;
  return role === "planner" ? "plan" : "build";
}

function abortError(reason) {
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" ? reason : "The operation was aborted");
  error.name = "AbortError";
  return error;
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal.reason));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal.reason));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function jsonMarker(text) {
  const match = String(text || "").match(/<LCA_RESULT>\s*([\s\S]*?)\s*<\/LCA_RESULT>/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function assistantText(messages) {
  return messages
    .filter((message) => message?.info?.role === "assistant")
    .flatMap((message) => (message.parts || []).filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text))
    .join("\n")
    .trim();
}

function latestAssistant(messages) {
  return [...messages].reverse().find((message) => message?.info?.role === "assistant") || null;
}

function filesFromDiff(diff) {
  if (!Array.isArray(diff)) return [];
  const values = [];
  for (const item of diff) {
    const candidate = item?.file || item?.path || item?.filename || item?.newPath || item?.oldPath;
    if (typeof candidate === "string" && candidate.trim()) values.push(candidate.trim());
  }
  return [...new Set(values)].sort();
}

function normalizeResult(raw, fallback) {
  const status = ["completed", "blocked", "failed"].includes(raw?.status) ? raw.status : fallback.status;
  const summary = typeof raw?.summary === "string" && raw.summary.trim() ? raw.summary.trim() : fallback.summary;
  const stringArray = (value, fallbackValue = []) => Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
    : fallbackValue;
  return {
    status,
    summary,
    filesChanged: stringArray(raw?.filesChanged, fallback.filesChanged),
    assumptions: stringArray(raw?.assumptions),
    unresolvedIssues: stringArray(raw?.unresolvedIssues),
    artifacts: Array.isArray(raw?.artifacts) ? raw.artifacts : fallback.artifacts,
    evidence: Array.isArray(raw?.evidence) ? raw.evidence : fallback.evidence
  };
}

function buildPrompt({ taskId, runId, request, agent }) {
  const acceptance = Array.isArray(request.acceptanceCriteria) && request.acceptanceCriteria.length
    ? request.acceptanceCriteria.map((item, index) => `${index + 1}. ${item}`).join("\n")
    : "1. Complete the stated goal and verify the result.";
  const capabilities = Array.isArray(request.requiredCapabilities) && request.requiredCapabilities.length
    ? request.requiredCapabilities.join(", ")
    : "Use the tools needed for the task.";
  return [
    "You are executing a durable Local Coding Agent task inside the current workspace.",
    `Task ID: ${taskId}`,
    `Run ID: ${runId}`,
    `Assigned OpenCode agent: ${agent}`,
    `Goal: ${request.goal}`,
    `Role: ${request.role}`,
    `Risk: ${request.risk}`,
    `Maximum tool calls requested: ${request.maxToolCalls}`,
    `Required capabilities: ${capabilities}`,
    "Acceptance criteria:",
    acceptance,
    "",
    "Execution rules:",
    "- Work autonomously in the current workspace and do not merely explain what could be done.",
    "- Use the configured MCP providers when they improve correctness.",
    "- When choosing among multiple MCP tools, use tool_attention.rank_tools or tool_attention.pick_tool before invoking a specialist tool.",
    "- Respect the requested risk and do not perform destructive or irreversible operations without an explicit task requirement.",
    "- Run relevant verification and include concrete evidence.",
    "- Do not ask the user a question. If blocked, finish with status blocked and explain the exact blocker.",
    "",
    "Finish with exactly one machine-readable result block in addition to any concise human summary:",
    "<LCA_RESULT>",
    JSON.stringify({
      status: "completed",
      summary: "What was accomplished",
      filesChanged: ["relative/path"],
      evidence: [{ type: "test", detail: "command and result" }],
      artifacts: [],
      assumptions: [],
      unresolvedIssues: []
    }, null, 2),
    "</LCA_RESULT>"
  ].join("\n");
}

function createToolEventEmitter(emit, maxToolCalls) {
  const seen = new Set();
  const requestedCalls = new Set();
  return (messages) => {
    for (const message of messages) {
      if (message?.info?.role !== "assistant") continue;
      for (const part of message.parts || []) {
        if (part?.type !== "tool") continue;
        const callId = String(part.callID || part.callId || part.id || "tool-call");
        const state = part.state || {};
        const status = String(state.status || part.status || "").toLowerCase();
        const toolName = String(part.tool || part.name || state.tool || "unknown");
        const basePayload = { callId, toolName, input: safeEventValue(state.input || part.input || {}) };
        if (!seen.has(`${callId}:requested`)) {
          if (!requestedCalls.has(callId) && requestedCalls.size >= maxToolCalls) {
            const error = new Error(`OpenCode exceeded maxToolCalls=${maxToolCalls}`);
            error.name = "MaxToolCallsExceededError";
            error.code = "MAX_TOOL_CALLS_EXCEEDED";
            throw error;
          }
          requestedCalls.add(callId);
          emit({ type: "tool-call.requested", payload: basePayload, traceId: callId });
          seen.add(`${callId}:requested`);
        }
        if (["pending", "running", "started"].includes(status) && !seen.has(`${callId}:started`)) {
          emit({ type: "tool-call.started", payload: basePayload, traceId: callId });
          seen.add(`${callId}:started`);
        }
        if (["completed", "success", "succeeded"].includes(status) && !seen.has(`${callId}:succeeded`)) {
          if (!seen.has(`${callId}:started`)) {
            emit({ type: "tool-call.started", payload: basePayload, traceId: callId });
            seen.add(`${callId}:started`);
          }
          emit({ type: "tool-call.succeeded", payload: { ...basePayload, output: safeEventValue(state.output ?? part.output) }, traceId: callId });
          seen.add(`${callId}:succeeded`);
        }
        if (["error", "failed"].includes(status) && !seen.has(`${callId}:failed`)) {
          if (!seen.has(`${callId}:started`)) {
            emit({ type: "tool-call.started", payload: basePayload, traceId: callId });
            seen.add(`${callId}:started`);
          }
          emit({ type: "tool-call.failed", payload: { ...basePayload, error: safeEventValue(state.error || part.error || "tool call failed") }, traceId: callId });
          seen.add(`${callId}:failed`);
        }
      }
    }
  };
}

export function createOpenCodeExecutor(options = {}) {
  assertObject(options, "options");
  const workspace = path.resolve(assertNonEmptyString(options.workspace, "workspace"));
  const command = options.command || process.env.LCA_OPENCODE_COMMAND || "opencode";
  const configPath = options.configPath || process.env.LCA_OPENCODE_CONFIG || path.join(process.env.HOME || "", ".config", "opencode", "opencode.json");
  const model = parseModel(options.model || process.env.LCA_OPENCODE_MODEL || "opencode-go/deepseek-v4-pro");
  const configuredAgent = options.agent || process.env.LCA_OPENCODE_AGENT || "";
  const startupTimeoutMs = boundedInteger(options.startupTimeoutMs, 45_000, 1_000, 180_000, "startupTimeoutMs");
  const pollIntervalMs = boundedInteger(options.pollIntervalMs, 750, 100, 10_000, "pollIntervalMs");
  const fetchImpl = options.fetchImpl || fetch;
  const spawnImpl = options.spawnImpl || spawn;
  const allocatePort = options.allocatePort || findFreePort;
  if (typeof fetchImpl !== "function" || typeof spawnImpl !== "function" || typeof allocatePort !== "function") {
    throw new TypeError("fetchImpl, spawnImpl, and allocatePort must be functions");
  }

  let child = null;
  let baseUrl = null;
  let starting = null;
  let closed = false;
  let stdout = "";
  let stderr = "";
  const activeSessions = new Map();

  async function ensureStarted() {
    if (closed) throw new Error("OpenCode executor is closed");
    if (child && child.exitCode === null && baseUrl) return baseUrl;
    if (starting) return starting;
    starting = (async () => {
      const port = await allocatePort();
      const args = ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "WARN"];
      child = spawnImpl(command, args, {
        cwd: workspace,
        env: { ...process.env, OPENCODE_CONFIG: configPath },
        stdio: ["ignore", "pipe", "pipe"]
      });
      child.stdout?.on("data", (chunk) => { stdout = (stdout + String(chunk)).slice(-100_000); });
      child.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-100_000); });
      child.once?.("exit", () => { baseUrl = null; });
      child.once?.("error", () => { baseUrl = null; });
      baseUrl = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + startupTimeoutMs;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`OpenCode sidecar exited with code ${child.exitCode}: ${stderr.slice(-2_000)}`);
        try {
          const response = await fetchWithTimeout(fetchImpl, `${baseUrl}/global/health`, {}, 2_000);
          if (response.ok) return baseUrl;
        } catch {
          // Retry until startup deadline.
        }
        await sleep(250);
      }
      throw new Error(`OpenCode sidecar did not become healthy within ${startupTimeoutMs}ms: ${stderr.slice(-2_000)}`);
    })().catch(async (error) => {
      await stopChild();
      throw error;
    }).finally(() => { starting = null; });
    return starting;
  }

  async function requestJson(url, init = {}, timeoutMs = 15_000) {
    const response = await fetchWithTimeout(fetchImpl, url, init, timeoutMs);
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`OpenCode HTTP ${response.status}: ${text.slice(0, 2_000)}`);
      error.name = "OpenCodeHttpError";
      error.code = `HTTP_${response.status}`;
      throw error;
    }
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  }

  async function abortSession(sessionId) {
    if (!baseUrl || !sessionId) return;
    const query = `?directory=${encodeURIComponent(workspace)}`;
    await requestJson(`${baseUrl}/session/${encodeURIComponent(sessionId)}/abort${query}`, { method: "POST" }, 5_000).catch(() => {});
  }

  async function execute(context) {
    assertObject(context, "executor context");
    const { taskId, runId, agentId, request, signal, emit } = context;
    assertNonEmptyString(taskId, "taskId");
    assertNonEmptyString(runId, "runId");
    assertObject(request, "request");
    if (typeof emit !== "function") throw new TypeError("emit must be a function");
    if (signal?.aborted) throw abortError(signal.reason);

    const url = await ensureStarted();
    const query = `?directory=${encodeURIComponent(workspace)}`;
    const agent = agentForRole(request.role, configuredAgent);
    const stepId = `opencode-${runId}`;
    let sessionId = null;
    let stepSettled = false;
    let abortListener = null;
    const emitToolEvents = createToolEventEmitter(emit, request.maxToolCalls);

    try {
      emit({ type: "agent.started", payload: { executor: "opencode-http", agent, model }, agentId });
      emit({ type: "step.created", payload: { title: "OpenCode execution", objective: request.goal }, stepId, agentId });
      emit({ type: "step.started", payload: { executor: "opencode-http" }, stepId, agentId });

      const created = await requestJson(`${url}/session${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: `LCA ${taskId}: ${String(request.goal).slice(0, 100)}` })
      });
      sessionId = assertNonEmptyString(created?.id, "OpenCode session id");
      activeSessions.set(sessionId, { taskId, runId });

      abortListener = () => { abortSession(sessionId).catch(() => {}); };
      signal?.addEventListener("abort", abortListener, { once: true });

      await requestJson(`${url}/session/${encodeURIComponent(sessionId)}/prompt_async${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          agent,
          parts: [{ type: "text", text: buildPrompt({ taskId, runId, request, agent }) }]
        })
      });

      let messages = [];
      let assistant = null;
      while (true) {
        if (signal?.aborted) throw abortError(signal.reason);
        messages = await requestJson(`${url}/session/${encodeURIComponent(sessionId)}/message${query}`, {}, 15_000) || [];
        emitToolEvents(messages);
        assistant = latestAssistant(messages);
        if (assistant?.info?.error) {
          const error = new Error(assistant.info.error.message || "OpenCode assistant failed");
          error.name = assistant.info.error.name || "OpenCodeAssistantError";
          throw error;
        }
        if (assistant?.info?.time?.completed || assistant?.info?.finish) break;
        await sleep(pollIntervalMs, signal);
      }

      const diff = await requestJson(`${url}/session/${encodeURIComponent(sessionId)}/diff${query}`, {}, 15_000).catch(() => []);
      const filesChanged = filesFromDiff(diff);
      const text = assistantText(messages);
      const marker = jsonMarker(text);
      const fallback = {
        status: "completed",
        summary: text || `OpenCode session ${sessionId} completed`,
        filesChanged,
        artifacts: [],
        evidence: [
          { type: "opencode-session", sessionId, model: `${model.providerID}/${model.modelID}`, agent },
          ...(Array.isArray(diff) && diff.length ? [{ type: "diff", filesChanged }] : [])
        ]
      };
      const result = normalizeResult(marker, fallback);
      if (!result.filesChanged.length && filesChanged.length) result.filesChanged = filesChanged;
      if (!result.evidence.some((item) => item?.sessionId === sessionId)) {
        result.evidence.push({ type: "opencode-session", sessionId, model: `${model.providerID}/${model.modelID}`, agent });
      }
      emit({ type: "step.completed", payload: { sessionId, summary: result.summary }, stepId, agentId });
      stepSettled = true;
      return result;
    } catch (error) {
      if (sessionId) await abortSession(sessionId);
      if (!stepSettled) {
        try {
          emit({ type: "step.failed", payload: { error: sanitizeError(error), sessionId }, stepId, agentId });
          stepSettled = true;
        } catch {
          // Supervisor may already have settled after its own timeout.
        }
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortListener);
      if (sessionId) activeSessions.delete(sessionId);
    }
  }

  function snapshot() {
    return Object.freeze({
      mode: "opencode-http",
      running: Boolean(child && child.exitCode === null && baseUrl),
      activeSessions: activeSessions.size,
      model: `${model.providerID}/${model.modelID}`,
      agent: configuredAgent || "role-mapped",
      lastError: child && child.exitCode !== null ? `sidecar exited with code ${child.exitCode}` : null
    });
  }

  async function stopChild() {
    if (!child) return;
    const target = child;
    child = null;
    baseUrl = null;
    if (target.exitCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { target.kill("SIGKILL"); } catch {}
        resolve();
      }, 3_000);
      target.once?.("exit", () => { clearTimeout(timer); resolve(); });
      try { target.kill("SIGTERM"); } catch { clearTimeout(timer); resolve(); }
    });
  }

  async function close() {
    if (closed) return;
    closed = true;
    await Promise.allSettled([...activeSessions.keys()].map((sessionId) => abortSession(sessionId)));
    activeSessions.clear();
    await stopChild();
  }

  return Object.freeze({ mode: "opencode-http", execute, snapshot, close });
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`HTTP request timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
