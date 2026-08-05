// Durable orchestration server integration suite.
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(SERVER_DIR, "server.mjs");
const ENV_PATH = path.join(SERVER_DIR, ".env");

async function freePort() {
  const server = net.createServer();
  server.unref();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(url, childState) {
  for (let i = 0; i < 100; i++) {
    if (childState.child.exitCode !== null) {
      throw new Error(`Server exited before readiness.\n${childState.stderr}\n${childState.stdout}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // Retry while the child is booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not become ready: ${url}\n${childState.stderr}\n${childState.stdout}`);
}

async function startServer(workspace) {
  const port = await freePort();
  const dashboardPort = await freePort();
  await mkdir(workspace, { recursive: true });
  const child = spawn(process.execPath, [SERVER], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      DASHBOARD_PORT: String(dashboardPort),
      AGENT_HOST: "127.0.0.1",
      DASHBOARD_HOST: "127.0.0.1",
      AGENT_WORKSPACE: workspace,
      AGENT_EXTRA_ROOTS_JSON: "[]",
      AGENT_MODE: "safe",
      AGENT_POLICY: "full",
      MCP_AUTH_TOKEN: "",
      AGENT_APPROVAL_TOKEN: ""
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const state = { child, port, dashboardPort, stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => (state.stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (state.stderr += String(chunk)));
  await waitFor(`http://127.0.0.1:${port}/healthz`, state);
  return state;
}

async function stopServer(state) {
  if (!state?.child || state.child.exitCode !== null) return;
  state.child.kill("SIGTERM");
  await Promise.race([
    once(state.child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 2500))
  ]);
  if (state.child.exitCode === null) {
    state.child.kill("SIGKILL");
    await once(state.child, "exit");
  }
}

async function connect(port) {
  const client = new Client({ name: "orchestration-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return client;
}

async function callJson(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text || "";
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

async function expectToolFailure(client, name, args) {
  try {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, `${name} should fail`);
    return result.content?.[0]?.text || "";
  } catch (error) {
    return String(error?.message || error);
  }
}

async function readFirstSseFrame(url) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
  return text;
}

const root = await mkdtemp(path.join(os.tmpdir(), "lca-orchestration-"));
const workspaceA = path.join(root, "workspace-a");
const workspaceB = path.join(root, "workspace-b");
let envExisted = true;
let envBefore = "";
try {
  envBefore = await readFile(ENV_PATH, "utf8");
} catch {
  envExisted = false;
}

let serverState = null;
let client = null;
const logs = [];
try {
  await mkdir(workspaceA, { recursive: true });
  await mkdir(workspaceB, { recursive: true });

  serverState = await startServer(workspaceA);
  const health = await (await fetch(`http://127.0.0.1:${serverState.port}/healthz`)).json();
  assert.equal(health.orchestration.enabled, true);
  assert.equal(health.orchestration.executor_mode, "blocked-fallback");
  assert.equal(typeof health.orchestration.workspace_id, "string");
  assert.ok(health.orchestration.workspace_id.length > 0);
  assert.equal(Object.hasOwn(health.orchestration, "dbPath"), false);
  assert.equal(Object.hasOwn(health.orchestration, "db_path"), false);
  assert.ok(!JSON.stringify(health.orchestration).includes(workspaceA));
  console.log("[PASS] health exposes honest orchestration mode");

  client = await connect(serverState.port);
  const requestA = {
    goal: "Persist a queued integration task",
    role: "executor",
    acceptanceCriteria: ["Task is durable"],
    risk: "read",
    maxToolCalls: 1,
    timeoutMs: 5000,
    idempotencyKey: "integration-a"
  };
  const requestCopy = structuredClone(requestA);
  const delegatedA = await callJson(client, "delegate_task", requestA);
  assert.deepEqual(requestA, requestCopy);
  assert.equal(delegatedA.status, "queued");
  assert.equal(delegatedA.started, false);
  assert.equal(delegatedA.executorMode, "blocked-fallback");
  const taskA = delegatedA.taskId;
  console.log("[PASS] delegate_task queues without mutating input");

  const replayA = await callJson(client, "delegate_task", requestA);
  assert.equal(replayA.taskId, taskA);
  assert.equal(replayA.runId, delegatedA.runId);
  console.log("[PASS] idempotency replay returns the same durable task");

  const statusA = await callJson(client, "task_status", { taskId: taskA });
  assert.equal(statusA.found, true);
  assert.equal(statusA.task.status, "queued");
  console.log("[PASS] task_status projects queued state");

  const eventsA = await callJson(client, "task_events", { taskId: taskA, afterSequence: -1, limit: 100 });
  assert.deepEqual(eventsA.events.map((event) => event.type), ["task.created", "task.queued", "agent.spawned"]);
  assert.deepEqual(eventsA.events.map((event) => event.sequence), [0, 1, 2]);
  assert.equal(eventsA.nextSequence, 2);
  assert.equal(eventsA.events.length, 3, "idempotency replay must not duplicate initial events");
  const page1 = await callJson(client, "task_events", { taskId: taskA, afterSequence: 0, limit: 1 });
  assert.deepEqual(page1.events.map((event) => event.sequence), [1]);
  assert.equal(page1.nextSequence, 1);
  assert.equal(page1.hasMore, true);
  const page2 = await callJson(client, "task_events", { taskId: taskA, afterSequence: page1.nextSequence, limit: 1 });
  assert.deepEqual(page2.events.map((event) => event.sequence), [2]);
  assert.equal(page2.nextSequence, 2);
  assert.equal(page2.hasMore, false);
  console.log("[PASS] task_events returns ordered durable lifecycle");

  for (const risk of ["risky", "critical"]) {
    const riskTask = await callJson(client, "delegate_task", {
      goal: `Exercise ${risk} contract boundary`,
      role: "executor",
      acceptanceCriteria: ["Risk value is accepted"],
      risk,
      maxToolCalls: 1,
      timeoutMs: 5000,
      idempotencyKey: `integration-risk-${risk}`
    });
    assert.equal(riskTask.status, "queued");
  }
  const invalidRiskText = await expectToolFailure(client, "delegate_task", {
    goal: "Reject legacy risk enum",
    role: "executor",
    acceptanceCriteria: ["Legacy risk is rejected"],
    risk: "external-effect",
    maxToolCalls: 1,
    timeoutMs: 5000
  });
  assert.ok(invalidRiskText.length > 0);
  console.log("[PASS] delegate_task risk schema matches contracts");

  const waitA = await callJson(client, "task_wait", { taskId: taskA, timeoutMs: 0, afterSequence: -1 });
  assert.equal(waitA.found, true);
  assert.equal(waitA.result.terminal, false);
  assert.equal(waitA.result.timedOut, true);
  console.log("[PASS] task_wait zero timeout returns a nonterminal snapshot");

  const delegatedBlocked = await callJson(client, "delegate_task", {
    goal: "Exercise the honest fallback executor",
    role: "executor",
    acceptanceCriteria: ["A blocked result is durable"],
    risk: "read",
    maxToolCalls: 1,
    timeoutMs: 5000,
    idempotencyKey: "integration-blocked",
    start: true
  });
  assert.equal(delegatedBlocked.started, true);
  const blockedWait = await callJson(client, "task_wait", {
    taskId: delegatedBlocked.taskId,
    timeoutMs: 5000,
    afterSequence: -1
  });
  assert.equal(blockedWait.result.status, "blocked");
  assert.equal(blockedWait.result.terminal, true);
  assert.equal(blockedWait.result.timedOut, false);
  const blockedTypes = blockedWait.result.events.map((event) => event.type);
  const startedIndex = blockedTypes.indexOf("task.started");
  const completedIndex = blockedTypes.indexOf("agent.completed");
  const blockedIndex = blockedTypes.indexOf("task.blocked");
  assert.ok(startedIndex >= 0);
  assert.ok(completedIndex > startedIndex);
  assert.ok(blockedIndex > completedIndex);
  console.log("[PASS] start=true reaches durable blocked fallback status");

  const sseText = await readFirstSseFrame(
    `http://127.0.0.1:${serverState.dashboardPort}/api/task-events?taskId=${encodeURIComponent(taskA)}&afterSequence=-1&limit=100&heartbeatMs=1000`
  );
  assert.match(sseText, /id: 0\nevent: task\.created\ndata: /);
  assert.ok(sseText.includes("\n\n"));
  const tunneledSse = await fetch(`http://127.0.0.1:${serverState.port}/api/task-events?taskId=${encodeURIComponent(taskA)}`);
  assert.equal(tunneledSse.status, 404);
  const missingSse = await fetch(`http://127.0.0.1:${serverState.dashboardPort}/api/task-events?taskId=missing-task`);
  assert.equal(missingSse.status, 404);
  const invalidSse = await fetch(`http://127.0.0.1:${serverState.dashboardPort}/api/task-events`);
  assert.equal(invalidSse.status, 400);
  const invalidHeartbeat = await fetch(
    `http://127.0.0.1:${serverState.dashboardPort}/api/task-events?taskId=${encodeURIComponent(taskA)}&heartbeatMs=0`
  );
  assert.equal(invalidHeartbeat.status, 400);
  const healthAfterAbort = await fetch(`http://127.0.0.1:${serverState.port}/healthz`);
  assert.equal(healthAfterAbort.status, 200);
  console.log("[PASS] local dashboard SSE frames, abort, 400 and 404 boundaries");

  await client.close();
  client = null;
  logs.push(serverState.stdout, serverState.stderr);
  await stopServer(serverState);
  serverState = null;

  serverState = await startServer(workspaceA);
  client = await connect(serverState.port);
  const persisted = await callJson(client, "task_status", { taskId: taskA });
  assert.equal(persisted.found, true);
  assert.equal(persisted.task.status, "queued");
  const persistedEvents = await callJson(client, "task_events", { taskId: taskA });
  assert.equal(persistedEvents.events.length, 3);
  console.log("[PASS] orchestration persists across server restart");

  const switchedB = await callJson(client, "set_workspace", { path: workspaceB });
  assert.equal(switchedB.status, "switched");
  const hiddenA = await callJson(client, "task_status", { taskId: taskA });
  assert.equal(hiddenA.found, false);
  const delegatedB = await callJson(client, "delegate_task", {
    goal: "Workspace B task",
    role: "executor",
    acceptanceCriteria: ["B is isolated"],
    risk: "read",
    maxToolCalls: 1,
    timeoutMs: 5000,
    idempotencyKey: "integration-b"
  });
  const taskBStatus = await callJson(client, "task_status", { taskId: delegatedB.taskId });
  assert.equal(taskBStatus.found, true);

  const switchedA = await callJson(client, "set_workspace", { path: workspaceA });
  assert.equal(switchedA.status, "switched");
  const restoredA = await callJson(client, "task_status", { taskId: taskA });
  assert.equal(restoredA.found, true);
  const hiddenB = await callJson(client, "task_status", { taskId: delegatedB.taskId });
  assert.equal(hiddenB.found, false);
  console.log("[PASS] set_workspace isolates and restores orchestration databases");

  await client.close();
  client = null;
  logs.push(serverState.stdout, serverState.stderr);
  await stopServer(serverState);
  serverState = null;

  assert.ok(!logs.join("\n").includes("unhandledRejection"));
  console.log("[PASS] no unhandled orchestration rejection was logged");
  console.log("orchestration integration: all assertions passed");
} finally {
  if (client) await client.close().catch(() => {});
  if (serverState) {
    logs.push(serverState.stdout, serverState.stderr);
    await stopServer(serverState);
  }
  if (envExisted) {
    await writeFile(ENV_PATH, envBefore, "utf8");
  } else {
    try {
      await access(ENV_PATH);
      await rm(ENV_PATH, { force: true });
    } catch {
      // No file to restore.
    }
  }
  await rm(root, { recursive: true, force: true });
}
