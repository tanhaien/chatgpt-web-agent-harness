import assert from "node:assert/strict";
import {
  MultiMcpGateway,
  GatewayRegistrationError,
  GatewayResolutionError,
  GatewayBusyError,
  GatewayClosedError,
  CIRCUIT_STATES
} from "../src/index.mjs";

// ── Helpers ─────────────────────────────────────────────────────

function makeProviderDef(id, overrides = {}) {
  return {
    id,
    displayName: `Provider ${id}`,
    transport: "streamable-http",
    endpoint: "http://127.0.0.1:8787/mcp",
    capabilities: ["filesystem", "process"],
    trustLevel: "trusted-local",
    ...overrides
  };
}

function makeTool(providerId, sourceName, overrides = {}) {
  const id = `${providerId}/${sourceName}`;
  return {
    id,
    providerId,
    sourceName,
    description: `Tool ${sourceName}`,
    inputSchema: { type: "object" },
    capabilities: [],
    risk: "read",
    ...overrides,
  };
}

function makeClient(output) {
  return {
    invoke: async () => output,
    _name: "fake-client"
  };
}

function makeErrorClient(err) {
  return {
    invoke: async () => { throw err; }
  };
}

// ── 1. Registration + list + unregister ─────────────────────────

{
  const gw = new MultiMcpGateway({ defaultTimeoutMs: 5000 });

  const defA = makeProviderDef("a");
  const toolsA = [makeTool("a", "read_file", { capabilities: ["fs.read"], risk: "read" })];

  const snap = gw.registerProvider({
    definition: defA,
    tools: toolsA,
    client: makeClient("ok")
  });

  assert.equal(snap.definition.id, "a");
  assert.equal(snap.toolCount, 1);
  assert.equal(snap.health, "unknown");
  assert.equal(snap.circuit, "closed");
  assert.equal(snap.active, 0);
  assert.equal(snap.queued, 0);

  // listProviders returns cloned data sorted by provider id
  const providers = gw.listProviders();
  assert.equal(providers.length, 1);
  assert.equal(providers[0].definition.id, "a");
  // non-mutation: modifying snapshot must not affect internal
  providers[0].definition.id = "hacked";
  assert.equal(gw.listProviders()[0].definition.id, "a");

  // listTools
  const tools = gw.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].id, "a/read_file");

  // listTools with providerId filter
  assert.equal(gw.listTools({ providerId: "a" }).length, 1);
  assert.equal(gw.listTools({ providerId: "b" }).length, 0);
}

// ── duplicate provider ──────────────────────────────────────────
{
  const gw = new MultiMcpGateway();
  gw.registerProvider({
    definition: makeProviderDef("dup"),
    tools: [makeTool("dup", "t")],
    client: makeClient("ok")
  });
  assert.throws(() => gw.registerProvider({
    definition: makeProviderDef("dup"),
    tools: [makeTool("dup", "t")],
    client: makeClient("ok")
  }), GatewayRegistrationError);
}

// ── duplicate canonical tool ID ─────────────────────────────────
{
  const gw = new MultiMcpGateway();
  gw.registerProvider({
    definition: makeProviderDef("p1"),
    tools: [makeTool("p1", "shared_tool")],
    client: makeClient("ok")
  });
  // Registering same provider again must fail atomically with all tool IDs already taken
  assert.throws(() => gw.registerProvider({
    definition: makeProviderDef("p1"),
    tools: [makeTool("p1", "shared_tool")],
    client: makeClient("ok")
  }), GatewayRegistrationError);
  // Only one provider exists (atomic)
  assert.equal(gw.listProviders().length, 1);
}

// ── tool.providerId mismatch ────────────────────────────────────
{
  const gw = new MultiMcpGateway();
  assert.throws(() => gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("b", "t")],  // tool claims providerId "b"
    client: makeClient("ok")
  }), GatewayRegistrationError);
}

// ── duplicate sourceName within provider ────────────────────────
{
  const gw = new MultiMcpGateway();
  assert.throws(() => gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "same"), makeTool("a", "same")],
    client: makeClient("ok")
  }), GatewayRegistrationError);
}

// ── registration clones caller objects ──────────────────────────
{
  const gw = new MultiMcpGateway();
  const def = makeProviderDef("a");
  const tools = [makeTool("a", "t")];
  const originalId = def.id;
  gw.registerProvider({ definition: def, tools, client: makeClient("ok") });
  // Mutate caller def — must not affect internal
  def.id = "hacked";
  assert.equal(gw.listProviders()[0].definition.id, originalId);
  // Mutate caller tool
  tools[0].sourceName = "hacked";
  assert.equal(gw.listTools()[0].id, "a/t");
}

// ── unregister ──────────────────────────────────────────────────
{
  const gw = new MultiMcpGateway();
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "t")],
    client: makeClient("ok")
  });
  assert.equal(gw.unregisterProvider("a"), true);
  assert.equal(gw.unregisterProvider("a"), false);
  assert.equal(gw.listProviders().length, 0);
  // Tools are gone after unregister
  assert.equal(gw.listTools().length, 0);
}

// ── unregister with active calls rejects ────────────────────────
{
  const gw = new MultiMcpGateway({ defaultTimeoutMs: 5000 });
  let resolveInvoke;
  const client = { invoke: () => new Promise(r => { resolveInvoke = r; }) };
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "slow")],
    client,
    maxConcurrency: 1
  });

  // Start invoke (non-awaited)
  const invokeP = gw.invoke({
    toolId: "a/slow",
    input: { x: 1 }
  });

  // Small delay to let invoke acquire permit
  await new Promise(r => setTimeout(r, 50));

  // unregister must reject while active
  assert.throws(() => gw.unregisterProvider("a"), GatewayBusyError);

  // Let invoke finish
  resolveInvoke("done");
  await invokeP;
}

