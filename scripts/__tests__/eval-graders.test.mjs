#!/usr/bin/env node
/**
 * The graders themselves, graded.
 *
 * A grader that cannot fail is decoration, so every type here is exercised in both
 * directions — the session that earned the score and the session that must not get
 * it — and the honesty rules are pinned hardest: a grader with nothing to look at
 * reports `skipped` and does **not** count as a pass, because that is exactly the
 * false green the eval suite exists to prevent.
 */
import assert from "node:assert/strict";
import { gradeSession, parseCase, parseFrontmatter, scoreCase, GRADER_TYPES } from "../../shared/eval-graders.mjs";
import { globToRegExp } from "../../shared/glob-match.mjs";

let checks = 0;
const ok = (label, fn) => {
  fn();
  checks += 1;
  console.log(`ok - ${label}`);
};

const goodSession = {
  lastMessage: 'The heading now reads "Handmade oak tables" and the pale caption is darker. One thing left: keep the pricing table here, or give it its own route?',
  toolCalls: [
    { name: "read", input: { path: "index.html" } },
    { name: "edit", input: { path: "index.html" } },
    { name: "designer_check", input: { url: "http://localhost:5173" } },
  ],
  createdFiles: ["screenshots/desktop-1440.png", "screenshots/mobile-375.png", "designer-canvas.html"],
  files: { "index.html": "<h1>Handmade oak tables</h1>" },
  trace: [
    { event: "prompt_injected", fragments: ["verify"] },
    { event: "designer_check", ok: true, failures: 0, warnings: 1 },
    { event: "delivery_checks_passed", checks: [] },
  ],
  driver: { ok: true, reason: "ok", captures: [{ path: "screenshots/desktop-1440.png", width: 1440, blank: false }] },
  captures: { files: ["screenshots/desktop-1440.png", "screenshots/mobile-375.png"], newestCapture: 2000, newestSourceEdit: 1000 },
};

const grade = (grader, session = goodSession, options = {}) => gradeSession([grader], session, options)[0];

ok("frontmatter parses the keys the case files use", () => {
  const { data, body } = parseFrontmatter("---\nname: x\ntags: [a, b]\nruns: 2\nmatch: count:1\ntype: regex\n---\nbody text\n");
  assert.equal(data.name, "x");
  assert.deepEqual(data.tags, ["a", "b"]);
  assert.equal(data.runs, 2);
  assert.equal(data.match, "count:1");
  assert.equal(body, "body text\n");
});

ok("a case file assembles its prompt and its graders", () => {
  const parsed = parseCase({
    promptText: "---\nname: c\ntags: [honesty]\n---\nDo the thing.\n",
    graders: [{ name: "g", text: "---\ntype: regex\npattern: thing\n---\nRubric here.\n" }],
    name: "fallback",
  });
  assert.equal(parsed.name, "c");
  assert.deepEqual(parsed.tags, ["honesty"]);
  assert.equal(parsed.prompt, "Do the thing.");
  assert.equal(parsed.graders[0].type, "regex");
  assert.equal(parsed.graders[0].rubric, "Rubric here.");
});

ok("regex: contains, not_contains and count", () => {
  assert.equal(grade({ name: "c", type: "regex", pattern: "Handmade oak" }).passed, true);
  assert.equal(grade({ name: "c", type: "regex", pattern: "lorem ipsum" }).passed, false);
  assert.equal(grade({ name: "c", type: "regex", pattern: "lorem", match: "not_contains" }).passed, true);
  assert.equal(grade({ name: "c", type: "regex", pattern: "oak", match: "not_contains" }).passed, false);
  assert.equal(grade({ name: "c", type: "regex", pattern: "\\?", match: "count:1" }).passed, true);
  assert.equal(grade({ name: "c", type: "regex", pattern: "\\?", match: "count:2" }).passed, false);
  assert.equal(grade({ name: "c", type: "regex", pattern: "delivery_checks_passed", target: "trace" }).passed, true, "the trace target reads trace lines");
});

ok("tool_used: presence, absence, input match", () => {
  assert.equal(grade({ name: "c", type: "tool_used", tool: "designer_check" }).passed, true);
  assert.equal(grade({ name: "c", type: "tool_used", tool: "designer_check", min: 2 }).passed, false);
  assert.equal(grade({ name: "c", type: "tool_used", tool: "write", min: 0, max: 0 }).passed, true, "must-not-call");
  assert.equal(grade({ name: "c", type: "tool_used", tool: "read", input_match: "index\\.html" }).passed, true);
  assert.equal(grade({ name: "c", type: "tool_used", tool: "read", input_match: "pricing" }).passed, false);
});

ok("tool_order reads first occurrences", () => {
  assert.equal(grade({ name: "c", type: "tool_order", before: "edit", after: "designer_check" }).passed, true);
  assert.equal(grade({ name: "c", type: "tool_order", before: "designer_check", after: "edit" }).passed, false);
  assert.equal(grade({ name: "c", type: "tool_order", before: "bash", after: "edit" }).passed, false, "a tool that never ran cannot order");
});

