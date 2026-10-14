#!/usr/bin/env node
/**
 * The driver report contract: what the driver writes, what the stop record reads.
 *
 * The failure this pins is the one that matters for evidence: a report that is
 * missing, truncated, or malformed must read as "no evidence", never as success.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DRIVER_REPORT_FILE,
  isBlankCapture,
  DRIVER_VIEWPORTS,
  normalizeDriverReport,
  parseDriverReport,
  readDriverReport,
  summarizeDriver,
} from "../../shared/driver-report.mjs";

let checks = 0;
const ok = (label, fn) => {
  fn();
  checks += 1;
  console.log(`ok - ${label}`);
};

const goodReport = {
  version: 1,
  ok: true,
  reason: "ok",
  url: "http://localhost:5173",
  startedFrom: "npm run dev",
  ranAt: "2026-10-13T21:00:00.000Z",
  settleMs: 1200,
  viewports: [...DRIVER_VIEWPORTS],
  captures: [
    { path: "screenshots/desktop-1440.png", width: 1440, blank: false, height: 3200, error: null },
    { path: "screenshots/mobile-375.png", width: 375, blank: false, height: 4100, error: null },
  ],
  consoleErrors: [],
  pageErrors: [],
  failedRequests: [],
  error: null,
};

const dirs = [];
const makeDir = (label) => {
  const dir = mkdtempSync(join(tmpdir(), `driver-report-${label}-`));
  dirs.push(dir);
  return dir;
};

ok("a well-formed report normalizes to the fields the record uses", () => {
  const report = normalizeDriverReport(goodReport);
  assert.equal(report?.ok, true);
  assert.equal(report?.captures.length, 2);
  assert.equal(report?.captures[0].width, 1440);
  assert.deepEqual(report?.viewports, [1440, 375]);
});

ok("malformed reports read as no evidence, never as success", () => {
  assert.equal(parseDriverReport("{ not json"), null);
  assert.equal(parseDriverReport("null"), null);
  assert.equal(parseDriverReport("[]"), null);
  assert.equal(parseDriverReport(JSON.stringify({ reason: "ok" })), null, "missing ok flag");
  assert.equal(normalizeDriverReport({ ok: "yes" }), null, "ok must be a boolean");
});

ok("an unknown reason degrades to driver-error instead of leaking through", () => {
  const report = normalizeDriverReport({ ok: false, reason: "something-new", captures: "nope", consoleErrors: [1, "kept"] });
  assert.equal(report?.reason, "driver-error");
  assert.deepEqual(report?.captures, []);
  assert.deepEqual(report?.consoleErrors, ["kept"]);
});

ok("the summary names captures and console errors when it worked", () => {
  assert.equal(summarizeDriver(normalizeDriverReport(goodReport)), "ok (2 captures, 0 console errors)");
  const one = normalizeDriverReport({ ...goodReport, captures: [{ path: "a.png", width: 375, blank: false }], consoleErrors: ["boom"] });
  assert.equal(summarizeDriver(one), "ok (1 capture, 1 console error)");
});

ok("the summary says why it failed, and calls out blank captures", () => {
  const blank = normalizeDriverReport({
    ...goodReport,
    ok: false,
    reason: "blank-capture",
    error: "1 of 2 captures are mostly blank",
    captures: [{ path: "a.png", width: 1440, blank: true }, { path: "b.png", width: 375, blank: false }],
  });
  const line = summarizeDriver(blank);
  assert.match(line, /^failed \(blank-capture/);
  assert.match(line, /1 blank capture/);
  assert.equal(summarizeDriver(null), "none");
});

ok("a report is found in screenshots/ or at the project root", () => {
  const withFolder = makeDir("folder");
  mkdirSync(join(withFolder, "screenshots"), { recursive: true });
  writeFileSync(join(withFolder, "screenshots", DRIVER_REPORT_FILE), JSON.stringify(goodReport));
  assert.equal(readDriverReport(withFolder)?.report.ok, true);

  const atRoot = makeDir("root");
  writeFileSync(join(atRoot, DRIVER_REPORT_FILE), JSON.stringify({ ...goodReport, ok: false, reason: "url-unreachable" }));
  assert.equal(readDriverReport(atRoot)?.report.reason, "url-unreachable");
});

ok("a missing or corrupt report file is no evidence, not a pass", () => {
  const empty = makeDir("empty");
  assert.equal(readDriverReport(empty), null);

  const corrupt = makeDir("corrupt");
  mkdirSync(join(corrupt, "screenshots"), { recursive: true });
  writeFileSync(join(corrupt, "screenshots", DRIVER_REPORT_FILE), "{ half-written");
  assert.equal(readDriverReport(corrupt), null);
});

ok("the blank rule is calibrated on measured pages, not guesses", () => {
  // Measured: a normal short page is ~0.64 / 0.42 uniform rows and is fine.
  assert.equal(isBlankCapture({ maxBlankRunFraction: 0.641, fullPage: false }), false);
  assert.equal(isBlankCapture({ maxBlankRunFraction: 0.419, fullPage: false }), false);
  // A truly empty page measures 1.0 at every size.
  assert.equal(isBlankCapture({ maxBlankRunFraction: 1, fullPage: false }), true);
  // A tall capture hiding a third of the page behind a reveal bug.
  assert.equal(isBlankCapture({ maxBlankRunFraction: 0.35, fullPage: true }), true);
  // Unanalyzable is not blank: it is an unknown, reported as such.
  assert.equal(isBlankCapture({ error: "unsupported png" }), false);
  assert.equal(isBlankCapture(undefined), false);
});

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
console.log(`\n${checks} driver-report checks passed`);
