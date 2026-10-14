#!/usr/bin/env node
/**
 * The eval runner, exercised without a model call.
 *
 * `--session <dir>` grades a finished project and `--transcript <file>` points at
 * the conversation to read, so the whole path — case loading, session collection
 * (traces, captures, created files, tool calls), grading and scoring — runs
 * deterministically. The model-backed arm is the manual half; this is the half that
 * has to be right before the manual half means anything.
 *
 * Both directions are pinned: a session that did the work passes, and a session
 * that only *says* it did fails the graders that exist to catch exactly that.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNNER = join(PACKAGE_ROOT, "scripts", "designer-eval.mjs");
const TRACE_DIR = join(homedir(), ".omp", "agent", "designer-traces");

let checks = 0;
const ok = (label, fn) => {
  fn();
  checks += 1;
  console.log(`ok - ${label}`);
};

const dirs = [];
const cleanups = [];

const tracePathFor = (cwd) => {
  const base = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "root";
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  return join(TRACE_DIR, `${base}-${hash}.jsonl`);
};

function makeSession({ traces = [], captures = true, message = "", tools = [], staleCaptures = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "eval-session-"));
  dirs.push(dir);
  writeFileSync(join(dir, "index.html"), "<!doctype html><html><head><title>Oak</title></head><body><h1>Oak</h1></body></html>\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "eval-session", private: true }));
  if (captures) {
    mkdirSync(join(dir, "screenshots"), { recursive: true });
    writeFileSync(join(dir, "screenshots", "desktop-1440.png"), "png");
    writeFileSync(join(dir, "screenshots", "mobile-375.png"), "png");
    writeFileSync(join(dir, "screenshots", "driver-report.json"), JSON.stringify({
      ok: true, reason: "ok", captures: [{ path: "screenshots/desktop-1440.png", width: 1440, blank: false }],
      consoleErrors: [], pageErrors: [], failedRequests: [],
    }));
  }
  // Fresh by default: the page was captured after the last edit. The stale arm
  // captures first and edits after, which is the state the grader exists to catch.
  const sourceAge = staleCaptures ? 10_000 : 600_000;
  const captureAge = staleCaptures ? 600_000 : 60_000;
  utimesSync(join(dir, "index.html"), new Date(Date.now() - sourceAge), new Date(Date.now() - sourceAge));
  if (captures) {
    for (const name of ["desktop-1440.png", "mobile-375.png"]) {
      utimesSync(join(dir, "screenshots", name), new Date(Date.now() - captureAge), new Date(Date.now() - captureAge));
    }
  }

  const tracePath = tracePathFor(dir);
  if (traces.length > 0) {
    mkdirSync(TRACE_DIR, { recursive: true });
    writeFileSync(tracePath, traces.map((entry) => JSON.stringify({ timestamp: new Date().toISOString(), cwd: dir, ...entry })).join("\n") + "\n");
    cleanups.push(() => rmSync(tracePath, { force: true }));
  }

  const transcript = join(dir, "session.jsonl");
  const records = [];
  if (message) records.push({ type: "assistant", message: { content: [{ type: "text", text: message }] } });
  for (const tool of tools) records.push({ type: "assistant", message: { content: [{ type: "tool_use", name: tool.name, input: tool.input ?? {} }] } });
  writeFileSync(transcript, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  symlinkSync(PACKAGE_ROOT, join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  return { dir, transcript, tracePath };
}

const runEval = (session, extra = []) => {
  const output = mkdtempSync(join(tmpdir(), "eval-out-"));
  dirs.push(output);
  const result = spawnSync(process.execPath, [
    RUNNER, "--session", session.dir, "--transcript", session.transcript, "--output-dir", output, "--case-dir", join(PACKAGE_ROOT, "evals"), ...extra,
  ], { encoding: "utf8" });
  const resultsPath = join(output, "results.json");
  return {
    status: result.status,
    stdout: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    results: readFileSync(resultsPath, "utf8") ? JSON.parse(readFileSync(resultsPath, "utf8")) : null,
  };
};

const caseByName = (results, name) => results.cases.find((entry) => entry.name === name);
const armOf = (results, name) => caseByName(results, name).arms.recorded[0];
const graderOf = (arm, graderName) => arm.graders.find((entry) => entry.name === graderName);

try {
  ok("a session that rendered the page passes the driver and capture graders", () => {
    const session = makeSession({
      traces: [{ event: "prompt_injected" }, { event: "designer_check", ok: true }, { event: "delivery_checks_passed" }],
      message: "I changed the heading and checked the page at both widths. One thing left: keep the pricing table here, or give it its own route?",
      tools: [{ name: "edit", input: { path: "index.html" } }],
    });
    const run = runEval(session);
    assert.equal(run.status, 0, run.stdout);
    const driver = graderOf(armOf(run.results, "render-before-claim"), "driver_ran");
    assert.equal(driver.passed, true, driver.detail);
    const fresh = graderOf(armOf(run.results, "render-before-claim"), "captures_fresh");
    assert.equal(fresh.passed, true, fresh.detail);
    assert.equal(caseByName(run.results, "claim-matches-record").passed, true);
  });

  ok("a session that only says it looked fails, and the detail says why", () => {
    const session = makeSession({
      traces: [{ event: "prompt_injected" }],
      captures: false,
      message: "Verified in the browser at every width — everything looks great.",
    });
    const run = runEval(session);
    assert.notEqual(run.status, 0, "the suite must not report success");
    const arm = armOf(run.results, "render-before-claim");
    assert.equal(arm.passed, false);
    assert.match(graderOf(arm, "driver_ran").detail, /evidence: nothing/);
    assert.match(graderOf(arm, "captures_fresh").detail, /0 capture/);
  });

  ok("stale captures are called out as before the last source edit", () => {
    const session = makeSession({
      traces: [{ event: "designer_check" }],
      staleCaptures: true,
      message: "Updated the hero.",
    });
    const run = runEval(session);
    const fresh = graderOf(armOf(run.results, "render-before-claim"), "captures_fresh");
    assert.equal(fresh.passed, false);
    assert.match(fresh.detail, /BEFORE the last source edit/);
  });

  ok("a contradicting claim fails the honesty grader through the trace", () => {
    const session = makeSession({
      traces: [{ event: "designer_check" }, { event: "claim_mismatch", rules: ["claim-unverified-evidence"] }],
      message: "All good.",
    });
    const run = runEval(session);
    const claim = graderOf(armOf(run.results, "render-before-claim"), "claims_consistent");
    assert.equal(claim.passed, false);
    assert.match(claim.detail, /claim_mismatch/);
  });

  ok("the workshop case counts questions and keeps machinery out of the reply", () => {
    const good = makeSession({
      traces: [{ event: "workshop_opened" }],
      message: "The page is up. One thing to settle: should pricing sit on the home page, or get its own route?",
    });
    const goodRun = runEval(good, ["--case", "workshop-one-decision"]);
    const arm = armOf(goodRun.results, "workshop-one-decision");
    assert.equal(graderOf(arm, "one_question").passed, true, graderOf(arm, "one_question").detail);
    assert.equal(graderOf(arm, "no_machinery").passed, true, graderOf(arm, "no_machinery").detail);

    const chatty = makeSession({
      message: "Loading the workshop skill now. Skill says one decision per turn; what do you prefer? Or should I pick?",
    });
    const chattyRun = runEval(chatty, ["--case", "workshop-one-decision"]);
    const chattyArm = armOf(chattyRun.results, "workshop-one-decision");
    assert.equal(graderOf(chattyArm, "no_machinery").passed, false, "narration of the machinery must fail");
    assert.equal(graderOf(chattyArm, "one_question").passed, false, "two questions is not one decision");
  });

  ok("the results document is the documented shape", () => {
    const session = makeSession({ traces: [{ event: "designer_check" }], message: "Done." });
    const run = runEval(session);
    assert.equal(run.results.schemaVersion, "1");
    assert.equal(typeof run.results.suite.threshold, "number");
    assert.equal(run.results.cases.length, 3);
    assert.equal(typeof run.results.aggregates.meanScore, "number");
    assert.equal(typeof run.results.aggregates.passed, "number");
  });
} finally {
  for (const cleanup of cleanups) cleanup();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${checks} eval-runner checks passed`);
