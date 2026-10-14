#!/usr/bin/env node
/**
 * The check payload: what the model actually reads after calling `designer_check`.
 *
 * The point of returning this in a tool result is that the model can act on it
 * while the work is open, so the wording has to be unambiguous about three things:
 * whether the page rendered at all, what the captures are (a missing capture is
 * not evidence), and which findings are warnings rather than failures.
 */
import assert from "node:assert/strict";
import { formatCheckResult, summarizeCheck } from "../../shared/designer-check.mjs";

let checks = 0;
const ok = (label, fn) => {
  fn();
  checks += 1;
  console.log(`ok - ${label}`);
};

const cleanReport = {
  ok: true,
  reason: "ok",
  url: "http://localhost:5173",
  captures: [
    { path: "screenshots/desktop-1440.png", width: 1440, blank: false },
    { path: "screenshots/mobile-375.png", width: 375, blank: false },
  ],
  consoleErrors: [],
  pageErrors: [],
  failedRequests: [],
  diagnostics: {},
};

ok("a clean run says the page rendered and lists no problems", () => {
  const result = formatCheckResult(cleanReport);
  assert.equal(result.ok, true);
  assert.deepEqual(result.counts, { failures: 0, warnings: 0 });
  assert.match(result.text, /Rendered page: ok at http:\/\/localhost:5173/);
  assert.match(result.text, /2 captures|Captures \(2\)/);
  assert.match(result.text, /no console errors, page errors, or failed requests/);
  assert.match(result.text, /no overflow past the viewport and no text under 3:1 contrast/);
});

ok("a failed render is stated as a failure, not an absence", () => {
  const result = formatCheckResult({
    ...cleanReport,
    ok: false,
    reason: "url-unreachable",
    error: "http://localhost:5173 did not answer within 30000ms",
    captures: [],
  });
  assert.equal(result.ok, false);
  assert.match(result.text, /FAILED — url-unreachable: http:\/\/localhost:5173 did not answer/);
  assert.match(result.text, /the page was never captured, so nothing here is evidence/);
  assert.match(result.text, /do not report a rendered result you have not seen/);
});

ok("a blank capture is named as blank, not counted as a capture", () => {
  const result = formatCheckResult({
    ...cleanReport,
    ok: false,
    reason: "blank-capture",
    captures: [
      { path: "screenshots/desktop-1440.png", width: 1440, blank: true },
      { path: "screenshots/mobile-375.png", width: 375, blank: false },
    ],
  });
  assert.equal(result.ok, false);
  assert.match(result.text, /desktop-1440\.png — 1440px \(desktop\) — BLANK/);
  assert.match(result.text, /mobile-375\.png — 375px \(phone\)/);
  assert.equal(result.counts.failures, 1);
});

ok("console errors and failed requests are failures; layout findings are warnings", () => {
  const result = formatCheckResult({
    ...cleanReport,
    consoleErrors: ["Uncaught TypeError: x is undefined"],
    failedRequests: ["http://localhost:5173/missing.png net::ERR_ABORTED"],
    diagnostics: {
      "375": {
        overflowing: [{ element: "div.past", right: 948, width: 900 }],
        lowContrast: [{ text: "pale line", element: "p", ratio: 1.54, color: "rgb(207,201,192)", background: "rgb(250,247,242)" }],
      },
      "1440": { overflowing: [], lowContrast: [] },
    },
  });
  assert.equal(result.ok, false, "console and failed requests are failures");
  assert.deepEqual(result.counts, { failures: 2, warnings: 2 });
  assert.match(result.text, /console error: Uncaught TypeError/);
  assert.match(result.text, /failed request: http:\/\/localhost:5173\/missing\.png/);
  assert.match(result.text, /375px: div\.past runs 573px past the right edge \(element width 900px\)/);
  assert.match(result.text, /375px: "pale line" is 1.54:1 on rgb\(250,247,242\) — below the 3:1 floor/);
  assert.match(result.text, /Do the fixes above, then call designer_check again/);
});

ok("layout warnings alone leave the page passing", () => {
  const result = formatCheckResult({
    ...cleanReport,
    diagnostics: { "375": { overflowing: [{ element: "span.wide", right: 400, width: 380 }], lowContrast: [] } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.counts.warnings, 1);
  assert.match(result.text, /a warning is a finding, not a blocker/);
  assert.match(result.text, /375px: span\.wide runs 25px past the right edge/);
});

ok("a missing report tells the model how to run the check itself", () => {
  const result = formatCheckResult(null, { project: "G:/site" });
  assert.equal(result.ok, false);
  assert.match(result.text, /could not read a driver report/);
  assert.match(result.text, /node scripts\/designer-driver\.mjs/);
  assert.match(result.text, /Project: G:\/site/);
});

ok("the one-line summary distinguishes never-run, ok, and failed", () => {
  assert.equal(summarizeCheck(null), "never run");
  assert.equal(summarizeCheck(cleanReport), "ok (2 captures, 0 console problems)");
  assert.equal(
    summarizeCheck({ ...cleanReport, consoleErrors: ["boom"], diagnostics: { "375": { overflowing: [{}], lowContrast: [{}] } } }),
    "ok (2 captures, 1 console problem, 2 layout warnings)",
  );
  assert.equal(summarizeCheck({ ...cleanReport, ok: false, reason: "blank-capture" }), "failed: blank-capture");
});

console.log(`\n${checks} designer-check checks passed`);