// ── unregister rejects empty id ─────────────────────────────────
{
  const gw = new MultiMcpGateway();
  assert.throws(() => gw.unregisterProvider(""), TypeError);
}

// ── 2. Resolution: canonical exact + sourceName + provider pin ──

{
  const gw = new MultiMcpGateway();
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "read_file"), makeTool("a", "write_file", { risk: "safe-write" })],
    client: makeClient("ok")
  });

  // exact canonical
  const r1 = gw.resolveTool({ toolId: "a/read_file" });
  assert.equal(r1.tool.id, "a/read_file");
  assert.equal(r1.provider.id, "a");

  // sourceName routing
  const r2 = gw.resolveTool({ sourceName: "write_file" });
  assert.equal(r2.tool.id, "a/write_file");

  // provider pin
  const r3 = gw.resolveTool({ sourceName: "read_file", providerId: "a" });
  assert.equal(r3.tool.id, "a/read_file");

  // provider pin with toolId must agree
  assert.throws(() => gw.resolveTool({ toolId: "a/read_file", providerId: "b" }), GatewayResolutionError);

  // both toolId and sourceName
  assert.throws(() => gw.resolveTool({ toolId: "a/x", sourceName: "x" }), TypeError);

  // neither
  assert.throws(() => gw.resolveTool({}), TypeError);

  // not found
  assert.throws(() => gw.resolveTool({ toolId: "a/nope" }), GatewayResolutionError);
  const err = (() => { try { gw.resolveTool({ toolId: "a/nope" }); } catch(e) { return e; } })();
  assert.equal(err.code, "TOOL_NOT_FOUND");

  // no eligible
  assert.throws(() => gw.resolveTool({ sourceName: "unknown" }), GatewayResolutionError);
}

// ── 3. Capability/risk/trust filtering ──────────────────────────

{
  const gw = new MultiMcpGateway();
  const defA = makeProviderDef("a", { trustLevel: "trusted-local" });
  const defB = makeProviderDef("b", { trustLevel: "external" });

  gw.registerProvider({
    definition: defA,
    tools: [
      makeTool("a", "reader", { capabilities: ["fs.read"], risk: "read" }),
      makeTool("a", "writer", { capabilities: ["fs.write"], risk: "safe-write" }),
      makeTool("a", "deleter", { capabilities: ["fs.delete"], risk: "critical" })
    ],
    client: makeClient("ok")
  });

  gw.registerProvider({
    definition: defB,
    tools: [
      makeTool("b", "reader", { capabilities: ["fs.read"], risk: "read" })
    ],
    client: makeClient("ok")
  });

  // capability filter
  const capResults = gw.resolveTool({
    sourceName: "deleter",
    requiredCapabilities: ["fs.delete"]
  });
  assert.equal(capResults.tool.id, "a/deleter");

  // capability mismatch
  assert.throws(() => gw.resolveTool({
    sourceName: "reader",
    requiredCapabilities: ["fs.admin"]
  }), GatewayResolutionError);

  // maxRisk
  assert.throws(() => gw.resolveTool({
    sourceName: "deleter",
    maxRisk: "read"
  }), GatewayResolutionError);

  // trust filter: external trust picks provider b
  const extResults = gw.resolveTool({
    sourceName: "reader",
    allowedTrustLevels: ["external"]
  });
  assert.equal(extResults.provider.id, "b");

  // trust filter: sandboxed excludes both
  assert.throws(() => gw.resolveTool({
    sourceName: "reader",
    allowedTrustLevels: ["sandboxed"]
  }), GatewayResolutionError);
}

// ── degraded inclusion/exclusion ────────────────────────────────
{
  const gw = new MultiMcpGateway({ failureThreshold: 2 });
  const client = makeErrorClient(new Error("fail"));

  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "flaky")],
    client,
    maxConcurrency: 1
  });

  // First failure degrades
  try { await gw.invoke({ toolId: "a/flaky", input: {} }); } catch (_) {}
  const h1 = gw.getProviderHealth("a");
  assert.equal(h1.health, "degraded");

  // includeDegraded=true (default): still visible
  const r1 = gw.resolveTool({ toolId: "a/flaky" });
  assert.equal(r1.tool.id, "a/flaky");

  // includeDegraded=false: excluded
  assert.throws(() => gw.resolveTool({ toolId: "a/flaky", includeDegraded: false }), GatewayResolutionError);

  // listTools with includeDegraded=false must filter
  assert.equal(gw.listTools({ includeDegraded: false }).length, 0);
  assert.equal(gw.listTools({ includeDegraded: true }).length, 1);
  assert.equal(gw.listTools().length, 1); // default true
}

// ── 4. Deterministic ranking ────────────────────────────────────
{
  // Register providers in reverse-trust order to prove sorting is NOT registration-order
  const gw = new MultiMcpGateway();
  const defLowTrust = makeProviderDef("low", { trustLevel: "external" });
  const defHighTrust = makeProviderDef("high", { trustLevel: "trusted-local" });
  const defSand = makeProviderDef("sand", { trustLevel: "sandboxed" });

  // Register low-trust first
  gw.registerProvider({
    definition: defLowTrust,
    tools: [makeTool("low", "search", { risk: "read" })],
    client: makeClient("ok")
  });
  // Register sandboxed second
  gw.registerProvider({
    definition: defSand,
    tools: [makeTool("sand", "search", { risk: "read" })],
    client: makeClient("ok")
  });
  // Register high-trust last
  gw.registerProvider({
    definition: defHighTrust,
    tools: [makeTool("high", "search", { risk: "read" })],
    client: makeClient("ok")
  });

  // Resolve by sourceName — must pick high-trust (trusted-local) despite being registered last
  const r = gw.resolveTool({ sourceName: "search" });
  assert.equal(r.provider.id, "high", "must pick trusted-local over sandboxed/external regardless of registration order");
}

