#!/usr/bin/env node
/**
 * Proves that the omp plugin named `omp-designer` resolves to THIS checkout.
 *
 * Why it exists: the published package is a different lineage, and installing it
 * silently replaces the fork for every later session — the failure shows up much
 * later as behaviour that does not match the source beside you. The docs state
 * the rule; this script makes breaking it loud.
 *
 * Exit codes: 0 the registered plugin is this checkout, 1 it is something else,
 * 3 nothing is registered (not a failure — the check had nothing to compare).
 *
 * Verification is by identity, not by version string: the plugin directory must
 * realpath to this package root (a Windows junction defeats `islink`), and a file
 * that exists only in the fork must hash identically on both sides.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Files that only exist in the fork, so a stale published copy cannot match them. */
const FORK_ONLY_FILES = ["shared/delivery-claims.mjs", "shared/driver-report.mjs", "skills/run.md"];

function value(args, flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const realpathOrNull = (path) => {
  try {
    return existsSync(path) ? realpathSync(path) : null;
  } catch {
    return null;
  }
};

const sha256 = (path) => {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
};

export function checkPluginLink({ home = homedir(), json = false } = {}, io = console) {
  const pluginsRoot = join(home, ".omp", "plugins");
  const pluginPath = join(pluginsRoot, "node_modules", "omp-designer");
  const problems = [];

  if (!existsSync(pluginPath)) {
    const detail = { status: "not-registered", pluginPath, packageRoot: PACKAGE_ROOT };
    if (json) io.log(JSON.stringify(detail));
    else io.log(`omp-designer is not registered as a plugin (looked at ${pluginPath}). Nothing to check. Link it with: npm run install:local:clean`);
    return 3;
  }

  const resolved = realpathOrNull(pluginPath);
  const expected = realpathOrNull(PACKAGE_ROOT);
  if (!resolved || !expected || resolved.toLowerCase() !== expected.toLowerCase()) {
    problems.push(`the registered plugin resolves to ${resolved ?? "unreadable"}, not this checkout (${expected})`);
  }

  let pluginVersion = null;
  try {
    pluginVersion = JSON.parse(readFileSync(join(pluginPath, "package.json"), "utf8")).version;
  } catch {
    problems.push(`the registered plugin has no readable package.json at ${pluginPath}`);
  }
  const ownVersion = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;
  if (pluginVersion && pluginVersion !== ownVersion) {
    problems.push(`the registered plugin is version ${pluginVersion}; this checkout is ${ownVersion}`);
  }

  for (const relative of FORK_ONLY_FILES) {
    const pluginHash = sha256(join(pluginPath, relative));
    const ownHash = sha256(join(PACKAGE_ROOT, relative));
    if (!pluginHash || !ownHash) continue;
    if (pluginHash !== ownHash) problems.push(`${relative} differs from this checkout (the plugin is a copy, not a link)`);
  }

  try {
    const manifest = JSON.parse(readFileSync(join(pluginsRoot, "package.json"), "utf8"));
    if (manifest?.dependencies && Object.hasOwn(manifest.dependencies, "omp-designer")) {
      problems.push("the plugin manager still lists omp-designer as an npm dependency, so an install can replace the link");
    }
  } catch {
    // No manifest to inspect; the identity checks above already ran.
  }

  const detail = { status: problems.length === 0 ? "linked" : "mismatch", pluginPath, resolved, pluginVersion, ownVersion, problems };
  if (json) io.log(JSON.stringify(detail, null, 2));
  if (problems.length === 0) {
    if (!json) io.log(`omp-designer is this checkout: ${resolved} (v${pluginVersion})`);
    return 0;
  }
  if (!json) {
    io.log("omp-designer is NOT this checkout:");
    for (const problem of problems) io.log(`  - ${problem}`);
    io.log("Fix: npm run install:local:clean   then restart omp.");
  }
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  process.exitCode = checkPluginLink({
    home: value(args, "--home", homedir()),
    json: args.includes("--json"),
  });
}
