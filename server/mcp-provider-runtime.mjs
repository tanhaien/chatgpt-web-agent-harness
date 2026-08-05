// Multi-MCP provider composition for the Local Coding Agent server.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MultiMcpGateway } from "../packages/mcp-gateway/src/index.mjs";

const DEFAULT_ALLOWLIST = Object.freeze([
  "contextplus",
  "code-review-graph",
  "lightpanda",
  "mempalace",
  "tool-attention",
  "vibe-trading",
  "vn-data",
  "codebase-memory-mcp"
]);

const RISK_ORDER = Object.freeze({ read: 0, "safe-write": 1, risky: 2, critical: 3 });
const MUTATING_RE = /(^|[._-])(add|append|apply|build|cache|checkpoint|clear|create|execute|generate|index|ingest|invalidate|learn|merge|patch|prune|record|remember|rename|replace|restore|save|set|store|sync|update|upsert|write)([._-]|$)/i;
const RISKY_RE = /(^|[._-])(click|delete|drag|drop|fill|press|remove|select|submit|trade|transfer|type|upload)([._-]|$)/i;
const CRITICAL_RE = /(^|[._-])(broadcast|format|liquidate|place_order|send_funds|shutdown|wipe)([._-]|$)/i;
const READ_PREFIX_RE = /^(?:tool_attention[._-])?(get|read|list|search|find|query|inspect|analyze|explain|rank|pick|health|status|preview|diff|trace|lookup)([._-]|$)/i;
const EXPLICIT_MUTATION_RE = /(^|[._-])(add|append|apply|clear|create|delete|execute|fill|index|ingest|invalidate|learn|merge|patch|prune|remove|rename|replace|restore|save|set|store|sync|update|upsert|write)([._-]|$)/i;

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function boundedInteger(value, fallback, min, max, name) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < min || candidate > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return candidate;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function redactErrorText(value) {
  return String(value ?? "")
    .replace(/(bearer\s+)[a-z0-9._~+\/-]+/gi, "$1<redacted>")
    .replace(/((?:api[_-]?key|token|secret|password|authorization|cookie)\s*[:=]\s*)[^\s,;]+/gi, "$1<redacted>")
    .slice(0, 4_000);
}

function sanitizeError(error) {
  const result = {
    name: typeof error?.name === "string" && error.name ? error.name : "Error",
    message: redactErrorText(typeof error?.message === "string" && error.message ? error.message : String(error))
  };
  if (typeof error?.code === "string") result.code = error.code;
  return result;
}

function parseAllowlist(value) {
  if (Array.isArray(value)) return [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))];
  if (typeof value === "string") {
    return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  }
  return [...DEFAULT_ALLOWLIST];
}

function providerCommand(entry) {
  if (Array.isArray(entry.command)) {
    const [command, ...args] = entry.command;
    return { command, args };
  }
  return { command: entry.command, args: Array.isArray(entry.args) ? entry.args : [] };
}

function providerCapabilities(providerId) {
  const values = new Set([`provider.${providerId}`]);
  const id = providerId.toLowerCase();
  if (/contextplus|code-review|codebase-memory/.test(id)) values.add("code.intelligence");
  if (/contextplus|code-review/.test(id)) values.add("code.impact");
  if (/memory|mempalace/.test(id)) values.add("memory");
  if (/lightpanda/.test(id)) values.add("browser");
  if (/trading|vn-data/.test(id)) values.add("finance");
  if (/tool-attention/.test(id)) values.add("routing");
  return [...values];
}

export function classifyMcpToolRisk(providerId, tool) {
  const name = String(tool?.name || "");
  const description = String(tool?.description || "");
  const text = `${name} ${description}`.toLowerCase();
  if (providerId === "tool-attention") return "read";
  if (CRITICAL_RE.test(name) || /send funds|place (an )?order|irreversible|wipe disk/.test(text)) return "critical";
  if (RISKY_RE.test(name) || /browser interaction|mutates? external|delete|remove permanently|submit form/.test(text)) return "risky";
  if (READ_PREFIX_RE.test(name) && !EXPLICIT_MUTATION_RE.test(name)) return "read";
  if (MUTATING_RE.test(name) || /\b(modifies?|mutates?|persists?|writes? (?:a|the|to)|creates? (?:a|the)|updates? (?:a|the)|stores? (?:a|the)|invalidates? (?:a|the))\b/.test(text)) return "safe-write";
  return "read";
}

