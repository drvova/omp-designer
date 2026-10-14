#!/usr/bin/env node
/**
 * The gate, without a package manager.
 *
 * The `test` chain in package.json is the contract — this runner reads it rather
 * than keeping a second list, so a suite added to the chain runs here the moment
 * it is added, and a suite removed from the chain stops running here too. No npm,
 * no wrapper: each `npm run <name>` step becomes the command that script actually
 * runs, executed with `node_modules/.bin` on PATH so `tsc` and the test runtimes
 * resolve the way they do under npm.
 *
 *   node scripts/gate.mjs                 the whole chain, stopping at the first failure
 *   node scripts/gate.mjs --only canvas   just the steps whose command mentions "canvas"
 *   node scripts/gate.mjs --list          print the steps and exit
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** The steps of the `test` chain, as commands. */
function steps() {
  const chain = String(pkg.scripts?.test ?? "");
  if (chain.trim() === "") throw new Error("package.json has no `test` script to run");
  return chain
    .split("&&")
    .map((piece) => piece.trim())
    .filter(Boolean)
    .map((piece) => {
      const match = /^npm\s+run\s+(\S+)$/.exec(piece);
      if (!match) return { label: piece, command: piece };
      const script = pkg.scripts?.[match[1]];
      if (typeof script !== "string") throw new Error(`package.json has no script named "${match[1]}"`);
      return { label: match[1], command: script };
    });
}

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] ?? "";
};
const only = flag("--only");

let plan = steps();
if (argv.includes("--list")) {
  for (const step of plan) console.log(`${step.label}: ${step.command}`);
  process.exit(0);
}
if (only) {
  plan = plan.filter((step) => step.label.includes(only) || step.command.includes(only));
  if (plan.length === 0) {
    console.error(`gate: nothing matches "${only}"`);
    process.exit(2);
  }
}

// The PATH npm builds for a script: the local bin first, so a devDependency CLI
// resolves to the pinned one.
const env = {
  ...process.env,
  PATH: `${join(root, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
};

const started = Date.now();
const failed = [];
for (const step of plan) {
  const began = Date.now();
  console.log(`\n=== ${step.label}: ${step.command}`);
  const run = spawnSync(step.command, { shell: true, cwd: root, env, stdio: "inherit" });
  const seconds = ((Date.now() - began) / 1000).toFixed(1);
  if (run.status !== 0) {
    failed.push(step.label);
    console.error(`\nFAILED ${step.label} (exit ${run.status}, ${seconds}s)`);
    break; // the chain is `&&`: a failure stops the rest, and so does this
  }
  console.log(`ok ${step.label} (${seconds}s)`);
}

const total = ((Date.now() - started) / 1000).toFixed(1);
if (failed.length > 0) {
  console.error(`\ngate: ${failed.length} step(s) failed: ${failed.join(", ")} — ${total}s total`);
  process.exit(1);
}
console.log(`\ngate: ${plan.length} step(s) passed — ${total}s total`);
