#!/usr/bin/env node
// Local Coding Agent standalone client MVP
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(APP_DIR, "public");
const PUBLIC_ROOT = resolve(PUBLIC_DIR);
const HOST = process.env.LCA_STUDIO_HOST || "127.0.0.1";
const PORT = Number(process.env.LCA_STUDIO_PORT || 5177);
const DEFAULT_MCP_URL = process.env.MCP_ENDPOINT || "http://127.0.0.1:8787/mcp";
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const MAX_TOOL_LOOPS = Number(process.env.LCA_STUDIO_MAX_TOOL_LOOPS || 8);

let mcpState = {
  endpoint: DEFAULT_MCP_URL,
  client: null,
  transport: null,
  tools: []
};

const toolEvents = [];

function json(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(text);
}

function text(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 2_000_000) throw new Error("Request body too large");
  }
  return body ? JSON.parse(body) : {};
}

async function connectMcp(endpoint = DEFAULT_MCP_URL) {
  if (mcpState.client) {
    await mcpState.client.close().catch(() => {});
  }
  const client = new Client({ name: "local-agent-client-mvp", version: "4.5.0-pro-mvp" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  await client.connect(transport);
  const listed = await client.listTools();
  mcpState = {
    endpoint,
    client,
    transport,
    tools: listed.tools || []
  };
  return mcpState;
}

function mcpToolsForModel() {
  return mcpState.tools.map((tool) => ({
    type: "function",
    name: sanitizeToolName(tool.name),
    description: tool.description || tool.title || `Call MCP tool ${tool.name}`,
    parameters: normalizeJsonSchema(tool.inputSchema || { type: "object", properties: {} })
  }));
}

function sanitizeToolName(name) {
  return String(name).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function originalToolName(sanitized) {
  const hit = mcpState.tools.find((tool) => sanitizeToolName(tool.name) === sanitized);
  return hit?.name || sanitized;
}

function normalizeJsonSchema(schema) {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  const out = JSON.parse(JSON.stringify(schema));
  if (!out.type) out.type = "object";
  if (out.type === "object" && !out.properties) out.properties = {};
  return out;
}

function extractTextFromResponse(response) {
  if (typeof response.output_text === "string" && response.output_text) return response.output_text;
  const parts = [];
  for (const item of response.output || []) {
    if (item.type === "message") {
      for (const content of item.content || []) {
        if (content.type === "output_text" || content.type === "text") parts.push(content.text || "");
      }
    }
  }
  return parts.filter(Boolean).join("\n").trim();
}

function functionCalls(response) {
  return (response.output || []).filter((item) => item.type === "function_call");
}

async function callOpenAI(payload) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`
    },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.message || `${res.status} ${res.statusText}`;
    throw new Error(`OpenAI Responses API failed: ${message}`);
  }
  return data;
}

function systemPrompt() {
  return `You are Local Coding Agent Studio, a standalone AI coding assistant connected to a local MCP server.

Rules:
- First inspect the workspace with workspace_info or workspace_snapshot when the task needs repo context.
- Prefer MCP file/search/git tools over shell commands.
- Use read_many for multiple files and run_commands for independent checks.
- Keep edits scoped to the user request.
- Explain risky actions before mutating files or running commands.
- After changing code, run the most relevant checks available.
- If a tool call is denied by policy, explain what approval or safer alternative is needed.`;
}

async function chatWithTools({ message, model = DEFAULT_MODEL }) {
  if (!mcpState.client) await connectMcp(DEFAULT_MCP_URL);
  const timeline = [];
  let input = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: message }
  ];
  let response;
  for (let i = 0; i < MAX_TOOL_LOOPS; i++) {
    response = await callOpenAI({
      model,
      input,
      tools: mcpToolsForModel(),
      tool_choice: "auto"
    });
    const calls = functionCalls(response);
    if (!calls.length) {
      return { text: extractTextFromResponse(response), timeline, raw: response };
    }
    input = [{ role: "system", content: systemPrompt() }, { role: "user", content: message }, ...response.output];
    for (const call of calls) {
      const toolName = originalToolName(call.name);
      let args = {};
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        args = {};
      }
      const started = Date.now();
      let resultText = "";
      let isError = false;
      try {
        const result = await mcpState.client.callTool({ name: toolName, arguments: args });
        resultText = result.content?.map((part) => part.text || JSON.stringify(part)).join("\n") || "";
        isError = Boolean(result.isError);
      } catch (error) {
        isError = true;
        resultText = error?.message || String(error);
      }
      const event = {
        at: new Date().toISOString(),
        tool: toolName,
        args,
        isError,
        ms: Date.now() - started,
        result: resultText.slice(0, 50_000)
      };
      toolEvents.push(event);
      timeline.push(event);
      input.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: resultText.slice(0, 50_000)
      });
    }
  }
  return {
    text: extractTextFromResponse(response) || "Stopped after max tool loops.",
    timeline,
    raw: response
  };
}

async function handleApi(req, res, url) {
  try {
    if (url.pathname === "/api/health") {
      return json(res, 200, {
        ok: true,
        version: "4.5.0-pro-mvp",
        mcp_endpoint: mcpState.endpoint,
        connected: Boolean(mcpState.client),
        tools: mcpState.tools.length,
        model: DEFAULT_MODEL,
        openai_key_present: Boolean(process.env.OPENAI_API_KEY)
      });
    }
    if (url.pathname === "/api/connect" && req.method === "POST") {
      const body = await readJson(req);
      const state = await connectMcp(body.endpoint || DEFAULT_MCP_URL);
      return json(res, 200, {
        ok: true,
        endpoint: state.endpoint,
        tools: state.tools.map((tool) => ({ name: tool.name, description: tool.description || tool.title || "" }))
      });
    }
    if (url.pathname === "/api/tools") {
      if (!mcpState.client) await connectMcp(DEFAULT_MCP_URL);
      return json(res, 200, {
        endpoint: mcpState.endpoint,
        tools: mcpState.tools.map((tool) => ({
          name: tool.name,
          description: tool.description || tool.title || "",
          inputSchema: tool.inputSchema || {}
        }))
      });
    }
    if (url.pathname === "/api/call-tool" && req.method === "POST") {
      if (!mcpState.client) await connectMcp(DEFAULT_MCP_URL);
      const body = await readJson(req);
      const started = Date.now();
      const result = await mcpState.client.callTool({ name: body.name, arguments: body.arguments || {} });
      return json(res, 200, {
        ok: !result.isError,
        ms: Date.now() - started,
        result
      });
    }
    if (url.pathname === "/api/chat" && req.method === "POST") {
      const body = await readJson(req);
      if (!body.message) throw new Error("message is required");
      const result = await chatWithTools({ message: body.message, model: body.model || DEFAULT_MODEL });
      return json(res, 200, result);
    }
    if (url.pathname === "/api/events") {
      return json(res, 200, { events: toolEvents.slice(-100) });
    }
    return json(res, 404, { error: "Not found" });
  } catch (error) {
    return json(res, 500, { error: error?.message || String(error) });
  }
}

async function serveStatic(res, pathname) {
  const file = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const full = resolve(PUBLIC_ROOT, file);
  const rel = relative(PUBLIC_ROOT, full);
  if (isAbsolute(rel) || rel.startsWith("..") || !existsSync(full)) {
    return text(res, 404, "Not found");
  }
  const type = full.endsWith(".html") ? "text/html; charset=utf-8" :
    full.endsWith(".css") ? "text/css; charset=utf-8" :
      full.endsWith(".js") ? "text/javascript; charset=utf-8" :
        "application/octet-stream";
  text(res, 200, await readFile(full), type);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
  return serveStatic(res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Local Agent Client MVP listening on http://${HOST}:${PORT}`);
  console.log(`MCP endpoint default: ${DEFAULT_MCP_URL}`);
});
