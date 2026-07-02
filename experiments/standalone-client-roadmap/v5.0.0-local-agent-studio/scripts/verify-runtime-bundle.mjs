#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledNodePath, resolveNodeRuntime, runtimePlatformKey } from "../desktop/runtime-resolver.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(ROOT, "version-manifest.json"), "utf8"));
const platform = process.argv.find((arg) => arg.startsWith("--platform="))?.slice("--platform=".length) || process.platform;
const arch = process.argv.find((arg) => arg.startsWith("--arch="))?.slice("--arch=".length) || process.arch;
const key = runtimePlatformKey(platform, arch);
const runtime = await resolveNodeRuntime({
  env: { LCA_NODE_PATH: process.env.LCA_NODE_PATH || "" },
  manifest,
  rootDir: ROOT,
  platform,
  arch,
  nodeVersion
});

if (runtime.source !== "bundled" && process.argv.includes("--require-bundled")) {
  throw new Error(`Bundled runtime required but resolver selected ${runtime.source}: ${runtime.path}`);
}

console.log(JSON.stringify({
  ok: true,
  platformKey: key,
  expectedBundledPath: bundledNodePath(ROOT, key),
  selected: runtime
}, null, 2));

function nodeVersion(node) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, ["--version"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(output.trim() || `node --version exited ${code}`));
      else resolve(output.trim().replace(/^v/, ""));
    });
  });
}
