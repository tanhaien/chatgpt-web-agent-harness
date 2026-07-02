import { existsSync as realExistsSync } from "node:fs";
import { join } from "node:path";

export async function resolveNodeRuntime({
  env = process.env,
  manifest = {},
  rootDir,
  resourcesPath,
  platform = process.platform,
  arch = process.arch,
  existsSync = realExistsSync,
  nodeVersion
} = {}) {
  if (!rootDir) throw new Error("rootDir is required to resolve the Node runtime.");
  if (typeof nodeVersion !== "function") throw new Error("nodeVersion probe is required.");
  const minimum = manifest.minimumNodeVersion || "22.5.0";
  const key = runtimePlatformKey(platform, arch);
  const candidates = [
    ...(env.LCA_NODE_PATH ? [{ path: env.LCA_NODE_PATH, source: "env" }] : []),
    ...(resourcesPath ? [{ path: bundledNodePath(resourcesPath, key), source: "bundled" }] : []),
    { path: bundledNodePath(rootDir, key), source: "bundled" },
    { path: "node", source: "system" }
  ];
  const failures = [];
  for (const candidate of candidates) {
    if (candidate.path !== "node" && !existsSync(candidate.path)) {
      failures.push(`${candidate.source}:${candidate.path} missing`);
      continue;
    }
    try {
      const version = await nodeVersion(candidate.path);
      if (!isAtLeastVersion(version, minimum)) {
        failures.push(`${candidate.source}:${candidate.path} version ${version || "unknown"} < ${minimum}`);
        continue;
      }
      return { ...candidate, version, minimum, platformKey: key };
    } catch (error) {
      failures.push(`${candidate.source}:${candidate.path} ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Node.js ${minimum}+ runtime was not found. Checked ${key}: ${failures.join("; ")}`);
}

export function runtimePlatformKey(platform = process.platform, arch = process.arch) {
  const normalizedArch = arch === "x64" || arch === "arm64" ? arch : String(arch || "unknown");
  if (platform === "win32") return `win32-${normalizedArch}`;
  if (platform === "darwin") return `darwin-${normalizedArch}`;
  if (platform === "linux") return `linux-${normalizedArch}`;
  return `${platform || "unknown"}-${normalizedArch}`;
}

export function bundledNodePath(baseDir, platformKey) {
  return join(baseDir, "runtimes", "node", platformKey, executableName(platformKey));
}

export function executableName(platformKey) {
  return String(platformKey || "").startsWith("win32-") ? "node.exe" : "node";
}

export function isAtLeastVersion(actual, minimum) {
  const left = String(actual || "").replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = String(minimum || "").replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] || 0) > (right[index] || 0)) return true;
    if ((left[index] || 0) < (right[index] || 0)) return false;
  }
  return true;
}
