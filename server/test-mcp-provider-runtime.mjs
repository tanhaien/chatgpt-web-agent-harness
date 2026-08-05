import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createMcpProviderRuntime,
  classifyMcpToolRisk,
  classifyMcpToolCapabilities
} from "./mcp-provider-runtime.mjs";

const temp = await mkdtemp(path.join(os.tmpdir(), "lca-mcp-runtime-"));
const configPath = path.join(temp, "opencode.json");
await writeFile(configPath, JSON.stringify({
  mcp: {
    "tool-attention": { type: "local", command: ["attention"] },
    contextplus: { type: "local", command: ["contextplus"] },
    lightpanda: { type: "local", command: ["lightpanda"] },
    broken: { type: "local", command: ["broken"] }
  }
}), "utf8");

const closed = [];
const calls = [];
const tools = {
  "tool-attention": [
    { name: "tool_attention.rank_tools", description: "Rank tools", inputSchema: { type: "object" } },
    { name: "tool_attention.health", description: "Health", inputSchema: { type: "object" } }
  ],
  contextplus: [
    { name: "get_blast_radius", description: "Trace symbol callers and affected files", inputSchema: { type: "object" } }
  ],
  lightpanda: [
    { name: "markdown", description: "Read page as markdown", inputSchema: { type: "object" } },
    { name: "click", description: "Click an element in the browser", inputSchema: { type: "object" } }
  ]
};

const runtime = createMcpProviderRuntime({
  workspace: temp,
  configPath,
  allowlist: ["tool-attention", "contextplus", "lightpanda", "broken"],
  startupTimeoutMs: 2_000,
  defaultTimeoutMs: 2_000,
  clientFactory: async ({ providerId }) => {
    if (providerId === "broken") throw new Error("fixture provider failed");
    return {
      listTools: async () => ({ tools: tools[providerId] }),
      callTool: async ({ name, arguments: args }) => {
        calls.push({ providerId, name, args: structuredClone(args) });
        if (name === "tool_attention.rank_tools") {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                query: args.query,
                ranked_tools: [
                  { id: "contextplus/get_blast_radius", score: 0.98, reason: "matches callers and impact", confidence: "high" },
                  { id: "lightpanda/markdown", score: 0.25, reason: "weak web match", confidence: "low" }
                ],
                inferred: { capability_hints: ["code.intelligence"] }
              })
            }]
          };
        }
        return { structuredContent: { providerId, name, args } };
      },
      close: async () => { closed.push(providerId); }
    };
  }
});

try {
  const snapshot = await runtime.initialize();
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.providerCount, 3);
  assert.equal(snapshot.toolCount, 5);
  assert.equal(snapshot.toolAttention, true);
  assert.equal(snapshot.unavailableProviders.length, 1);
  assert.equal(snapshot.unavailableProviders[0].id, "broken");

  const providers = runtime.listProviders();
  assert.deepEqual(providers.map((provider) => provider.id), ["contextplus", "lightpanda", "tool-attention"]);
  assert.equal(runtime.getTool("lightpanda/click").risk, "risky");
  assert.equal(runtime.getTool("contextplus/get_blast_radius").risk, "read");

  const ranked = await runtime.findTools({ query: "find callers and blast radius", topK: 2, maxRisk: "read" });
  assert.equal(ranked.strategy, "tool-attention");
  assert.deepEqual(ranked.rankedTools.map((tool) => tool.id), ["contextplus/get_blast_radius", "lightpanda/markdown"]);
  assert.equal(ranked.rankedTools[0].ranking.confidence, "high");
  assert.equal(calls[0].providerId, "tool-attention");
  assert.equal(calls[0].name, "tool_attention.rank_tools");
  assert.equal(calls[0].args.tools.some((tool) => tool.id === "lightpanda/click"), false, "maxRisk filter must exclude risky tools before ranking");

  const invoked = await runtime.invoke({
    toolId: "contextplus/get_blast_radius",
    input: { symbol: "authenticateUser" },
    context: { taskId: "task-1", metadata: { test: true } }
  });
  assert.equal(invoked.ok, true);
  assert.equal(invoked.output.providerId, "contextplus");
  assert.equal(invoked.output.args.symbol, "authenticateUser");

  const health = runtime.health();
  assert.equal(health.providers.length, 3);
  assert.equal(health.unavailableProviders[0].id, "broken");

  assert.equal(classifyMcpToolRisk("tool-attention", { name: "tool_attention.pick_tool" }), "read");
  assert.equal(classifyMcpToolRisk("lightpanda", { name: "click" }), "risky");
  assert.equal(classifyMcpToolRisk("codebase-memory-mcp", { name: "memory_upsert" }), "safe-write");
  assert.equal(classifyMcpToolCapabilities("vn-data", { name: "vn_get_quotes", description: "OHLCV market data" }).includes("finance"), true);
} finally {
  await runtime.close();
  await rm(temp, { recursive: true, force: true });
}

assert.deepEqual(closed.sort(), ["contextplus", "lightpanda", "tool-attention"]);
console.log("mcp-provider-runtime: all assertions passed");