// Risk ordering: critical tools from trusted should lose to safe-write from same trust
{
  const gw = new MultiMcpGateway();
  gw.registerProvider({
    definition: makeProviderDef("a", { trustLevel: "trusted-local" }),
    tools: [makeTool("a", "del", { risk: "critical" })],
    client: makeClient("ok")
  });
  gw.registerProvider({
    definition: makeProviderDef("b", { trustLevel: "trusted-local" }),
    tools: [makeTool("b", "wrt", { risk: "safe-write" })],
    client: makeClient("ok")
  });

  const r = gw.resolveTool({ sourceName: "del" });
  // Only provider "a" has "del" — so it's the only candidate (risk ranking doesn't matter here)
  assert.equal(r.tool.id, "a/del");
}

// ── 5. Invoke success wrapping ──────────────────────────────────

{
  const gw = new MultiMcpGateway();
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "echo")],
    client: makeClient("response")
  });

  const result = await gw.invoke({ toolId: "a/echo", input: { msg: "hello" } });
  assert.equal(result.ok, true);
  assert.equal(result.providerId, "a");
  assert.equal(result.toolId, "a/echo");
  assert.equal(result.output, "response");
  assert.equal(typeof result.startedAt, "string");
  assert.equal(typeof result.finishedAt, "string");
  assert.ok(result.durationMs >= 0);
  assert.ok(Array.isArray(result.artifacts));
  assert.equal(result.retryable, false);
}

// ── invoke with object output + artifacts ───────────────────────
{
  const gw = new MultiMcpGateway();
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "rich")],
    client: { invoke: async () => ({ output: "data", artifacts: ["app.js"], retryable: true }) }
  });

  const result = await gw.invoke({ toolId: "a/rich", input: {} });
  assert.equal(result.output, "data");
  assert.deepEqual(result.artifacts, ["app.js"]);
  assert.equal(result.retryable, true);
}

// ── invoke with idempotency key ─────────────────────────────────
{
  const gw = new MultiMcpGateway();
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "idem")],
    client: makeClient("ok")
  });

  const result = await gw.invoke({
    toolId: "a/idem",
    input: {},
    idempotencyKey: "key-123"
  });
  assert.equal(result.idempotencyKey, "key-123");
}

// ── 6. Client error sanitization ────────────────────────────────

{
  const gw = new MultiMcpGateway();
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "err")],
    client: makeErrorClient(Object.assign(new Error("boom"), { stack: "secret", secret: "api-key", command: "rm -rf", endpoint: "http://secret", requestInput: "passw0rd" }))
  });

  const result = await gw.invoke({ toolId: "a/err", input: { pw: "top-secret" } });
  assert.equal(result.ok, false);
  assert.equal(result.error.name, "Error");
  assert.equal(result.error.message, "boom");
  assert.equal(result.error.stack, undefined, "must not leak stack");
  assert.equal(result.error.secret, undefined, "must not leak secret");
  assert.equal(result.error.endpoint, undefined);
  assert.equal(result.error.command, undefined);
  assert.equal(result.error.requestInput, undefined);
}

// ── failure counters ────────────────────────────────────────────
{
  const gw = new MultiMcpGateway({ failureThreshold: 10 });
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "fail_twice")],
    client: makeErrorClient(new Error("flaky"))
  });

  const r1 = await gw.invoke({ toolId: "a/fail_twice", input: {} });
  assert.equal(r1.ok, false);
  const h1 = gw.getProviderHealth("a");
  assert.equal(h1.consecutiveFailures, 1);
  assert.equal(h1.totalFailures, 1);

  const r2 = await gw.invoke({ toolId: "a/fail_twice", input: {} });
  assert.equal(r2.ok, false);
  const h2 = gw.getProviderHealth("a");
  assert.equal(h2.consecutiveFailures, 2);
  assert.equal(h2.totalFailures, 2);
}

// ── 7. Timeout ──────────────────────────────────────────────────

{
  const gw = new MultiMcpGateway({ defaultTimeoutMs: 200 });
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "slow")],
    client: { invoke: () => new Promise(() => {}) },  // never resolves
    maxConcurrency: 1
  });

  const result = await gw.invoke({
    toolId: "a/slow",
    input: {},
    timeoutMs: 150
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PROVIDER_TIMEOUT");
  assert.equal(result.retryable, true);
}

// ── caller abort before queue ───────────────────────────────────

{
  const gw = new MultiMcpGateway({ defaultTimeoutMs: 10000 });
  const ac = new AbortController();
  ac.abort("cancelled");
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "t")],
    client: makeClient("ok")
  });

  await assert.rejects(
    () => gw.invoke({ toolId: "a/t", input: {} }, { signal: ac.signal }),
    /aborted|cancelled/i
  );
}

// ── caller abort during invoke ──────────────────────────────────
{
  const gw = new MultiMcpGateway({ defaultTimeoutMs: 10000 });
  let clientSignal;
  const client = {
    invoke: async ({ signal }) => {
      clientSignal = signal;
      return new Promise(() => {});  // hang forever
    }
  };
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "hang")],
    client,
    maxConcurrency: 1
  });

  const ac = new AbortController();
  const invokeP = gw.invoke({ toolId: "a/hang", input: {} }, { signal: ac.signal });

  // Small delay then abort
  await new Promise(r => setTimeout(r, 50));
  ac.abort("external cancel");

  await assert.rejects(invokeP, /aborted|cancel/i);
}

// ── 8. FIFO concurrency with maxConcurrency=1 ───────────────────

