#!/usr/bin/env node
/**
 * designer-eval — run the eval suite the way `claude plugin eval` does.
 *
 * A case is a prompt plus graders (`evals/<case>/prompt.md` and
 * `evals/<case>/graders/*.md`). The runner starts a real `omp -p` session with
 * only this plugin loaded, collects what the run actually did — tool calls, the
 * final message, the traces the extension wrote, the captures on disk — and scores
 * it. With `--ablation with-without` it also runs the same cases with no plugin
 * loaded, so the suite reports the delta rather than trusting the arm with the
 * plugin to be meaningful.
 *
 * Grading is separate from running: `--session <dir>` scores an existing project
 * without spending a model call, which is how the graders themselves are tested.
 *
 * Exit codes: 0 every case at or above the threshold, 1 below it (or a case that
 * could not run), 2 partial — some case ran, some did not.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { globToRegExp } from "../shared/glob-match.mjs";
import { gradeSession, parseCase, scoreCase } from "../shared/eval-graders.mjs";
import { readDriverReport } from "../shared/driver-report.mjs";
import { locateTranscript, sessionDirName, sessionsRoot as sessionsRootPath } from "../shared/skill-usage.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION_ENTRY = join(PACKAGE_ROOT, "extension", "index.ts");

const args = process.argv.slice(2);
const value = (flag, fallback = "") => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const caseDir = resolve(value("--case-dir", join(PACKAGE_ROOT, "evals")));
const outputDir = value("--output-dir", join(caseDir, "results", new Date().toISOString().replace(/[:.]/g, "-")));
const sessionTarget = value("--session");
const transcriptOverride = value("--transcript");
const model = value("--model", "");
const threshold = Number(value("--threshold", "1"));
const runs = Math.max(1, Number(value("--runs", "1")));
const maxTime = Number(value("--max-time", "600"));
const caseFilter = value("--case");
const tagFilter = value("--tag").split(",").map((tag) => tag.trim()).filter(Boolean);
const ablation = value("--ablation", "none");
const scaffoldOverride = value("--scaffold");
const keepTemp = args.includes("--keep-temp");
const dryRun = args.includes("--dry-run");
const quiet = args.includes("--quiet");

const log = (...parts) => { if (!quiet) console.log(...parts); };

/** Read the suite from disk. */
function loadCases() {
  if (!existsSync(caseDir)) return [];
  const cases = [];
  for (const entry of readdirSync(caseDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "results" || entry.name.startsWith(".")) continue;
    const dir = join(caseDir, entry.name);
    const promptPath = join(dir, "prompt.md");
    if (!existsSync(promptPath)) continue;
    const graderDir = join(dir, "graders");
    const graders = existsSync(graderDir)
      ? readdirSync(graderDir).filter((file) => file.endsWith(".md")).sort().map((file) => ({
          name: file.replace(/\.md$/, ""),
          text: readFileSync(join(graderDir, file), "utf8"),
        }))
      : [];
    cases.push({ dir, ...parseCase({ promptText: readFileSync(promptPath, "utf8"), graders, name: entry.name }) });
  }
  return cases.filter((entry) => !caseFilter || new globToRegExp(caseFilter).test(entry.name))
    .filter((entry) => tagFilter.length === 0 || entry.tags.some((tag) => tagFilter.includes(tag)));
}

/** The newest transcript in a session store the runner created itself. */
function newestTranscript(sessionDir) {
  if (!existsSync(sessionDir)) return null;
  let newest = null;
  const walk = (dir, depth = 0) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith(".jsonl")) {
        try {
          const mtime = statSync(full).mtimeMs;
          if (!newest || mtime > newest.mtime) newest = { path: full, mtime };
        } catch {
          // unreadable transcript: not a candidate
        }
      }
    }
  };
  walk(sessionDir);
  return newest?.path ?? null;
}

