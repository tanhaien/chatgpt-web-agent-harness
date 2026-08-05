import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import http from "node:http";
import { createOpenCodeExecutor } from "./opencode-executor.mjs";

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : null); } catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

let promptBody = null;
let abortCount = 0;
let sessionCounter = 0;
const messagesBySession = new Map();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/global/health") return sendJson(res, 200, { healthy: true });
  if (req.method === "POST" && url.pathname === "/session") {
    sessionCounter++;
    const id = `session-${sessionCounter}`;
    messagesBySession.set(id, []);
    return sendJson(res, 200, { id });
  }
  const match = url.pathname.match(/^\/session\/([^/]+)\/(prompt_async|message|diff|abort)$/);
  if (!match) return sendJson(res, 404, { error: "not found" });
  const [, sessionId, action] = match;
  if (req.method === "POST" && action === "prompt_async") {
    promptBody = await readBody(req);
    if (sessionId === "session-1") {
      messagesBySession.set(sessionId, [
        {
          info: { role: "user" },
          parts: [{ type: "text", text: promptBody.parts[0].text }]
        },
        {
          info: { role: "assistant", finish: "stop", time: { completed: Date.now() } },
          parts: [
            { type: "tool", callID: "call-1", tool: "tool_attention.rank_tools", state: { status: "completed", input: { query: "fixture", apiKey: "SECRET_INPUT" }, output: { picked: "contextplus/get_blast_radius", detail: "Bearer SECRET_OUTPUT" } } },
            { type: "text", text: "Completed fixture task.\n<LCA_RESULT>{\"status\":\"completed\",\"summary\":\"Fixture completed\",\"filesChanged\":[\"src/example.mjs\"],\"evidence\":[{\"type\":\"test\",\"detail\":\"fixture passed\"}],\"artifacts\":[],\"assumptions\":[],\"unresolvedIssues\":[]}</LCA_RESULT>" }
          ]
        }
      ]);
    } else if (sessionId === "session-2") {
      messagesBySession.set(sessionId, [
        { info: { role: "user" }, parts: [{ type: "text", text: promptBody.parts[0].text }] },
        {
          info: { role: "assistant", finish: "stop", time: { completed: Date.now() } },
          parts: [
            { type: "tool", callID: "budget-1", tool: "read", state: { status: "completed", input: {}, output: "one" } },
            { type: "tool", callID: "budget-2", tool: "read", state: { status: "completed", input: {}, output: "two" } },
            { type: "text", text: "should not be accepted" }
          ]
        }
      ]);
    }
    res.writeHead(204);
    return res.end();
  }
  if (req.method === "GET" && action === "message") return sendJson(res, 200, messagesBySession.get(sessionId) || []);
  if (req.method === "GET" && action === "diff") return sendJson(res, 200, [{ file: "src/example.mjs" }]);
  if (req.method === "POST" && action === "abort") {
    abortCount++;
    return sendJson(res, 200, true);
  }
  return sendJson(res, 405, { error: "method" });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

function fakeSpawn() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = (signal) => {
    child.exitCode = signal === "SIGKILL" ? 137 : 0;
    queueMicrotask(() => child.emit("exit", child.exitCode, signal));
    return true;
  };
  return child;
}

const executor = createOpenCodeExecutor({
  workspace: process.cwd(),
  spawnImpl: fakeSpawn,
  allocatePort: async () => port,
  pollIntervalMs: 100,
  startupTimeoutMs: 2_000,
  model: "opencode-go/deepseek-v4-pro"
});

const events = [];
try {
  const result = await executor.execute({
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-1",
    request: {
      goal: "Exercise fake OpenCode executor",
      role: "executor",
      risk: "safe-write",
      maxToolCalls: 10,
      requiredCapabilities: ["code.intelligence"],
      acceptanceCriteria: ["Fixture completes"]
    },
    signal: new AbortController().signal,
    emit: (event) => events.push(structuredClone(event))
  });

  assert.equal(result.status, "completed");
  assert.equal(result.summary, "Fixture completed");
  assert.deepEqual(result.filesChanged, ["src/example.mjs"]);
  assert.equal(result.evidence.some((item) => item.type === "opencode-session"), true);
  assert.equal(promptBody.agent, "build");
  assert.deepEqual(promptBody.model, { providerID: "opencode-go", modelID: "deepseek-v4-pro" });
  assert.equal(promptBody.parts[0].text.includes("tool_attention.rank_tools"), true);
  assert.deepEqual(events.map((event) => event.type), [
    "agent.started",
    "step.created",
    "step.started",
    "tool-call.requested",
    "tool-call.started",
    "tool-call.succeeded",
    "step.completed"
  ]);
  const succeededEvent = events.find((event) => event.type === "tool-call.succeeded");
  assert.equal(succeededEvent.payload.input.apiKey, "<redacted>");
  assert.equal(succeededEvent.payload.output.detail, "Bearer <redacted>");

  await assert.rejects(
    executor.execute({
      taskId: "task-budget",
      runId: "run-budget",
      agentId: "agent-budget",
      request: {
        goal: "Exceed tool budget",
        role: "executor",
        risk: "read",
        maxToolCalls: 1,
        acceptanceCriteria: ["Do not exceed budget"]
      },
      signal: new AbortController().signal,
      emit: () => {}
    }),
    (error) => error?.code === "MAX_TOOL_CALLS_EXCEEDED"
  );
  assert.equal(abortCount >= 1, true);

  const controller = new AbortController();
  const aborted = executor.execute({
    taskId: "task-2",
    runId: "run-2",
    agentId: "agent-2",
    request: {
      goal: "Wait until aborted",
      role: "executor",
      risk: "read",
      maxToolCalls: 1,
      acceptanceCriteria: []
    },
    signal: controller.signal,
    emit: () => {}
  });
  setTimeout(() => controller.abort(new DOMException("cancelled", "AbortError")), 150);
  await assert.rejects(aborted, (error) => error?.name === "AbortError");
  assert.equal(abortCount >= 2, true);

  const snapshot = executor.snapshot();
  assert.equal(snapshot.mode, "opencode-http");
  assert.equal(snapshot.model, "opencode-go/deepseek-v4-pro");
} finally {
  await executor.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log("opencode-executor: all assertions passed");