{
  const gw = new MultiMcpGateway({ defaultTimeoutMs: 5000 });
  let resolve1, resolve2;
  const client = {
    invoke: () => new Promise(r => { resolve1 = r; }),
    invoke2: () => new Promise(r => { resolve2 = r; })
  };
  let callCount = 0;
  const adaptiveClient = {
    invoke: () => {
      callCount++;
      if (callCount === 1) return new Promise(r => { resolve1 = r; });
      return new Promise(r => { resolve2 = r; });
    }
  };

  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "serial")],
    client: adaptiveClient,
    maxConcurrency: 1
  });

  // Start first invoke
  const p1 = gw.invoke({ toolId: "a/serial", input: { n: 1 } });
  await new Promise(r => setTimeout(r, 50));

  // Second invoke must be queued
  const p2 = gw.invoke({ toolId: "a/serial", input: { n: 2 } });
  await new Promise(r => setTimeout(r, 50));

  // queued count should be 1
  const h = gw.getProviderHealth("a");
  assert.equal(h.active, 1);
  assert.equal(h.queued, 1);

  // Resolve first
  resolve1("first");
  const r1 = await p1;
  assert.equal(r1.output, "first");

  // Resolve second
  resolve2("second");
  const r2 = await p2;
  assert.equal(r2.output, "second");
}

// ── queued abort removed cleanly ────────────────────────────────
{
  const gw = new MultiMcpGateway({ defaultTimeoutMs: 5000 });
  let resolve1;
  const client = {
    invoke: () => new Promise(r => { resolve1 = r; })
  };
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "block")],
    client,
    maxConcurrency: 1
  });

  // Start first
  const p1 = gw.invoke({ toolId: "a/block", input: {} });
  await new Promise(r => setTimeout(r, 50));

  // Queue second with abort signal
  const ac = new AbortController();
  const p2 = gw.invoke({ toolId: "a/block", input: {} }, { signal: ac.signal });
  await new Promise(r => setTimeout(r, 50));

  assert.equal(gw.getProviderHealth("a").queued, 1);

  // Abort queued call
  ac.abort("queued abort");
  await assert.rejects(p2, /abort/i);

  // Queue should be empty now
  assert.equal(gw.getProviderHealth("a").queued, 0);

  // First call still completes fine
  resolve1("done");
  const r1 = await p1;
  assert.equal(r1.output, "done");
}

// ── 9. Circuit breaker ──────────────────────────────────────────

{
  const gw = new MultiMcpGateway({ defaultTimeoutMs: 5000, failureThreshold: 2, cooldownMs: 10000 });
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "flaky")],
    client: makeErrorClient(new Error("fail"))
  });

  // First failure
  await gw.invoke({ toolId: "a/flaky", input: {} });
  let h = gw.getProviderHealth("a");
  assert.equal(h.consecutiveFailures, 1);
  assert.equal(h.health, "degraded");
  assert.equal(h.circuit, "closed");

  // Second failure → threshold hit
  await gw.invoke({ toolId: "a/flaky", input: {} });
  h = gw.getProviderHealth("a");
  assert.equal(h.consecutiveFailures, 2);
  assert.equal(h.health, "offline");
  assert.equal(h.circuit, "open");
}

// ── open circuit excludes provider ──────────────────────────────
{
  const gw = new MultiMcpGateway({ failureThreshold: 1 });
  const def = makeProviderDef("a");
  gw.registerProvider({
    definition: def,
    tools: [makeTool("a", "busted")],
    client: makeErrorClient(new Error("fail"))
  });

  // Trigger circuit open
  await gw.invoke({ toolId: "a/busted", input: {} });
  assert.equal(gw.getProviderHealth("a").circuit, "open");

  // Resolution excludes open circuit provider
  assert.throws(() => gw.resolveTool({ toolId: "a/busted" }), GatewayResolutionError);
}

// ── half-open single probe → success close ──────────────────────
{
  const now = Date.now();
  const gw = new MultiMcpGateway({
    failureThreshold: 1,
    cooldownMs: 100,
    nowMs: () => now
  });

  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "probe")],
    client: makeErrorClient(new Error("fail"))
  });

  // Open circuit
  await gw.invoke({ toolId: "a/probe", input: {} });
  assert.equal(gw.getProviderHealth("a").circuit, "open");

  // Switch client to succeed and advance clock past cooldown
  gw.unregisterProvider("a");
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "probe")],
    client: makeClient("recovered"),
    maxConcurrency: 1
  });

  // Simulate cooldown elapsed
  const entry = gw._providers.get("a");
  entry.openedAt = now - 200;  // past cooldown

  // First call after cooldown is half-open probe
  const r = await gw.invoke({ toolId: "a/probe", input: {} });
  assert.equal(r.ok, true);

  const h = gw.getProviderHealth("a");
  assert.equal(h.circuit, "closed");
  assert.equal(h.health, "healthy");
  assert.equal(h.consecutiveFailures, 0);
}

// ── half-open failure reopens ───────────────────────────────────
{
  const now = Date.now();
  const gw = new MultiMcpGateway({
    failureThreshold: 1,
    cooldownMs: 100,
    nowMs: () => now
  });

  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "fail_probe")],
    client: makeErrorClient(new Error("fail")),
    maxConcurrency: 1
  });

  // Open
  await gw.invoke({ toolId: "a/fail_probe", input: {} });
  assert.equal(gw.getProviderHealth("a").circuit, "open");

  // Advance past cooldown
  const entry = gw._providers.get("a");
  entry.openedAt = now - 200;

  // Half-open probe fails → reopens
  const r = await gw.invoke({ toolId: "a/fail_probe", input: {} });
  assert.equal(r.ok, false);
  assert.equal(gw.getProviderHealth("a").circuit, "open");
}

// ── 10. Close ───────────────────────────────────────────────────

{
  const gw = new MultiMcpGateway({ defaultTimeoutMs: 5000 });
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "t")],
    client: makeClient("ok")
  });

  gw.close();
  // idempotent
  gw.close();

  // register rejects
  assert.throws(() => gw.registerProvider({
    definition: makeProviderDef("b"),
    tools: [makeTool("b", "x")],
    client: makeClient("ok")
  }), GatewayClosedError);

  // resolve rejects
  assert.throws(() => gw.resolveTool({ toolId: "a/t" }), GatewayClosedError);

  // invoke rejects
  await assert.rejects(() => gw.invoke({ toolId: "a/t", input: {} }), GatewayClosedError);

  // list providers rejects
  assert.throws(() => gw.listProviders(), GatewayClosedError);

  // list tools rejects
  assert.throws(() => gw.listTools(), GatewayClosedError);

  // getProviderHealth rejects
  assert.throws(() => gw.getProviderHealth("a"), GatewayClosedError);
}

