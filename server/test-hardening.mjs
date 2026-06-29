// Local Coding Agent v4.1 hardening regression suite
// SPDX-License-Identifier: AGPL-3.0-or-later

import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const SERVER = path.resolve("server.mjs");
let pass = 0;
let fail = 0;

function check(name, condition, detail = "") {
  if (condition) {
    pass++;
    console.log(`[PASS] ${name}`);
  } else {
    fail++;
    console.log(`[FAIL] ${name}${detail ? `\n${detail}` : ""}`);
  }
}

async function waitFor(url) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready: ${url}`);
}

async function startServer(workspace, { port, dashboardPort = 0, policy = "strict", auth = "", maxBody = "1048576" }) {
  await mkdir(workspace, { recursive: true });
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: {
      ...process.env,
      PORT: String(port),
      DASHBOARD_PORT: String(dashboardPort),
      AGENT_WORKSPACE: workspace,
      AGENT_MODE: "safe",
      AGENT_POLICY: policy,
      AGENT_EXTRA_ROOTS_JSON: "[]",
      MCP_AUTH_TOKEN: auth,
      AGENT_MAX_BODY_BYTES: maxBody
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  await waitFor(`http://127.0.0.1:${port}/healthz`).catch((error) => {
    throw new Error(`${error.message}\n${stderr}`);
  });
  return child;
}

async function stopServer(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
}

async function connect(port) {
  const client = new Client({ name: "hardening-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return client;
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: Boolean(result.isError), text: result.content?.[0]?.text || "" };
}

function chunkedPost(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: { "content-type": "application/json", "transfer-encoding": "chunked" }
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.write(body.slice(0, Math.floor(body.length / 2)));
    req.end(body.slice(Math.floor(body.length / 2)));
  });
}

const base = await mkdtemp(path.join(os.tmpdir(), "lca-hardening-"));
let server;
try {
  // Strict policy + browser-origin + body limit + latency telemetry.
  console.log("\n[phase] strict policy, origin, body limit, telemetry");
  server = await startServer(path.join(base, "strict"), { port: 19001, dashboardPort: 19002, policy: "strict", maxBody: "8192" });
  const evil = await fetch("http://127.0.0.1:19001/mcp", {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" }
  });
  check("browser Origin is denied by default", evil.status === 403, `status=${evil.status}`);

  const client = await connect(19001);
  check("strict policy blocks write_file", (await call(client, "write_file", { path: "blocked.txt", content: "x" })).isError);
  check("strict policy blocks run_command", (await call(client, "run_command", { command: "node --version" })).isError);
  await call(client, "workspace_info");
  await client.close();

  const metrics = await (await fetch("http://127.0.0.1:19002/metrics")).json();
  check("latency telemetry exposes avg/p50/p95/p99", ["avg_latency_ms", "p50_latency_ms", "p95_latency_ms", "p99_latency_ms"].every((k) => Number.isFinite(metrics[k])));
  check("chunked payload is size-limited", (await chunkedPost(19001, JSON.stringify({ data: "x".repeat(12000) }))) === 413);
  await stopServer(server);
  server = null;

  // Balanced policy approvals are decided out of band in the local dashboard.
  console.log("\n[phase] out-of-band one-time approvals");
  server = await startServer(path.join(base, "balanced"), { port: 19006, dashboardPort: 19007, policy: "balanced" });
  const balanced = await connect(19006);
  await call(balanced, "write_file", { path: "victim.txt", content: "x" });
  const blockedDelete = await call(balanced, "delete_path", { path: "victim.txt" });
  check("balanced policy blocks delete before approval", blockedDelete.isError && blockedDelete.text.includes("Approval required"));
  const request = JSON.parse((await call(balanced, "request_approval", { action: "delete_path:victim.txt", reason: "hardening regression" })).text);
  const dashboardDecision = await fetch(`http://127.0.0.1:19007/api/approvals/${request.id}/approve`, { method: "POST" });
  check("local dashboard approves pending action", dashboardDecision.ok);
  check("approved action executes once", !(await call(balanced, "delete_path", { path: "victim.txt" })).isError);
  await call(balanced, "write_file", { path: "victim.txt", content: "x" });
  check("consumed approval cannot be replayed", (await call(balanced, "delete_path", { path: "victim.txt" })).isError);
  const evilDashboard = await fetch(`http://127.0.0.1:19007/api/approvals/${request.id}/deny`, { method: "POST", headers: { Origin: "https://evil.example" } });
  check("dashboard rejects cross-origin decisions", evilDashboard.status === 403);
  await balanced.close();
  await stopServer(server);
  server = null;

  // Query-string tokens must not authenticate.
  console.log("\n[phase] header-only bearer authentication");
  server = await startServer(path.join(base, "auth"), { port: 19003, policy: "full", auth: "operator-secret" });
  const queryAuth = await fetch("http://127.0.0.1:19003/mcp?token=operator-secret", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  check("query-string bearer token is rejected", queryAuth.status === 401, `status=${queryAuth.status}`);
  await stopServer(server);
  server = null;

  // Undo must cover created files and renamed directories.
  const workspaceA = path.join(base, "workspace-a");
  console.log("\n[phase] transactional undo coverage");
  server = await startServer(workspaceA, { port: 19004, policy: "full" });
  const full = await connect(19004);
  await call(full, "apply_patch", { operations: [{ op: "create", path: "created.txt", content: "created" }] });
  await call(full, "undo_last_patch");
  check("undo removes files created by apply_patch", (await call(full, "stat_path", { path: "created.txt" })).isError);
  await call(full, "make_dir", { path: "source-dir" });
  await call(full, "write_file", { path: "source-dir/a.txt", content: "a" });
  await call(full, "move_path", { from: "source-dir", to: "dest-dir" });
  await call(full, "undo_last_patch");
  check("undo restores renamed directory source", !(await call(full, "stat_path", { path: "source-dir/a.txt" })).isError);
  check("undo removes renamed directory destination", (await call(full, "stat_path", { path: "dest-dir" })).isError);
  await full.close();
  await stopServer(server);
  server = null;

  // History is scoped to the workspace and cannot replay into an old root.
  console.log("\n[phase] workspace-scoped history");
  server = await startServer(path.join(base, "workspace-b"), { port: 19005, policy: "full" });
  const other = await connect(19005);
  check("new workspace cannot undo another workspace history", (await call(other, "undo_last_patch")).isError);
  await other.close();
} finally {
  if (server) await stopServer(server);
  await rm(base, { recursive: true, force: true });
}

console.log(`\n==== HARDENING: ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
