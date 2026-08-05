import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(SERVER_DIR, "server.mjs");
const FIXTURE = path.join(SERVER_DIR, "test-fixtures", "mcp-provider-fixture.mjs");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(url, state) {
  for (let i = 0; i < 120; i++) {
    if (state.child.exitCode !== null) throw new Error(`server exited ${state.child.exitCode}\n${state.stderr}`);
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not become ready\n${state.stderr}\n${state.stdout}`);
}

async function startServer(base, policy) {
  const workspace = path.join(base, `workspace-${policy}`);
  await mkdir(workspace, { recursive: true });
  const port = await freePort();
  const dashboardPort = await freePort();
  const configPath = path.join(base, `opencode-${policy}.json`);
  await writeFile(configPath, JSON.stringify({
    mcp: {
      "tool-attention": { type: "local", command: [process.execPath, FIXTURE, "attention"] },
      fixture: { type: "local", command: [process.execPath, FIXTURE, "fixture"] }
    }
  }), "utf8");
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
      AGENT_POLICY: policy,
      MCP_AUTH_TOKEN: "",
      AGENT_APPROVAL_TOKEN: "",
      LCA_ORCHESTRATION_EXECUTOR: "blocked",
      LCA_MCP_GATEWAY: "1",
      LCA_MCP_CONFIG_PATH: configPath,
      LCA_MCP_PROVIDER_ALLOWLIST: "tool-attention,fixture"
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const state = { child, port, dashboardPort, workspace, stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => { state.stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { state.stderr += String(chunk); });
  const health = await waitFor(`http://127.0.0.1:${port}/healthz`, state);
  assert.equal(health.mcp_gateway.providerCount, 2);
  assert.equal(health.mcp_gateway.toolAttention, true);
  return state;
}

async function stopServer(state) {
  if (!state?.child || state.child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(state.child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    state.child.kill("SIGTERM");
  }
  await Promise.race([once(state.child, "exit"), new Promise((resolve) => setTimeout(resolve, 4000))]);
  if (state.child.exitCode === null) state.child.kill("SIGKILL");
}

async function connect(port) {
  const client = new Client({ name: "gateway-server-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return client;
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: Boolean(result.isError),
    text: result.content?.[0]?.text || "",
    json: (() => { try { return JSON.parse(result.content?.[0]?.text || ""); } catch { return null; } })()
  };
}

const base = await mkdtemp(path.join(os.tmpdir(), "lca-gateway-server-"));
let state;
try {
  state = await startServer(base, "strict");
  let client = await connect(state.port);
  const ranked = await call(client, "gateway_find_tools", { query: "read fixture record", topK: 3, maxRisk: "read" });
  assert.equal(ranked.isError, false);
  assert.equal(ranked.json.strategy, "tool-attention");
  assert.equal(ranked.json.rankedTools[0].id, "fixture/read_record");

  const read = await call(client, "gateway_call", { toolId: "fixture/read_record", input: { id: "one" } });
  assert.equal(read.isError, false);
  assert.equal(read.json.output.tool, "read_record");

  const strictWrite = await call(client, "gateway_call", { toolId: "fixture/write_record", input: { id: "one", value: 1 } });
  assert.equal(strictWrite.isError, true);
  assert.equal(strictWrite.text.includes("blocked by policy=strict"), true);
  await client.close();
  await stopServer(state);
  state = null;

  state = await startServer(base, "balanced");
  client = await connect(state.port);
  const blockedDelete = await call(client, "gateway_call", { toolId: "fixture/delete_record", input: { id: "one" } });
  assert.equal(blockedDelete.isError, true);
  assert.equal(blockedDelete.text.includes("Approval required"), true);

  const approval = await call(client, "request_approval", {
    action: "gateway_call:fixture/delete_record",
    reason: "gateway policy regression"
  });
  assert.equal(approval.isError, false);
  const decision = await fetch(`http://127.0.0.1:${state.dashboardPort}/api/approvals/${approval.json.id}/approve`, { method: "POST" });
  assert.equal(decision.ok, true);

  const approvedDelete = await call(client, "gateway_call", { toolId: "fixture/delete_record", input: { id: "one" } });
  assert.equal(approvedDelete.isError, false);
  assert.equal(approvedDelete.json.output.tool, "delete_record");

  const replayDelete = await call(client, "gateway_call", { toolId: "fixture/delete_record", input: { id: "two" } });
  assert.equal(replayDelete.isError, true);
  assert.equal(replayDelete.text.includes("Approval required"), true);
  await client.close();
} finally {
  await stopServer(state);
  await rm(base, { recursive: true, force: true });
}

console.log("mcp-gateway-server: all assertions passed");
