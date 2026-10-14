#!/usr/bin/env node
/**
 * Documentation consistency contract.
 *
 * String-based guards (no generator) that keep the docs aligned with the current
 * v5 architecture: nine skills, no skill-read hard gate, honest OMP/Pi
 * difference, simulated-vs-real E2E clarity, and secret hygiene.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const readme = read("README.md");
const agents = read("AGENTS.md");
const architecture = read("architecture.md");
const problems = read("docs/problems.md");
const extensionApi = read("docs/extension-api.md");
const pkg = JSON.parse(read("package.json"));
const piAdapter = read("extensions/designer.ts");
const installation = read("docs/installation.md");
const parity = read("docs/cc-parity.md");
const evalDoc = read("docs/eval.md");
const workshopDoc = read("docs/workshop.md");

const checks = [
  ["package ships the shared core (incl. security.mjs)", pkg.files.some((f) => f === "shared/security.mjs" || f === "shared/" || f === "shared")],
  ["package description states the skill and fragment counts", /9 skills/.test(String(pkg.description)) && /5 conditional contract fragments/.test(String(pkg.description))],
  ["test script runs the simulated host-bridge suite", /test:e2e/.test(pkg.scripts.test)],

  // No current-tense v4 hard gate claim.
  ["README states no skill-read requirement", /no requirement\s+to read every skill|not technically enforced/i.test(readme)],
  ["AGENTS states no skill-read hard gate", /no skill-read hard gate/i.test(agents)],
  ["extension-api states no skill-read hard gate", /no skill-read hard gate/i.test(extensionApi)],
  ["AGENTS forbids resurrecting the v4 gate", /Resurrect the v4 skill-read hard gate/i.test(agents)],

  // OMP vs Pi honesty (no parity claim).
  ["README documents the OMP/Pi capability difference", /Hosts: OMP and Pi/.test(readme)],
  ["README states Pi has no delivery backstop", /no delivery-check backstop/i.test(readme)],
  ["architecture describes a separate Pi flow", /Runtime flow \(Pi\)/.test(architecture)],
  ["Pi adapter header does not claim parity", !/same focused workflow as OMP/i.test(piAdapter) && /NOT at parity/i.test(piAdapter)],

  // Post-execution framing.
  ["architecture frames session_stop as post-execution detection", /post-execution detection, not pre-execution enforcement/i.test(architecture)],

  // Simulated vs real E2E.
  ["README distinguishes simulated e2e from real OMP", /simulated evidence, not proof/i.test(readme)],
  ["README notes real-omp smoke can skip", /--real-omp[\s\S]*SKIPPED/i.test(readme)],
  ["architecture notes real-omp SKIPPED not PASS", /SKIPPED[\s\S]{0,15}never[\s\S]{0,15}PASS/i.test(architecture)],

  // The skill set present in the primary docs.
  ["README mentions the skill set", /nine skills/i.test(readme)],
  // The fork-first rule is a document and a guard, not a memory.
  ["installation doc states the link-not-a-second-copy rule", /node scripts\/install-local\.mjs --apply --clean/.test(installation) && /NEVER\s+omp install npm:omp-designer/.test(installation)],
  // This fork documents itself without a package manager: the commands it prints
  // are the ones that run, so a reader never needs npm or bun to follow them.
  ["README prints no package-manager command", !/\bnpm (run|install|test|ci)\b/.test(readme) && !/\bnpx\b/.test(readme)],
  ["README documents the gate runner", /node scripts\/gate\.mjs/.test(readme) && /--only/.test(readme)],
  ["installation doc prints no package-manager command", !/\bnpm run\b/.test(installation)],
  ["installation doc names the verification and the guard", /check-plugin-link\.mjs/.test(installation) && /realpath/.test(installation)],
  ["README points at the installation doc", /docs\/installation\.md/.test(readme)],
  // The parity doc must keep naming what is not portable, not just what matches.
  ["eval doc documents every grader type", /driver_ran/.test(evalDoc) && /captures_fresh/.test(evalDoc) && /claims_consistent/.test(evalDoc) && /skipped/.test(evalDoc)],
  ["README points at the eval doc", /docs\/eval\.md/.test(readme)],
  ["parity doc cites the extracts and marks the gaps", /cc-2296|claude\.js/.test(parity) && /not portable/.test(parity) && /artifact-design/.test(parity)],
  ["architecture skills table lists four skills", /designer-master[\s\S]*design-md[\s\S]*animate[\s\S]*review-skill/i.test(architecture)],

  // Secret hygiene.
  // The way back is a loop: the page posts, the project records, the turn is told.
  ["workshop doc documents the block, the log and the one-shot injection", /json workshop/.test(workshopDoc) && /workshop-decisions\.jsonl/.test(workshopDoc) && /never replayed|never re-?play/i.test(workshopDoc)],
  ["README points at the workshop doc", /docs\/workshop\.md/.test(readme)],
  ["README names the fragment flags", /--designer-motion/.test(readme) && /--designer-workshop/.test(readme)],
  ["parity doc records the flag and workshop closes", /designer-motion/.test(parity) && /workshop-decisions\.jsonl/.test(parity)],
  ["parity doc marks the interactive workshop closed", /~~\*\*The interactive half of the workshop\.\*\*~~ — \*\*done\*\*/.test(parity)],
  ["README says .env stays outside the repo", /keep real\s+credentials outside the repo|\.env is gitignored/i.test(readme)],
  ["AGENTS requires key rotation if exposed", /if a live\s+key was ever exposed[\s\S]*rotate it/i.test(agents)],
  ["problems.md records P0/P1/P2 status", /P0 — Security[\s\S]*P1 — Core logic[\s\S]*P2 — Host-bridge/i.test(problems)],
  ["problems.md keeps publish NO-GO", /Publish: NO-GO/i.test(problems)],
];

let failed = 0;
for (const [name, pass] of checks) {
  if (pass) console.log(`ok - ${name}`);
  else {
    failed += 1;
    console.error(`not ok - ${name}`);
  }
}

assert.equal(failed, 0);
console.log(`\n${checks.length} docs contract tests passed`);
