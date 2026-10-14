#!/usr/bin/env node
/**
 * The fork-link guard. Two arms that must not be confused with each other:
 * "nothing is registered" is not a failure, and "something else is registered"
 * is a loud one — silently running the published package is the mistake this
 * whole check exists to make visible.
 *
 * The fake homes keep this portable: the check runs against a temp directory, so
 * a machine that has no omp plugin at all still exercises both verdicts.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPluginLink } from "../check-plugin-link.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

let checks = 0;
const ok = (label, fn) => {
  fn();
  checks += 1;
  console.log(`ok - ${label}`);
};

const silent = { log() {} };
const dirs = [];
const makeHome = (withPlugin, version = "5.1.0") => {
  const home = mkdtempSync(join(tmpdir(), "plugin-link-"));
  dirs.push(home);
  if (withPlugin) {
    const plugin = join(home, ".omp", "plugins", "node_modules", "omp-designer");
    mkdirSync(plugin, { recursive: true });
    writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "omp-designer", version }));
    writeFileSync(join(home, ".omp", "plugins", "package.json"), JSON.stringify({ name: "omp-plugins", dependencies: {} }));
  }
  return home;
};

ok("no registered plugin reports not-registered (exit 3), not a failure", () => {
  const home = makeHome(false);
  assert.equal(checkPluginLink({ home }, silent), 3);
});

ok("a plugin that is not this checkout fails loudly", () => {
  const home = makeHome(true, "4.1.0");
  assert.equal(checkPluginLink({ home }, silent), 1);
});

ok("an npm dependency entry is reported even when the path looks right", () => {
  const home = makeHome(true);
  const pluginRoot = join(home, ".omp", "plugins");
  writeFileSync(join(pluginRoot, "package.json"), JSON.stringify({ name: "omp-plugins", dependencies: { "omp-designer": "latest" } }));
  const lines = [];
  const code = checkPluginLink({ home }, { log: (line) => lines.push(String(line)) });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /npm dependency/);
});

ok("this very checkout passes when it is the registered plugin", () => {
  // The guard must be able to say yes: link the real package root into a fake
  // home the way omp does (junction on Windows, symlink elsewhere).
  const home = mkdtempSync(join(tmpdir(), "plugin-link-real-"));
  dirs.push(home);
  const pluginsRoot = join(home, ".omp", "plugins");
  mkdirSync(join(pluginsRoot, "node_modules"), { recursive: true });
  const link = join(pluginsRoot, "node_modules", "omp-designer");
  symlinkSync(PACKAGE_ROOT, link, process.platform === "win32" ? "junction" : "dir");
  writeFileSync(join(pluginsRoot, "package.json"), JSON.stringify({ name: "omp-plugins", dependencies: {} }));
  assert.equal(checkPluginLink({ home }, silent), 0);
});

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
console.log(`\n${checks} plugin-link checks passed`);
