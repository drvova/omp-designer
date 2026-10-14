#!/usr/bin/env node
/**
 * Release package integrity and secret-hygiene gate.
 */

import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { findSecrets, scanTree } from "../shared/security.mjs";
import { runCommand } from "./lifecycle-lib.mjs";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const failures = [];
const expectedSkills = ["animate.md", "design-md.md", "designer-master.md", "expression.md", "review-skill.md", "run.md", "run-skill-generator.md", "dataviz.md", "workshop.md"];
const requiredFiles = [
  "extension/index.ts",
  "extensions/designer.ts",
  "scripts/fix-ai-slop.mjs",
  "scripts/analyze-layout.mjs",
  "scripts/audit-data.mjs",
  "scripts/check-plugin-link.mjs",
  "scripts/designer-driver.mjs",
  "scripts/designer-canvas.mjs",
  "scripts/real-agent-eval.mjs",
  "scripts/install-local.mjs",
  "scripts/lifecycle-cli.mjs",
  "scripts/lifecycle-lib.mjs",
  "scripts/uninstall-system.mjs",
  "docs/install-lifecycle.md",
  "data/ui-ux-pro-max/colors.csv",
  "data/ui-ux-pro-max/typography.csv",
  ...expectedSkills.map((name) => `skills/${name}`),
];

if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) failures.push(`Invalid semver: ${pkg.version}`);
if (!/\d+ skills/.test(String(pkg.description)) || !/5 conditional contract fragments/.test(String(pkg.description))) {
  failures.push("package description must state the skill set and the conditional-fragment count");
}
if (pkg.bin?.["omp-designer"] !== "./scripts/lifecycle-cli.mjs") {
  failures.push("package bin must expose scripts/lifecycle-cli.mjs as omp-designer");
}

for (const file of requiredFiles) {
  if (!existsSync(join(root, file))) failures.push(`Missing release file: ${file}`);
}

// npm is npm.cmd on Windows and cannot be spawned without a shell, so route it
// through the shared runner, which resolves shims and bare names per platform.
const packed = runCommand("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
  cwd: root,
  allowFailure: true,
  quiet: true,
});

let packedFiles = [];
if (packed.error) {
  failures.push(`npm pack --dry-run could not start: ${packed.error.message}`);
} else if (packed.status !== 0) {
  failures.push(`npm pack --dry-run failed: ${(packed.stderr || packed.stdout || "").trim() || `exit ${packed.status}`}`);
} else {
  try {
    packedFiles = JSON.parse(packed.stdout)[0].files.map((entry) => entry.path);
  } catch (error) {
    failures.push(`Could not parse npm pack output: ${error instanceof Error ? error.message : String(error)}`);
  }
}

for (const file of requiredFiles) {
  if (packedFiles.length > 0 && !packedFiles.includes(file)) failures.push(`Release tarball omits ${file}`);
}

for (const file of packedFiles) {
  if (file.includes("/__tests__/")) failures.push(`Release tarball should not contain tests: ${file}`);
  if (!new Set([".md", ".ts", ".js", ".mjs", ".json", ".yml", ".yaml", ".csv"]).has(extname(file))) continue;
  const content = readFileSync(join(root, file), "utf8");
  for (const finding of findSecrets(content)) {
    const line = content.slice(0, finding.index).split("\n").length;
    failures.push(`${finding.label}: ${file}:${line}`);
  }
}

// Repo-wide secret scan: packed files alone miss dotfiles (.env), docs, tests,
// and examples that still live in the working tree an agent has access to.
for (const finding of await scanTree(root)) {
  failures.push(`${finding.label} in working tree: ${finding.file}:${finding.line}`);
}

const extension = readFileSync(join(root, "extension", "index.ts"), "utf8");
if (/setDesignerMcpEnabled|DESIGNER_SKILL_GATE_BLOCKED|Attempt ALL/.test(extension)) {
  failures.push("Legacy MCP mutation or skill-gate code remains in extension/index.ts");
}

if (failures.length > 0) {
  console.error("Release check failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`Release check passed for omp-designer@${pkg.version} (${packedFiles.length} packed files)`);