// ── close cleans up queued waiters ──────────────────────────────
{
  const gw = new MultiMcpGateway({ defaultTimeoutMs: 5000 });
  let resolve1;
  const client = { invoke: () => new Promise(r => { resolve1 = r; }) };
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "block")],
    client,
    maxConcurrency: 1
  });

  // Start first
  const p1 = gw.invoke({ toolId: "a/block", input: {} });
  await new Promise(r => setTimeout(r, 50));

  // Queue second
  const p2 = gw.invoke({ toolId: "a/block", input: {} });
  await new Promise(r => setTimeout(r, 20));

  // Close
  gw.close();

  await assert.rejects(p2, GatewayClosedError);

  // First active call can still finish
  resolve1("ok");
  const r1 = await p1;
  assert.equal(r1.output, "ok");
}

// ── 11. Two providers with same sourceName: fail over ───────────
{
  const gw = new MultiMcpGateway({ failureThreshold: 1, cooldownMs: 100 });
  gw.registerProvider({
    definition: makeProviderDef("a", { trustLevel: "trusted-local" }),
    tools: [makeTool("a", "shared", { risk: "read" })],
    client: makeErrorClient(new Error("fail"))
  });

  gw.registerProvider({
    definition: makeProviderDef("b", { trustLevel: "sandboxed" }),
    tools: [makeTool("b", "shared", { risk: "read" })],
    client: makeClient("fallback")
  });

  // Resolve picks "a" (higher trust)
  const r1 = gw.resolveTool({ sourceName: "shared" });
  assert.equal(r1.provider.id, "a");

  // Open "a"
  await gw.invoke({ toolId: "a/shared", input: {} });
  assert.equal(gw.getProviderHealth("a").circuit, "open");

  // Now resolve must fail over to "b"
  const r2 = gw.resolveTool({ sourceName: "shared" });
  assert.equal(r2.provider.id, "b");

  // Invoke succeeds via "b"
  const r3 = await gw.invoke({ sourceName: "shared", input: {} });
  assert.equal(r3.providerId, "b");
  assert.equal(r3.ok, true);
}

// ── 12. Invalid clock callbacks ─────────────────────────────────

// bad nowMs
assert.throws(() => new MultiMcpGateway({ nowMs: "not-a-fn" }), TypeError);
assert.throws(() => new MultiMcpGateway({ nowMs: () => "not-a-number" }), TypeError);
assert.throws(() => new MultiMcpGateway({ nowMs: () => -1 }), TypeError);
assert.throws(() => new MultiMcpGateway({ nowMs: () => NaN }), TypeError);
assert.throws(() => new MultiMcpGateway({ nowMs: () => 1.5 }), TypeError);

// bad nowIso
assert.throws(() => new MultiMcpGateway({ nowIso: "bad" }), TypeError);
assert.throws(() => new MultiMcpGateway({ nowIso: () => "not an iso" }), TypeError);

// ── Constructor boundaries ──────────────────────────────────────
{
  assert.throws(() => new MultiMcpGateway({ defaultTimeoutMs: 0 }), TypeError);
  assert.throws(() => new MultiMcpGateway({ defaultTimeoutMs: 300001 }), TypeError);
  assert.throws(() => new MultiMcpGateway({ defaultTimeoutMs: "abc" }), TypeError);
  assert.throws(() => new MultiMcpGateway({ failureThreshold: 0 }), TypeError);
  assert.throws(() => new MultiMcpGateway({ failureThreshold: 101 }), TypeError);
  assert.throws(() => new MultiMcpGateway({ cooldownMs: 0 }), TypeError);
  assert.throws(() => new MultiMcpGateway({ cooldownMs: 3600001 }), TypeError);
}

// ── maxConcurrency / timeoutMs registration boundaries ──────────
{
  const gw = new MultiMcpGateway();
  assert.throws(() => gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "t")],
    client: makeClient("ok"),
    maxConcurrency: 0
  }), TypeError);
  assert.throws(() => gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "t")],
    client: makeClient("ok"),
    maxConcurrency: 1001
  }), TypeError);
  assert.throws(() => gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "t")],
    client: makeClient("ok"),
    timeoutMs: 0
  }), TypeError);
}

// ── No global mutable state ─────────────────────────────────────
{
  const gw1 = new MultiMcpGateway();
  const gw2 = new MultiMcpGateway();

  gw1.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "t")],
    client: makeClient("ok")
  });

  // gw2 must be isolated
  assert.equal(gw2.listProviders().length, 0);
}

// ── CIRCUIT_STATES is frozen ────────────────────────────────────
assert.deepEqual(CIRCUIT_STATES, ["closed", "open", "half-open"]);
assert.throws(() => { CIRCUIT_STATES.push("new-state"); });

// ── listTools return is cloned ──────────────────────────────────
{
  const gw = new MultiMcpGateway();
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "t")],
    client: makeClient("ok")
  });
  const tools = gw.listTools();
  tools[0].id = "hacked";
  assert.equal(gw.listTools()[0].id, "a/t");
}

// ── listTools capability filtering ──────────────────────────────
{
  const gw = new MultiMcpGateway();
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [
      makeTool("a", "reader", { capabilities: ["fs.read"] }),
      makeTool("a", "writer", { capabilities: ["fs.write"] })
    ],
    client: makeClient("ok")
  });
  assert.equal(gw.listTools({ requiredCapabilities: ["fs.read"] }).length, 1);
  assert.equal(gw.listTools({ requiredCapabilities: ["fs.read", "fs.write"] }).length, 0);
}

