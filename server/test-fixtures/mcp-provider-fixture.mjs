import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const mode = process.argv[2] || "fixture";
const server = new Server(
  { name: `lca-${mode}-fixture`, version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const attentionTools = [
  {
    name: "tool_attention.rank_tools",
    description: "Rank candidate tools for a query.",
    inputSchema: { type: "object" }
  },
  {
    name: "tool_attention.health",
    description: "Return tool-attention health.",
    inputSchema: { type: "object" }
  }
];
const fixtureTools = [
  {
    name: "read_record",
    description: "Read one fixture record.",
    inputSchema: { type: "object", properties: { id: { type: "string" } } }
  },
  {
    name: "write_record",
    description: "Write or update one fixture record.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, value: {} } }
  },
  {
    name: "delete_record",
    description: "Delete one fixture record permanently.",
    inputSchema: { type: "object", properties: { id: { type: "string" } } }
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: mode === "attention" ? attentionTools : fixtureTools
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments || {};
  if (mode === "attention" && name === "tool_attention.rank_tools") {
    const candidates = Array.isArray(args.tools) ? args.tools : [];
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          query: args.query,
          ranked_tools: candidates.map((tool, index) => ({
            id: tool.id,
            score: 1 - index * 0.1,
            reason: "fixture tool-attention ranking",
            confidence: "high"
          }))
        })
      }]
    };
  }
  if (mode === "attention" && name === "tool_attention.health") {
    return { content: [{ type: "text", text: JSON.stringify({ status: "ok" }) }] };
  }
  if (mode === "fixture" && fixtureTools.some((tool) => tool.name === name)) {
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: true, tool: name, args }) }]
    };
  }
  return {
    isError: true,
    content: [{ type: "text", text: `unknown fixture tool: ${name}` }]
  };
});

await server.connect(new StdioServerTransport());