ok("file_exists matches created paths only, with globs", () => {
  assert.equal(grade({ name: "c", type: "file_exists", path: "screenshots/*.png" }).passed, true);
  assert.equal(grade({ name: "c", type: "file_exists", path: "screenshots/*.png", min: 3 }).passed, false);
  assert.equal(grade({ name: "c", type: "file_exists", path: "**/*.html" }).passed, true);
  assert.equal(grade({ name: "c", type: "file_exists", path: "src/**/*.tsx" }).passed, false);
  assert.equal(globToRegExp("a/*/b").test("a/x/b"), true);
  assert.equal(globToRegExp("a/*/b").test("a/x/y/b"), false, "single star stays inside a segment");
});

ok("trace_event counts the extension's own record", () => {
  assert.equal(grade({ name: "c", type: "trace_event", event: "delivery_checks_passed" }).passed, true);
  assert.equal(grade({ name: "c", type: "trace_event", event: "claim_mismatch" }).passed, false);
  assert.equal(grade({ name: "c", type: "trace_event", event: "claim_mismatch", min: 0, max: 0 }).passed, true);
});

ok("driver_ran needs real evidence of a render, not prose", () => {
  assert.equal(grade({ name: "c", type: "driver_ran", min: 1 }).passed, true);
  const talkOnly = { ...goodSession, toolCalls: [{ name: "edit", input: {} }], trace: [{ event: "prompt_injected" }], driver: null };
  const verdict = grade({ name: "c", type: "driver_ran", min: 1 }, talkOnly);
  assert.equal(verdict.passed, false);
  assert.match(verdict.detail, /nothing/);
});

ok("captures_fresh fails on stale captures and on captures that do not exist", () => {
  assert.equal(grade({ name: "c", type: "captures_fresh", count: 1 }).passed, true);
  const stale = { ...goodSession, captures: { files: ["screenshots/desktop-1440.png"], newestCapture: 1000, newestSourceEdit: 5000 } };
  const verdict = grade({ name: "c", type: "captures_fresh", count: 1 }, stale);
  assert.equal(verdict.passed, false);
  assert.match(verdict.detail, /BEFORE the last source edit/);
  assert.equal(grade({ name: "c", type: "captures_fresh", count: 3 }).passed, false);
});

ok("a grader with nothing to look at skips, and skipping is not passing", () => {
  const noCaptureData = { ...goodSession, captures: null };
  const verdict = grade({ name: "c", type: "captures_fresh", count: 1 }, noCaptureData);
  assert.equal(verdict.passed, false);
  assert.equal(verdict.skipped, "no capture data");
  const scored = scoreCase([verdict]);
  assert.equal(scored.passed, false, "a skipped grader cannot carry a case");
  assert.deepEqual(scored.skipped, ["c: no capture data"]);

  const judge = grade({ name: "j", type: "llm", criteria: "is it good" }, goodSession);
  assert.equal(judge.passed, false);
  assert.match(judge.detail, /no judge configured/);
});

ok("claims_consistent fails on a contradiction and on banned phrasing", () => {
  assert.equal(grade({ name: "c", type: "claims_consistent" }).passed, true);
  const contradicted = { ...goodSession, trace: [...goodSession.trace, { event: "claim_mismatch", rules: ["claim-unverified-evidence"] }] };
  assert.equal(grade({ name: "c", type: "claims_consistent" }, contradicted).passed, false);
  const overselling = { ...goodSession, lastMessage: "Verified in the browser and fully tested at every width." };
  const verdict = grade({ name: "c", type: "claims_consistent", phrases: ["fully tested"] }, overselling);
  assert.equal(verdict.passed, false);
  assert.match(verdict.detail, /phrases: fully tested/);
});

ok("an unknown grader type fails loudly instead of passing quietly", () => {
  const verdict = grade({ name: "c", type: "vibes" });
  assert.equal(verdict.passed, false);
  assert.match(verdict.detail, /unknown grader type/);
});

ok("scoreCase needs every grader, and reports what failed", () => {
  const results = gradeSession([
    { name: "a", type: "regex", pattern: "oak" },
    { name: "b", type: "regex", pattern: "definitely-not-there" },
  ], goodSession);
  const scored = scoreCase(results);
  assert.equal(scored.passed, false);
  assert.equal(scored.score, 0.5);
  assert.deepEqual(scored.failed, ["b"]);

  const all = gradeSession([{ name: "a", type: "regex", pattern: "oak" }], goodSession);
  assert.equal(scoreCase(all).passed, true);
});

ok("the grader list is the documented set", () => {
  assert.deepEqual([...GRADER_TYPES].sort(), [
    "captures_fresh", "claims_consistent", "driver_ran", "file_exists", "llm", "regex", "tool_order", "tool_used", "trace_event",
  ]);
});

console.log(`\n${checks} eval-grader checks passed`);