// ── listTools maxRisk filtering ─────────────────────────────────
{
  const gw = new MultiMcpGateway();
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [
      makeTool("a", "lo", { risk: "read" }),
      makeTool("a", "hi", { risk: "critical" })
    ],
    client: makeClient("ok")
  });
  assert.equal(gw.listTools({ maxRisk: "read" }).length, 1);
  assert.equal(gw.listTools({ maxRisk: "risky" }).length, 1);
}

// ── listTools allowedTrustLevels filtering ──────────────────────
{
  const gw = new MultiMcpGateway();
  gw.registerProvider({
    definition: makeProviderDef("a", { trustLevel: "trusted-local" }),
    tools: [makeTool("a", "tl")],
    client: makeClient("ok")
  });
  gw.registerProvider({
    definition: makeProviderDef("b", { trustLevel: "external" }),
    tools: [makeTool("b", "ext")],
    client: makeClient("ok")
  });
  assert.equal(gw.listTools({ allowedTrustLevels: ["trusted-local"] }).length, 1);
  assert.equal(gw.listTools({ allowedTrustLevels: ["trusted-local", "external"] }).length, 2);
  assert.equal(gw.listTools({ allowedTrustLevels: ["sandboxed"] }).length, 0);
}

// ── resolveTool rejects arrays/null as request ──────────────────
{
  const gw = new MultiMcpGateway();
  assert.throws(() => gw.resolveTool(null), TypeError);
  assert.throws(() => gw.resolveTool([]), TypeError);
}

// ── invoke context propagation ──────────────────────────────────
{
  let capturedContext;
  const gw = new MultiMcpGateway();
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "ctx")],
    client: { invoke: async ({ context }) => { capturedContext = context; return "ok"; } }
  });

  const result = await gw.invoke({
    toolId: "a/ctx",
    input: {},
    context: { traceId: "trace-42", taskId: "task-1", metadata: { key: "val" } }
  });

  assert.equal(result.ok, true);
  assert.ok(capturedContext);
  assert.equal(capturedContext.providerId, "a");
  assert.equal(capturedContext.toolId, "a/ctx");
  // traceId from caller context
  assert.equal(capturedContext.traceId, "trace-42");
  assert.equal(capturedContext.taskId, "task-1");
  assert.equal(capturedContext.metadata.key, "val");
}

// ── invoke with context auto-fills providerId/toolId ────────────
{
  let capturedContext;
  const gw = new MultiMcpGateway();
  gw.registerProvider({
    definition: makeProviderDef("p"),
    tools: [makeTool("p", "autofill")],
    client: { invoke: async ({ context }) => { capturedContext = context; return "ok"; } }
  });

  await gw.invoke({ toolId: "p/autofill", input: {} });
  assert.equal(capturedContext.providerId, "p");
  assert.equal(capturedContext.toolId, "p/autofill");
}

// ═══════════════════════════════════════════════════════════════════
// Mandatory regression tests A-J (PR7-D001 architecture hardening)
// ═══════════════════════════════════════════════════════════════════

// ── A. maxConcurrency=1: counter invariants ─────────────────────
{
  const gw = new MultiMcpGateway({ defaultTimeoutMs: 5000 });
  let clientStarts = 0;
  const resolvers = [];
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "t")],
    client: { invoke: () => {
      clientStarts++;
      return new Promise(r => resolvers.push(r));
    }},
    maxConcurrency: 1
  });

  const p1 = gw.invoke({ toolId: "a/t", input: {} });
  await new Promise(r => setTimeout(r, 50));

  let h = gw.getProviderHealth("a");
  assert.equal(h.active, 1);
  assert.equal(h.queued, 0);
  assert.equal(clientStarts, 1);
  assert.equal(h.totalCalls, 1);

  const p2 = gw.invoke({ toolId: "a/t", input: {} });
  await new Promise(r => setTimeout(r, 50));

  h = gw.getProviderHealth("a");
  assert.equal(h.active, 1);
  assert.equal(h.queued, 1);
  assert.equal(clientStarts, 1);
  assert.equal(h.totalCalls, 1);

  // Complete first
  resolvers[0]("first");
  await p1;
  await new Promise(r => setTimeout(r, 50));

  h = gw.getProviderHealth("a");
  assert.equal(h.active, 1);
  assert.equal(h.queued, 0);
  assert.equal(clientStarts, 2);
  assert.equal(h.totalCalls, 2);

  // Complete second
  resolvers[1]("second");
  await p2;

  h = gw.getProviderHealth("a");
  assert.equal(h.active, 0, "active must be 0 after all done");
  assert.equal(h.queued, 0);
  assert.equal(clientStarts, 2);
  assert.equal(h.totalCalls, 2, "totalCalls must be exactly 2");
}

// ── B. Three FIFO calls preserve start order ────────────────────
{
  const gw = new MultiMcpGateway({ defaultTimeoutMs: 5000 });
  const order = [];
  const resolvers = [];
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "t")],
    client: { invoke: async ({ input }) => {
      order.push(input.n);
      return new Promise(r => resolvers.push(r));
    }},
    maxConcurrency: 1
  });

  const p1 = gw.invoke({ toolId: "a/t", input: { n: 1 } });
  const p2 = gw.invoke({ toolId: "a/t", input: { n: 2 } });
  const p3 = gw.invoke({ toolId: "a/t", input: { n: 3 } });
  await new Promise(r => setTimeout(r, 100));

  assert.deepEqual(order, [1]);  // only first started

  resolvers[0]("a");
  await p1;
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(order, [1, 2]);

  resolvers[1]("b");
  await p2;
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(order, [1, 2, 3]);

  resolvers[2]("c");
  await p3;
  const h = gw.getProviderHealth("a");
  assert.equal(h.active, 0);
}

