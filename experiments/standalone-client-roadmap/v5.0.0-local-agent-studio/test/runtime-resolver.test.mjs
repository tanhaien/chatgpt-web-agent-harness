import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { bundledNodePath, isAtLeastVersion, resolveNodeRuntime, runtimePlatformKey } from "../desktop/runtime-resolver.mjs";

test("runtime resolver prefers env, then bundled runtime, then system node", async () => {
  const root = "C:/app";
  const resources = "C:/resources";
  const bundled = bundledNodePath(resources, "win32-x64");
  const envNode = "D:/node/node.exe";
  const seen = [];
  const result = await resolveNodeRuntime({
    env: { LCA_NODE_PATH: envNode },
    manifest: { minimumNodeVersion: "22.5.0" },
    rootDir: root,
    resourcesPath: resources,
    platform: "win32",
    arch: "x64",
    existsSync: (value) => value === bundled || value === envNode,
    nodeVersion: async (value) => {
      seen.push(value);
      return "24.0.0";
    }
  });
  assert.equal(result.path, envNode);
  assert.equal(result.source, "env");
  assert.deepEqual(seen, [envNode]);
});

test("runtime resolver selects bundled runtime before system node", async () => {
  const root = "/app";
  const bundled = bundledNodePath(root, "linux-x64");
  const result = await resolveNodeRuntime({
    env: {},
    manifest: { minimumNodeVersion: "22.5.0" },
    rootDir: root,
    platform: "linux",
    arch: "x64",
    existsSync: (value) => value === bundled,
    nodeVersion: async (value) => value === bundled ? "22.5.0" : "99.0.0"
  });
  assert.equal(result.path, bundled);
  assert.equal(result.source, "bundled");
});

test("runtime resolver rejects runtimes below the manifest minimum", async () => {
  await assert.rejects(() => resolveNodeRuntime({
    env: { LCA_NODE_PATH: "/old/node" },
    manifest: { minimumNodeVersion: "22.5.0" },
    rootDir: "/app",
    platform: "linux",
    arch: "x64",
    existsSync: () => true,
    nodeVersion: async () => "20.0.0"
  }), /Node\.js 22\.5\.0\+ runtime was not found/);
});

test("runtime platform keys and version comparison are stable", () => {
  assert.equal(runtimePlatformKey("win32", "x64"), "win32-x64");
  assert.equal(runtimePlatformKey("darwin", "arm64"), "darwin-arm64");
  assert.equal(bundledNodePath("/base", "linux-x64"), join("/base", "runtimes", "node", "linux-x64", "node"));
  assert.equal(isAtLeastVersion("22.5.0", "22.5.0"), true);
  assert.equal(isAtLeastVersion("22.4.9", "22.5.0"), false);
  assert.equal(isAtLeastVersion("24.0.0", "22.5.0"), true);
});