export function classifyMcpToolCapabilities(providerId, tool) {
  const sourceName = String(tool?.name || "");
  const text = `${sourceName} ${tool?.description || ""}`.toLowerCase();
  const capabilities = new Set(providerCapabilities(providerId));
  capabilities.add(`tool.${sourceName}`);
  if (/symbol|definition|reference|call graph|blast radius|dependency|architecture|code/.test(text)) capabilities.add("code.intelligence");
  if (/review|impact|risk|diff/.test(text)) capabilities.add("code.review");
  if (/memory|remember|recall|knowledge|palace/.test(text)) capabilities.add("memory");
  if (/browser|page|html|markdown|screenshot|navigate|click|fill/.test(text)) capabilities.add("browser");
  if (/stock|quote|market|trading|ohlcv|finance|ticker/.test(text)) capabilities.add("finance");
  if (/rank|pick|routing|attention/.test(text)) capabilities.add("routing");
  const risk = classifyMcpToolRisk(providerId, tool);
  if (risk !== "read") capabilities.add("mutation");
  return [...capabilities].sort();
}

function normalizeTool(providerId, rawTool) {
  const sourceName = assertNonEmptyString(rawTool?.name, "MCP tool name");
  return {
    id: `${providerId}/${sourceName}`,
    providerId,
    sourceName,
    description: typeof rawTool.description === "string" && rawTool.description.trim()
      ? rawTool.description.trim()
      : `MCP tool ${sourceName} from ${providerId}`,
    capabilities: classifyMcpToolCapabilities(providerId, rawTool),
    risk: classifyMcpToolRisk(providerId, rawTool),
    inputSchema: rawTool.inputSchema && typeof rawTool.inputSchema === "object" && !Array.isArray(rawTool.inputSchema)
      ? clone(rawTool.inputSchema)
      : { type: "object" }
  };
}

function textFromContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function parseTextJson(text) {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function normalizeMcpCallResult(result) {
  const text = textFromContent(result?.content);
  if (result?.isError) {
    const error = new Error(text || "MCP provider returned an error");
    error.name = "McpProviderCallError";
    error.code = "MCP_TOOL_ERROR";
    throw error;
  }
  if (result?.structuredContent !== undefined) return { output: clone(result.structuredContent) };
  const parsed = parseTextJson(text);
  if (parsed !== undefined) return { output: parsed };
  return {
    output: {
      text,
      content: clone(result?.content || [])
    }
  };
}

function keywordTokens(value) {
  return [...new Set(String(value || "").toLowerCase().match(/[a-z0-9_.-]{3,}/g) || [])];
}

function fallbackRank(query, tools, topK) {
  const queryTokens = keywordTokens(query);
  return tools
    .map((tool) => {
      const haystack = `${tool.id} ${tool.description} ${tool.capabilities.join(" ")}`.toLowerCase();
      let score = 0;
      for (const token of queryTokens) if (haystack.includes(token)) score += token.length >= 7 ? 3 : 1;
      if (tool.risk === "read") score += 0.25;
      return { tool, score };
    })
    .sort((a, b) => b.score - a.score || a.tool.id.localeCompare(b.tool.id))
    .slice(0, topK)
    .map(({ tool, score }) => ({
      ...clone(tool),
      ranking: {
        score,
        reason: score > 0 ? "keyword and capability match" : "deterministic fallback order",
        confidence: score > 0 ? "medium" : "low"
      }
    }));
}

async function mapLimit(values, limit, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

export function createMcpProviderRuntime(options = {}) {
  assertObject(options, "options");
  const workspace = path.resolve(assertNonEmptyString(options.workspace, "workspace"));
  const configPath = path.resolve(options.configPath || process.env.LCA_MCP_CONFIG_PATH || path.join(os.homedir(), ".config", "opencode", "opencode.json"));
  const allowlist = parseAllowlist(options.allowlist ?? process.env.LCA_MCP_PROVIDER_ALLOWLIST);
  const startupTimeoutMs = boundedInteger(options.startupTimeoutMs, 45_000, 1_000, 180_000, "startupTimeoutMs");
  const defaultTimeoutMs = boundedInteger(options.defaultTimeoutMs, 60_000, 1, 300_000, "defaultTimeoutMs");
  const maxConcurrency = boundedInteger(options.maxConcurrency, 2, 1, 32, "maxConcurrency");
  const startupConcurrency = boundedInteger(options.startupConcurrency, 3, 1, 8, "startupConcurrency");
  const clientFactory = options.clientFactory || defaultClientFactory;
  if (typeof clientFactory !== "function") throw new TypeError("clientFactory must be a function");

  const gateway = new MultiMcpGateway({ defaultTimeoutMs, failureThreshold: 3, cooldownMs: 30_000 });
  const connections = new Map();
  const unavailable = new Map();
  let initialized = false;
  let initializing = null;
  let closed = false;

  async function initialize() {
    if (closed) throw new Error("MCP provider runtime is closed");
    if (initialized) return snapshot();
    if (initializing) return initializing;
    initializing = (async () => {
      let config;
      try {
        config = JSON.parse(await readFile(configPath, "utf8"));
      } catch (error) {
        unavailable.set("config", sanitizeError(error));
        initialized = true;
        return snapshot();
      }
      const configured = assertObject(config.mcp || {}, "OpenCode mcp config");
      await mapLimit(allowlist, startupConcurrency, async (providerId) => {
        const entry = configured[providerId];
        if (!entry || entry.enabled === false) {
          unavailable.set(providerId, { name: "ProviderUnavailableError", message: "provider is missing or disabled in OpenCode config" });
          return;
        }
        try {
          const connection = await withTimeout(
            clientFactory({ providerId, entry: clone(entry), workspace }),
            startupTimeoutMs,
            `provider ${providerId} startup timed out`
          );
          if (!connection || typeof connection.listTools !== "function" || typeof connection.callTool !== "function") {
            throw new TypeError("provider connection must expose listTools and callTool");
          }
          const listed = await withTimeout(connection.listTools(), startupTimeoutMs, `provider ${providerId} listTools timed out`);
          const tools = (listed?.tools || []).map((tool) => normalizeTool(providerId, tool));
          if (tools.length === 0) throw new Error("provider exposed no tools");
          const command = providerCommand(entry);
          gateway.registerProvider({
            definition: {
              id: providerId,
              displayName: providerId,
              transport: "stdio",
              command: [command.command, ...command.args].filter(Boolean).join(" "),
              capabilities: providerCapabilities(providerId),
              trustLevel: "trusted-local"
            },
            tools,
            client: {
              invoke: async ({ tool, input, signal }) => {
                if (signal?.aborted) throw signal.reason || new DOMException("aborted", "AbortError");
                const call = connection.callTool({ name: tool.sourceName, arguments: clone(input) });
                return normalizeMcpCallResult(await raceAbort(call, signal));
              }
            },
            maxConcurrency,
            timeoutMs: defaultTimeoutMs
          });
          connections.set(providerId, connection);
          unavailable.delete(providerId);
        } catch (error) {
          unavailable.set(providerId, sanitizeError(error));
        }
      });
      initialized = true;
      return snapshot();
    })().finally(() => { initializing = null; });
    return initializing;
  }

  function assertReady() {
    if (closed) throw new Error("MCP provider runtime is closed");
    if (!initialized) throw new Error("MCP provider runtime is not initialized");
  }

  function listProviders() {
    assertReady();
    return gateway.listProviders().map((provider) => ({
      id: provider.definition.id,
      displayName: provider.definition.displayName,
      capabilities: clone(provider.definition.capabilities),
      trustLevel: provider.definition.trustLevel,
      health: provider.health,
      circuit: provider.circuit,
      active: provider.active,
      queued: provider.queued,
      toolCount: provider.toolCount,
      totalCalls: provider.totalCalls,
      totalSuccesses: provider.totalSuccesses,
      totalFailures: provider.totalFailures,
      lastFinishedAt: provider.lastFinishedAt
    }));
  }

  function listTools(filter = {}) {
    assertReady();
    return gateway.listTools(clone(filter));
  }

  function getTool(toolId) {
    assertReady();
    assertNonEmptyString(toolId, "toolId");
    try {
      return gateway.resolveTool({ toolId }).tool;
    } catch {
      return null;
    }
  }

  async function findTools(input = {}) {
    assertReady();
    assertObject(input, "findTools input");
    const query = assertNonEmptyString(input.query, "query");
    const topK = boundedInteger(input.topK, 8, 1, 50, "topK");
    const filter = {
      providerId: input.providerId,
      requiredCapabilities: input.requiredCapabilities,
      maxRisk: input.maxRisk,
      includeDegraded: input.includeDegraded ?? false
    };
    for (const key of Object.keys(filter)) if (filter[key] === undefined) delete filter[key];
    const candidates = gateway.listTools(filter).filter((tool) => tool.providerId !== "tool-attention");
    if (candidates.length === 0) return { query, strategy: "none", rankedTools: [] };

    const attentionTool = getTool("tool-attention/tool_attention.rank_tools");
    if (attentionTool) {
      const result = await gateway.invoke({
        toolId: attentionTool.id,
        input: {
          query,
          tools: candidates.map((tool) => ({
            id: tool.id,
            name: tool.sourceName,
            description: tool.description,
            inputs_schema: tool.inputSchema,
            tags: tool.capabilities
          })),
          top_k: Math.min(topK, candidates.length),
          context: { workspace }
        },
        timeoutMs: Math.min(defaultTimeoutMs, 30_000),
        context: { metadata: { purpose: "gateway tool ranking" } }
      });
      if (result.ok) {
        const ranked = Array.isArray(result.output?.ranked_tools) ? result.output.ranked_tools : [];
        const byId = new Map(candidates.map((tool) => [tool.id, tool]));
        const rankedTools = ranked
          .map((item) => {
            const tool = byId.get(item.id);
            if (!tool) return null;
            return {
              ...clone(tool),
              ranking: {
                score: Number(item.score) || 0,
                reason: String(item.reason || "tool-attention ranking"),
                confidence: String(item.confidence || "unknown")
              }
            };
          })
          .filter(Boolean)
          .slice(0, topK);
        if (rankedTools.length) {
          return { query, strategy: "tool-attention", rankedTools, inferred: clone(result.output?.inferred || {}) };
        }
      }
    }
    return { query, strategy: "fallback", rankedTools: fallbackRank(query, candidates, topK) };
  }

  async function invoke(input, options = {}) {
    assertReady();
    assertObject(input, "invoke input");
    const toolId = assertNonEmptyString(input.toolId, "toolId");
    return gateway.invoke({
      toolId,
      input: clone(input.input || {}),
      timeoutMs: input.timeoutMs,
      idempotencyKey: input.idempotencyKey,
      context: clone(input.context || { metadata: {} })
    }, { signal: options.signal });
  }

  function health(providerId) {
    assertReady();
    if (providerId !== undefined) {
      assertNonEmptyString(providerId, "providerId");
      return gateway.getProviderHealth(providerId);
    }
    return {
      providers: listProviders(),
      unavailableProviders: [...unavailable.entries()].map(([id, error]) => ({ id, error: clone(error) }))
    };
  }

  function snapshot() {
    let providers = [];
    let toolCount = 0;
    if (initialized && !closed) {
      providers = listProviders();
      toolCount = providers.reduce((sum, provider) => sum + provider.toolCount, 0);
    }
    return Object.freeze({
      enabled: initialized && !closed && providers.length > 0,
      initialized,
      closed,
      providerCount: providers.length,
      toolCount,
      toolAttention: providers.some((provider) => provider.id === "tool-attention"),
      unavailableProviders: [...unavailable.entries()].map(([id, error]) => ({ id, error: clone(error) }))
    });
  }

  async function close() {
    if (closed) return;
    closed = true;
    gateway.close();
    await Promise.allSettled([...connections.values()].flatMap((connection) => [
      Promise.resolve().then(() => connection.close?.()),
      Promise.resolve().then(() => connection.transport?.close?.())
    ]));
    connections.clear();
  }

  return Object.freeze({ initialize, listProviders, listTools, getTool, findTools, invoke, health, snapshot, close });
}

async function defaultClientFactory({ providerId, entry, workspace }) {
  const { command, args } = providerCommand(entry);
  assertNonEmptyString(command, `provider ${providerId} command`);
  const transport = new StdioClientTransport({
    command,
    args,
    env: { ...process.env, ...(entry.environment || entry.env || {}) },
    cwd: entry.cwd || workspace,
    stderr: "pipe"
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-20_000);
  });
  const client = new Client({ name: `lca-gateway-${providerId}`, version: "1.0.0" });
  try {
    await client.connect(transport);
  } catch (error) {
    error.message = `${error.message}${stderr ? `; stderr: ${stderr.slice(-2_000)}` : ""}`;
    await transport.close().catch(() => {});
    throw error;
  }
  return {
    transport,
    listTools: () => client.listTools(),
    callTool: (request) => client.callTool(request),
    close: () => client.close()
  };
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(message);
        error.name = "TimeoutError";
        reject(error);
      }, timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || new DOMException("aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); }
    );
  });
}
