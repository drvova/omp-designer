/**
 * Graders: the part of an eval that decides whether a session did the thing.
 *
 * claude-code's `plugin eval` runs each case in a fresh session and scores it with
 * small declarative graders — `regex`, `tool_used`, `tool_order`, `file_exists`,
 * `llm`, `baseline` — each naming the field it reads (`last_message`, `trace`,
 * `files`, a produced file's contents). The shape is worth copying exactly,
 * because it makes an eval readable and diffable instead of a pile of assertions.
 *
 * Three graders here are ours, because they encode this project's own contract and
 * no generic pattern expresses them:
 *
 *   driver_ran         the session actually rendered the page (a `designer_check`
 *                      call, or the driver's trace, or a driver report on disk)
 *   captures_fresh     captures exist AND are newer than the last source edit
 *   claims_consistent  nothing in the run contradicts its own record
 *
 * A grader that cannot run reports `skipped` with a reason — never a pass. That is
 * the same rule the extension holds the model to; the harness does not get an
 * exemption from it.
 */

import { globToRegExp } from "./glob-match.mjs";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Minimal `key: value` frontmatter. Lists are comma-separated, quoted values are unwrapped. */
export function parseFrontmatter(text) {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return { data: {}, body: text };
  const data = {};
  for (const line of match[1].split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf(":");
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let raw = trimmed.slice(separator + 1).trim();
    if (raw.startsWith("[") && raw.endsWith("]")) {
      data[key] = raw.slice(1, -1).split(",").map((entry) => entry.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      continue;
    }
    if (/^-?\d+(\.\d+)?$/.test(raw)) {
      data[key] = Number(raw);
      continue;
    }
    if (raw === "true" || raw === "false") {
      data[key] = raw === "true";
      continue;
    }
    data[key] = raw.replace(/^["']|["']$/g, "");
  }
  return { data, body: text.slice(match[0].length) };
}

/** Parse one case: its prompt and its graders. */
export function parseCase({ promptText, graders = [], name = "" }) {
  const { data, body } = parseFrontmatter(promptText);
  return {
    name: String(data.name || name || "case"),
    tags: Array.isArray(data.tags) ? data.tags : [],
    runs: Number(data.runs ?? 1),
    maxTurns: Number(data.max_turns ?? 0),
    timeoutSeconds: Number(data.timeout_seconds ?? 600),
    model: String(data.model ?? ""),
    allowedTools: String(data.allowed_tools ?? ""),
    prompt: body.trim(),
    graders: graders.map((grader) => ({
      name: grader.name,
      ...parseFrontmatter(grader.text).data,
      rubric: parseFrontmatter(grader.text).body.trim(),
    })),
  };
}

const asText = (value) => (typeof value === "string" ? value : JSON.stringify(value ?? ""));

/** The field a grader reads, mirroring cc's `target` idea. */
function targetText(session, target) {
  if (target === "trace") return (session.trace ?? []).map((entry) => asText(entry)).join("\n");
  if (target === "tool_calls") return (session.toolCalls ?? []).map((call) => asText(call)).join("\n");
  if (target === "any") {
    return [
      session.lastMessage ?? "",
      targetText(session, "trace"),
      targetText(session, "tool_calls"),
    ].join("\n");
  }
  return session.lastMessage ?? "";
}

function fileContents(session, path) {
  const files = session.files ?? {};
  if (Object.hasOwn(files, path)) return files[path];
  const match = Object.keys(files).find((key) => key.split("\\").join("/").endsWith(path));
  return match ? files[match] : null;
}

const result = (grader, passed, detail, extra = {}) => ({
  name: grader.name,
  type: grader.type,
  passed,
  score: passed ? 1 : 0,
  detail,
  ...extra,
});

function gradeRegex(grader, session) {
  const flags = String(grader.flags ?? "").replace(/[^gimsuy]/g, "");
  const source = targetText(session, grader.target ?? "last_message");
  const pattern = new RegExp(String(grader.pattern ?? ""), flags);
  const matches = source.match(new RegExp(pattern.source, flags.includes("g") ? flags : `${flags}g`)) ?? [];
  const mode = String(grader.match ?? "contains");
  if (mode === "not_contains") {
    return result(grader, matches.length === 0, matches.length === 0 ? "pattern absent" : `pattern present ${matches.length}x: ${matches[0].slice(0, 80)}`);
  }
  if (mode.startsWith("count:")) {
    const expected = Number(mode.split(":")[1]);
    return result(grader, matches.length === expected, `found ${matches.length}, expected ${expected}`);
  }
  return result(grader, matches.length > 0, matches.length > 0 ? `matched: ${matches[0].slice(0, 80)}` : "pattern not found");
}

function gradeToolUsed(grader, session) {
  const wanted = String(grader.tool ?? "");
  const inputMatch = grader.input_match ? new RegExp(String(grader.input_match)) : null;
  const calls = (session.toolCalls ?? []).filter((call) => {
    if (String(call.name) !== wanted) return false;
    return inputMatch ? inputMatch.test(asText(call.input)) : true;
  });
  const min = Number(grader.min ?? 1);
  const max = grader.max === undefined ? Infinity : Number(grader.max);
  const passed = calls.length >= min && calls.length <= max;
  return result(grader, passed, `${wanted} called ${calls.length}x (want ${min}..${max === Infinity ? "n" : max})`);
}

function gradeToolOrder(grader, session) {
  const names = (session.toolCalls ?? []).map((call) => String(call.name));
  const before = names.indexOf(String(grader.before ?? ""));
  const after = names.indexOf(String(grader.after ?? ""));
  if (before < 0 || after < 0) {
    return result(grader, false, `needs both: ${grader.before}=${before}, ${grader.after}=${after}`);
  }
  return result(grader, before < after, `${grader.before} at ${before}, ${grader.after} at ${after}`);
}

function gradeFileExists(grader, session) {
  const pattern = globToRegExp(String(grader.path ?? "*"));
  const created = (session.createdFiles ?? []).map((path) => path.split("\\").join("/"));
  const hits = created.filter((path) => pattern.test(path));
  const min = Number(grader.min ?? 1);
  const passed = hits.length >= min;
  return result(grader, passed, `${hits.length} created file(s) match ${grader.path} (want >= ${min})`);
}

function gradeTraceEvent(grader, session) {
  const event = String(grader.event ?? "");
  const hits = (session.trace ?? []).filter((entry) => String(entry.event) === event);
  const min = Number(grader.min ?? 1);
  const max = grader.max === undefined ? Infinity : Number(grader.max);
  const passed = hits.length >= min && hits.length <= max;
  return result(grader, passed, `${event} seen ${hits.length}x (want ${min}..${max === Infinity ? "n" : max})`);
}

/**
 * The session rendered the page: a `designer_check` call, the driver's trace, or a
 * driver report on disk. Any one of them is the evidence; "it said it looked"
 * is not.
 */
function gradeDriverRan(grader, session) {
  const checkCalls = (session.toolCalls ?? []).filter((call) => String(call.name) === "designer_check").length;
  const checkTraces = (session.trace ?? []).filter((entry) => String(entry.event) === "designer_check").length;
  const driver = session.driver ?? null;
  const evidence = checkCalls + checkTraces + (driver ? 1 : 0);
  const min = Number(grader.min ?? 1);
  const passed = evidence >= min;
  const how = [
    checkCalls ? `${checkCalls} designer_check call(s)` : "",
    checkTraces ? `${checkTraces} designer_check trace(s)` : "",
    driver ? "a driver report on disk" : "",
  ].filter(Boolean).join(", ") || "nothing";
  return result(grader, passed, `evidence: ${how}`);
}

/** Captures exist and are newer than the last source edit. */
function gradeCapturesFresh(grader, session) {
  const captures = session.captures ?? null;
  if (!captures) {
    return result(grader, false, "skipped: the session record carries no capture information", { skipped: "no capture data" });
  }
  const count = Number(grader.count ?? 1);
  if ((captures.files ?? []).length < count) {
    return result(grader, false, `${(captures.files ?? []).length} capture(s), want >= ${count}`);
  }
  if (typeof captures.newestCapture !== "number" || typeof captures.newestSourceEdit !== "number") {
    return result(grader, false, "skipped: capture or source timestamps unavailable", { skipped: "no timestamps" });
  }
  const passed = captures.newestCapture >= captures.newestSourceEdit;
  const age = Math.round((captures.newestCapture - captures.newestSourceEdit) / 1000);
  return result(grader, passed, passed
    ? `newest capture is ${age}s after the last source edit`
    : `newest capture is ${Math.abs(age)}s BEFORE the last source edit — the page changed after it was looked at`);
}

/** Nothing in the run contradicts its own record. */
function gradeClaimsConsistent(grader, session) {
  const mismatches = (session.trace ?? []).filter((entry) => String(entry.event) === "claim_mismatch");
  const banned = Array.isArray(grader.phrases) ? grader.phrases : [];
  const message = session.lastMessage ?? "";
  const spoken = banned.filter((phrase) => new RegExp(String(phrase), "i").test(message));
  const passed = mismatches.length === 0 && spoken.length === 0;
  const why = [
    mismatches.length ? `${mismatches.length} claim_mismatch event(s)` : "",
    spoken.length ? `phrases: ${spoken.join(", ")}` : "",
  ].filter(Boolean).join("; ");
  return result(grader, passed, passed ? "no contradiction between the summary and the record" : why);
}

/** Optional judge: needs a command; without one it skips, loudly. */
function gradeLlm(grader, session, { judge } = {}) {
  if (!judge) {
    return result(grader, false, "skipped: no judge configured (set DESIGNER_EVAL_JUDGE_CMD)", { skipped: "no judge" });
  }
  const verdict = judge({
    criteria: String(grader.criteria ?? grader.rubric ?? ""),
    focus: String(grader.focus ?? "last_message"),
    message: session.lastMessage ?? "",
  });
  return result(grader, verdict.passed === true, verdict.detail ?? (verdict.passed ? "judge passed" : "judge failed"));
}

const GRADERS = {
  regex: gradeRegex,
  tool_used: gradeToolUsed,
  tool_order: gradeToolOrder,
  file_exists: gradeFileExists,
  trace_event: gradeTraceEvent,
  driver_ran: gradeDriverRan,
  captures_fresh: gradeCapturesFresh,
  claims_consistent: gradeClaimsConsistent,
  llm: gradeLlm,
};

export const GRADER_TYPES = Object.freeze(Object.keys(GRADERS));

/** Run every grader in a case against one session record. */
export function gradeSession(graderList, session, options = {}) {
  const results = [];
  for (const grader of graderList) {
    const runner = GRADERS[grader.type];
    if (!runner) {
      results.push({ name: grader.name, type: grader.type, passed: false, score: 0, detail: `skipped: unknown grader type "${grader.type}"`, skipped: "unknown type" });
      continue;
    }
    try {
      results.push(runner(grader, session, options));
    } catch (error) {
      results.push({ name: grader.name, type: grader.type, passed: false, score: 0, detail: `grader threw: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return results;
}

/** A case passes when every grader passes; skipped graders count as not passed. */
export function scoreCase(graderResults) {
  const graded = graderResults.filter((entry) => !entry.skipped);
  const passed = graderResults.filter((entry) => entry.passed).length;
  return {
    score: graderResults.length === 0 ? 0 : passed / graderResults.length,
    passed: graderResults.every((entry) => entry.passed),
    skipped: graderResults.filter((entry) => entry.skipped).map((entry) => `${entry.name}: ${entry.skipped}`),
    failed: graderResults.filter((entry) => !entry.passed && !entry.skipped).map((entry) => entry.name),
    graded: graded.length,
  };
}