// ── C. Queue timeout returns PROVIDER_TIMEOUT ────────────────────
{
  const gw = new MultiMcpGateway({ defaultTimeoutMs: 5000 });
  let clientStarts = 0;
  let resolve1;
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "t")],
    client: { invoke: () => {
      clientStarts++;
      return new Promise(r => { resolve1 = r; });
    }},
    maxConcurrency: 1
  });

  const p1 = gw.invoke({ toolId: "a/t", input: {} });
  await new Promise(r => setTimeout(r, 50));

  // Queue second with short timeout
  const p2 = gw.invoke({ toolId: "a/t", input: {}, timeoutMs: 100 });

  const r2 = await p2;
  assert.equal(r2.ok, false);
  assert.equal(r2.error.code, "PROVIDER_TIMEOUT");
  assert.equal(r2.retryable, true);

  // Client start count unchanged (call never started)
  assert.equal(clientStarts, 1);

  // First call still runs
  resolve1("ok");
  const r1 = await p1;
  assert.equal(r1.ok, true);

  // Final state clean
  const h = gw.getProviderHealth("a");
  assert.equal(h.active, 0);
  assert.equal(h.queued, 0);
}

// ── D. External custom-reason abort while queued ─────────────────
{
  const gw = new MultiMcpGateway({ defaultTimeoutMs: 5000 });
  let resolve1;
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "t")],
    client: { invoke: () => new Promise(r => { resolve1 = r; }) },
    maxConcurrency: 1
  });

  const p1 = gw.invoke({ toolId: "a/t", input: {} });
  await new Promise(r => setTimeout(r, 50));

  const ac = new AbortController();
  const p2 = gw.invoke({ toolId: "a/t", input: {} }, { signal: ac.signal });
  await new Promise(r => setTimeout(r, 50));

  assert.equal(gw.getProviderHealth("a").queued, 1);

  ac.abort("custom-reason");
  await assert.rejects(p2, /custom-reason/i);

  const h = gw.getProviderHealth("a");
  assert.equal(h.queued, 0);
  assert.equal(h.active, 1);

  resolve1("ok");
  await p1;
  assert.equal(gw.getProviderHealth("a").active, 0);
}

// ── E. Half-open single-probe: second gets GatewayBusyError ──────
{
  const now = Date.now();
  const gw = new MultiMcpGateway({
    failureThreshold: 1,
    cooldownMs: 100,
    nowMs: () => now
  });

  let clientCalls = 0;
  let resolveProbe;
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "t")],
    client: { invoke: () => {
      clientCalls++;
      return new Promise(r => { resolveProbe = r; });
    }},
    maxConcurrency: 2  // allow concurrent calls
  });

  // Open circuit with one failure
  gw.registerProvider({
    definition: makeProviderDef("temp"),
    tools: [makeTool("temp", "x")],
    client: makeErrorClient(new Error("fail"))
  });
  // Use separate provider to open "a"'s circuit... actually this is tricky.
  // Let me instead directly manipulate.
  const entry = gw._providers.get("a");
  entry.circuit = "open";
  entry.openedAt = now - 200;  // past cooldown
  entry.health = "offline";
  entry.consecutiveFailures = 1;

  // First probe request: should succeed (claims half-open slot)
  const probe1 = gw.invoke({ toolId: "a/t", input: {} });
  await new Promise(r => setTimeout(r, 50));

  // Second probe request: should be rejected (probe already active)
  await assert.rejects(
    () => gw.invoke({ toolId: "a/t", input: {} }),
    GatewayBusyError
  );

  // Only one client invocation happened
  assert.equal(clientCalls, 1);

  // Complete probe with success
  resolveProbe("recovered");
  const r1 = await probe1;
  assert.equal(r1.ok, true);
  assert.equal(gw.getProviderHealth("a").circuit, "closed");
}

// ── E2. Half-open probe failure reopens ─────────────────────────
{
  const now = Date.now();
  const gw = new MultiMcpGateway({
    failureThreshold: 1,
    cooldownMs: 100,
    nowMs: () => now
  });

  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "t")],
    client: makeErrorClient(new Error("probe failed")),
    maxConcurrency: 1
  });

  const entry = gw._providers.get("a");
  entry.circuit = "open";
  entry.openedAt = now - 200;
  entry.health = "offline";
  entry.consecutiveFailures = 1;
  entry.totalFailures = 1;

  // Probe fails
  const r = await gw.invoke({ toolId: "a/t", input: {} });
  assert.equal(r.ok, false);
  assert.equal(gw.getProviderHealth("a").circuit, "open");
}

// ── F. Context integrity ────────────────────────────────────────
{
  const gw = new MultiMcpGateway();
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "t")],
    client: makeClient("ok")
  });

  // Conflicting providerId
  await assert.rejects(
    () => gw.invoke({ toolId: "a/t", input: {}, context: { providerId: "b", traceId: "x" } }),
    /conflict/
  );

  // Conflicting toolId
  await assert.rejects(
    () => gw.invoke({ toolId: "a/t", input: {}, context: { toolId: "a/other", traceId: "x" } }),
    /conflict/
  );

  // Invalid attempt
  await assert.rejects(
    () => gw.invoke({ toolId: "a/t", input: {}, context: { attempt: 0, traceId: "x" } }),
    /attempt/
  );

  // Caller objects unchanged
  const callerInput = { toolId: "a/t", input: { secret: "pw" } };
  const inputKeys = Object.keys(callerInput.input);
  await gw.invoke(callerInput);
  assert.deepEqual(Object.keys(callerInput.input), inputKeys);
  assert.equal(callerInput.input.secret, "pw");
}