/** The extension's own trace for a project, mirroring how it writes it. */
function collectTrace(cwd) {
  const base = String(cwd).split(/[\\/]/).filter(Boolean).at(-1) ?? "root";
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  const path = join(homedir(), ".omp", "agent", "designer-traces", `${base}-${hash}.jsonl`);
  if (!existsSync(path)) return { path, entries: [], reason: "no-trace" };
  const entries = [];
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // A half-written line is not a finding; the rest of the trace still counts.
      }
    }
  } catch {
    return { path, entries: [], reason: "unreadable" };
  }
  return { path, entries, reason: null };
}

/** Everything a grader can look at, collected from a finished run. */
function collectSession({ project, sinceMs, sessionId = "", transcript = "" }) {
  const record = {
    lastMessage: "",
    toolCalls: [],
    createdFiles: [],
    files: {},
    trace: [],
    driver: readDriverReport(project)?.report ?? null,
    captures: null,
    transcript: null,
    notes: [],
  };

  const trace = collectTrace(project);
  record.trace = trace.entries;
  record.tracePath = trace.path;
  if (trace.reason) record.notes.push(`trace: ${trace.reason}`);
  if (record.driver) record.notes.push("driver report present");
  for (const entry of record.trace) {
    if (String(entry.event) === "designer_check") record.toolCalls.push({ name: "designer_check", input: { source: "trace" } });
  }

  const override = transcript || transcriptOverride;
  const located = override
    ? { path: resolve(override), dir: dirname(resolve(override)), reason: null }
    : locateTranscript({ sessionId, cwd: project, sinceMs });
  if (!located.path) {
    record.notes.push(`no transcript: ${located.reason}`);
  } else {
    record.transcript = located.path;
    for (const line of readFileSync(located.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const visited = new Set();
      const walk = (node) => {
        if (!node || typeof node !== "object" || visited.has(node)) return;
        visited.add(node);
        if (Array.isArray(node)) {
          for (const item of node) walk(item);
          return;
        }
        const type = typeof node.type === "string" ? node.type : "";
        const name = typeof node.name === "string" ? node.name : "";
        if ((type === "tool_use" || type === "toolCall" || node.tool_name) && (name || node.tool_name)) {
          record.toolCalls.push({ name: name || String(node.tool_name), input: node.input ?? node.arguments ?? {} });
        }
        if (type === "text" && typeof node.text === "string") record.lastMessage = node.text;
        for (const child of Object.values(node)) walk(child);
      };
      walk(entry);
    }
  }

  // Captures and traces come from the project and from this process's own record.
  const screenshots = join(project, "screenshots");
  const captureFiles = existsSync(screenshots)
    ? readdirSync(screenshots).filter((file) => file.endsWith(".png")).map((file) => `screenshots/${file}`)
    : [];
  let newestCapture = 0;
  for (const file of captureFiles) {
    try {
      newestCapture = Math.max(newestCapture, statSync(join(project, file)).mtimeMs);
    } catch {
      // unreadable capture: it still counts as present, just not as fresh evidence
    }
  }
  let newestSourceEdit = 0;
  const walkSources = (dir, depth = 0) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (["node_modules", ".git", "screenshots", "canvas.json"].includes(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walkSources(full, depth + 1);
      else if (/\.(?:html?|css|jsx?|tsx?|vue|svelte|astro)$/i.test(entry.name)) {
        try {
          newestSourceEdit = Math.max(newestSourceEdit, statSync(full).mtimeMs);
        } catch {
          // ignore
        }
      }
    }
  };
  walkSources(project);
  record.captures = {
    files: captureFiles,
    newestCapture: newestCapture || undefined,
    newestSourceEdit: newestSourceEdit || undefined,
  };

  return record;
}

function scaffoldFor(evalCase, index) {
  if (scaffoldOverride) {
    const target = mkdtempSync(join(tmpdir(), `designer-eval-${index}-`));
    cpSync(scaffoldOverride, target, { recursive: true });
    return target;
  }
  const target = mkdtempSync(join(tmpdir(), `designer-eval-${evalCase.name}-`));
  writeFileSync(join(target, "index.html"), [
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Oak tables</title>",
    "<meta name=\"description\" content=\"Handmade oak tables, built to order.\"></head>",
    "<body><main><h1>Oak tables</h1><p>Handmade to order in Lisbon.</p></main></body></html>",
  ].join(""));
  writeFileSync(join(target, "package.json"), JSON.stringify({ name: "eval-fixture", private: true, scripts: { dev: "echo no-dev-server" } }, null, 2));
  return target;
}

function runSession(evalCase, project, armIndex, usePlugin) {
  const started = Date.now();
  // A throwaway project, an unattended session: approvals are what cc's eval
  // sandbox removes with `dontAsk`, so the arm measures the workflow, not the
  // prompt-answering loop.
  // The arm gets its own session store: the host's default naming for a project
  // folder is not something to guess, and it keeps throwaway runs out of the real
  // one. The transcript then has one known home.
  const sessionDir = mkdtempSync(join(tmpdir(), `designer-eval-sessions-${armIndex}-`));
  const cliArgs = ["-p", evalCase.prompt, "--cwd", project, "--approval-mode", "yolo", "--session-dir", sessionDir, "--max-time", String(Math.min(maxTime, evalCase.timeoutSeconds))];
  if (model || evalCase.model) cliArgs.push("--model", model || evalCase.model);
  if (evalCase.allowedTools) cliArgs.push("--tools", evalCase.allowedTools);
  if (usePlugin) cliArgs.push("--extension", EXTENSION_ENTRY);
  else cliArgs.push("--no-extensions");
  // The plugin only acts for a project where designer mode is on, so the arm that
  // includes it must say so — otherwise the eval measures an inert extension and
  // reports a trivially green honesty grader. This is cc's "plugin under test is
  // loaded" precondition, spelled for this host.
  const run = spawnSync("omp", cliArgs, {
    encoding: "utf8",
    timeout: (Math.min(maxTime, evalCase.timeoutSeconds) + 60) * 1000,
    env: { ...process.env, OMP_DESIGNER_MODE: usePlugin ? "1" : "0" },
  });
  return {
    exitCode: run.status,
    stderr: (run.stderr ?? "").split("\n").slice(-6).join("\n"),
    arm: `${usePlugin ? "with" : "without"}-${armIndex}`,
    sessionDir,
    startedAt: started,
    finishedAt: Date.now(),
  };
}

function gradeArm(evalCase, project, run) {
  const owned = run.sessionDir ? newestTranscript(run.sessionDir) : null;
  const session = collectSession({ project, sinceMs: run.startedAt, transcript: transcriptOverride || owned || "" });
  // Transcripts from a model run land in the host's session store under a folder
  // named for the throwaway project. Grading is done with them; leaving them behind
  // would pile residue into the real store for every eval run.
  const ownedSession = !transcriptOverride && session.transcript &&
    (run.sessionDir ? resolve(session.transcript).toLowerCase().startsWith(resolve(run.sessionDir).toLowerCase()) : false);
  if (!keepTemp && ownedSession) {
    try {
      rmSync(session.transcript, { force: true });
      rmSync(dirname(session.transcript), { recursive: true, force: true });
    } catch {
      // The folder held other transcripts: leave them alone.
    }
  }
  const graderResults = gradeSession(evalCase.graders, session);
  return { ...run, session: { transcript: session.transcript, toolCalls: session.toolCalls.length, notes: session.notes }, graders: graderResults, ...scoreCase(graderResults) };
}

function main() {
  const cases = loadCases();
  if (cases.length === 0) {
    console.error(`designer-eval: no cases under ${caseDir}`);
    return 1;
  }
  if (dryRun) {
    for (const evalCase of cases) {
      log(`${evalCase.name} [${evalCase.tags.join(",") || "untagged"}] runs=${runs} graders=${evalCase.graders.length}`);
      for (const grader of evalCase.graders) log(`  - ${grader.name} (${grader.type})`);
    }
    return 0;
  }

  const results = { schemaVersion: "1", suite: { dir: caseDir, threshold, runs, model: model || "default", plugin: "extension/index.ts", designerMode: "OMP_DESIGNER_MODE for the with-arm" }, cases: [], generatedAt: new Date().toISOString() };

  if (sessionTarget) {
    // Grade what already exists: no model call, no scaffolding.
    const project = resolve(sessionTarget);
    const run = { exitCode: 0, arm: "recorded", startedAt: 0, finishedAt: Date.now() };
    for (const evalCase of cases) {
      const arm = gradeArm(evalCase, project, run);
      results.cases.push({ name: evalCase.name, tags: evalCase.tags, arms: { recorded: [arm] }, passed: arm.passed, score: arm.score });
      log(`${arm.passed ? "PASS" : "FAIL"} ${evalCase.name} (${arm.score.toFixed(2)})`);
      if (arm.session.notes.length > 0) log(`   notes: ${arm.session.notes.join("; ")}`);
    for (const grader of arm.graders) log(`   ${grader.passed ? "ok  " : "FAIL"} ${grader.name}: ${grader.detail}`);
    }
  } else {
    for (const evalCase of cases) {
      const arms = { with: [] };
      if (ablation === "with-without") arms.without = [];
      for (let index = 0; index < runs; index += 1) {
        for (const [armName, usePlugin] of [["with", true], ...(ablation === "with-without" ? [["without", false]] : [])]) {
          const project = scaffoldFor(evalCase, index);
          const run = runSession(evalCase, project, index, usePlugin);
          const graded = gradeArm(evalCase, project, run);
          arms[armName].push(graded);
          log(`${graded.passed ? "PASS" : "FAIL"} ${evalCase.name} ${armName}#${index} (${graded.score.toFixed(2)})`);
          for (const grader of graded.graders) log(`   ${grader.passed ? "ok  " : "FAIL"} ${grader.name}: ${grader.detail}`);
          // Windows refuses to delete a directory a just-exited process still holds;
          // leaving a throwaway scaffold behind is not a failure.
          if (!keepTemp) {
            try {
              rmSync(project, { recursive: true, force: true });
            } catch {
              // Temp dirs are collected by the OS; the grading already happened.
            }
          }
        }
      }
      const withScores = arms.with.map((arm) => arm.score);
      results.cases.push({
        name: evalCase.name,
        tags: evalCase.tags,
        arms,
        score: withScores.reduce((sum, score) => sum + score, 0) / withScores.length,
        passed: arms.with.every((arm) => arm.passed),
      });
    }
  }

  const scores = results.cases.map((entry) => entry.score);
  results.aggregates = {
    cases: results.cases.length,
    passed: results.cases.filter((entry) => entry.passed).length,
    meanScore: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0,
  };

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  log(`\n${results.aggregates.passed}/${results.aggregates.cases} cases pass; mean ${results.aggregates.meanScore.toFixed(2)}; results in ${outputDir}`);

  if (args.includes("--json")) console.log(JSON.stringify(results.aggregates));
  // Exit codes, in cc's spirit: 0 everything at or above the threshold, 1 nothing
  // passed (or nothing could be graded), 2 partial — some cases passed, some did not.
  const anyGraders = results.cases.some((entry) => Object.values(entry.arms).some((arms) => arms.some((arm) => arm.graders.length > 0)));
  if (!anyGraders) return 1;
  if (results.aggregates.passed === results.aggregates.cases && results.aggregates.meanScore >= threshold) return 0;
  if (results.aggregates.passed === 0) return 1;
  return 2;
}

export { collectSession, gradeArm, loadCases };
process.exitCode = main();

// Referenced so the paths above are the ones the tests and the doctor use.
export const evalPaths = { caseDir, sessionsRoot: sessionsRootPath(homedir()), sessionDirName };