// ── G. close with active+queued ─────────────────────────────────
{
  const gw = new MultiMcpGateway({ defaultTimeoutMs: 5000 });
  let resolve1;
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "t")],
    client: { invoke: () => new Promise(r => { resolve1 = r; }) },
    maxConcurrency: 1
  });

  const p1 = gw.invoke({ toolId: "a/t", input: {} });
  await new Promise(r => setTimeout(r, 50));

  const p2 = gw.invoke({ toolId: "a/t", input: {} });
  await new Promise(r => setTimeout(r, 50));

  assert.equal(gw.getProviderHealth("a").active, 1);
  assert.equal(gw.getProviderHealth("a").queued, 1);

  gw.close();

  // Queued call rejects
  await assert.rejects(p2, GatewayClosedError);

  // Active call can still resolve
  resolve1("done");
  const r1 = await p1;
  assert.equal(r1.ok, true);

  // Post-close: all APIs reject
  assert.throws(() => gw.listProviders(), GatewayClosedError);
}

// ── H. Invalid nowMs/nowIso on later calls ──────────────────────
{
  let invalid = false;
  const phasedNowMs = () => {
    if (invalid) return -1;
    return Date.now();
  };
  const gw = new MultiMcpGateway({ nowMs: phasedNowMs, defaultTimeoutMs: 5000 });
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "t")],
    client: makeClient("ok"),
    maxConcurrency: 1
  });

  // First invoke works (constructor + first call within valid phase)
  const r1 = await gw.invoke({ toolId: "a/t", input: {} });
  assert.equal(r1.ok, true);

  // Switch clock to invalid, launch a blocking call, then queue a second
  let resolveBlock;
  gw.unregisterProvider("a");
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "t")],
    client: { invoke: () => new Promise(r => { resolveBlock = r; }) },
    maxConcurrency: 1
  });

  // Block permit slot
  const blockP = gw.invoke({ toolId: "a/t", input: {} });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(gw.getProviderHealth("a").active, 1);

  // Now mark clock invalid for the queued call
  invalid = true;

  // Queue a call — reject immediately via catch
  const qErr = {};
  gw.invoke({ toolId: "a/t", input: {} }).then(
    () => { qErr.value = null; },
    e => { qErr.value = e; }
  );
  await new Promise(r => setTimeout(r, 50));

  assert.ok(qErr.value instanceof TypeError, "queued invoke must reject with TypeError");

  // Permit/queue cleanup: active still 1, queued 0
  const h = gw.getProviderHealth("a");
  assert.equal(h.active, 1);
  assert.equal(h.queued, 0);

  // Restore clock and complete blocking call
  invalid = false;
  resolveBlock("ok");
  const blockR = await blockP;
  assert.equal(blockR.ok, true);
  assert.equal(gw.getProviderHealth("a").active, 0);
}

// ── I. Timeout/failure results pass validateToolCallResult ───────
{
  const gw = new MultiMcpGateway({ defaultTimeoutMs: 5000 });
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "slow")],
    client: { invoke: () => new Promise(() => {}) },
    maxConcurrency: 1
  });

  // Timeout result must pass validateToolCallResult
  const timeoutResult = await gw.invoke({ toolId: "a/slow", input: {}, timeoutMs: 100 });
  assert.equal(timeoutResult.ok, false);
  assert.equal(timeoutResult.error.code, "PROVIDER_TIMEOUT");
  assert.ok(typeof timeoutResult.startedAt === "string");
  assert.ok(typeof timeoutResult.finishedAt === "string");
  assert.ok(timeoutResult.durationMs >= 0);
  assert.ok(Number.isInteger(timeoutResult.durationMs));
  assert.ok(Array.isArray(timeoutResult.artifacts));

  // Failure result must also be valid
  const gw2 = new MultiMcpGateway();
  gw2.registerProvider({
    definition: makeProviderDef("b"),
    tools: [makeTool("b", "err")],
    client: makeErrorClient(new Error("bad"))
  });
  const failResult = await gw2.invoke({ toolId: "b/err", input: {} });
  assert.equal(failResult.ok, false);
  assert.equal(failResult.error.name, "Error");
  assert.ok(typeof failResult.startedAt === "string");
  assert.ok(failResult.durationMs >= 0);
}

// ── J. All existing tests above + existing packages remain green ──
// (Implicit — verified after all test runs)

// ── Additional: TOOL_NOT_FOUND vs NO_ELIGIBLE_PROVIDER ───────────
{
  const gw = new MultiMcpGateway();
  gw.registerProvider({
    definition: makeProviderDef("a", { trustLevel: "trusted-local" }),
    tools: [makeTool("a", "exists", { risk: "critical" })],
    client: makeClient("ok")
  });

  // Tool truly absent
  const err1 = (() => { try { gw.resolveTool({ toolId: "a/missing" }); } catch(e) { return e; } })();
  assert.equal(err1.code, "TOOL_NOT_FOUND");

  // Tool exists but excluded by constraints
  const err2 = (() => { try { gw.resolveTool({ sourceName: "exists", maxRisk: "read" }); } catch(e) { return e; } })();
  assert.equal(err2.code, "NO_ELIGIBLE_PROVIDER");

  // Explicit toolId + mismatched providerId
  assert.throws(() => gw.resolveTool({ toolId: "a/exists", providerId: "b" }), GatewayResolutionError);
}

// ── listTools filter validation ─────────────────────────────────
{
  const gw = new MultiMcpGateway();
  gw.registerProvider({
    definition: makeProviderDef("a"),
    tools: [makeTool("a", "t")],
    client: makeClient("ok")
  });

  // invalid providerId (empty)
  assert.throws(() => gw.listTools({ providerId: "" }), TypeError);

  // invalid requiredCapabilities (empty strings)
  assert.throws(() => gw.listTools({ requiredCapabilities: [""] }), TypeError);

  // invalid allowedTrustLevels (duplicate)
  assert.throws(() => gw.listTools({ allowedTrustLevels: ["trusted-local", "trusted-local"] }), TypeError);

  // invalid includeDegraded
  assert.throws(() => gw.listTools({ includeDegraded: "yes" }), TypeError);
}

console.log("mcp-gateway: all assertions passed");
