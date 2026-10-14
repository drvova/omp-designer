/**
 * The driver report: the contract between `scripts/designer-driver.mjs` (which
 * drives the app and captures it) and everything that reads the result — the
 * stop-time evidence record, `/designer-doctor`, and the tests.
 *
 * Why this exists: the claude-code harness does not ask a model to remember to
 * look at the page; it ships a driver (`chromium-cli`, a Playwright `_electron`
 * REPL, `curl`) and the skill that runs it, so a capture is produced by a
 * command instead of by willpower. omp-designer had the record that notices
 * missing evidence but nothing that produces it. This file keeps the report
 * shape pure and testable so the driver script stays thin I/O.
 *
 * A report that cannot be read is not a pass: `parseDriverReport` returns null
 * on anything malformed, and callers treat null as "no evidence", never as ok.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DRIVER_REPORT_FILE = "driver-report.json";

/** The two widths every capture set carries: a desktop read and a phone read. */
export const DRIVER_VIEWPORTS = Object.freeze([1440, 375]);

/** Exit codes `scripts/designer-driver.mjs` uses, so callers can tell them apart. */
export const DRIVER_EXIT = Object.freeze({ ok: 0, failed: 1, unusable: 2 });

/**
 * Conventional locations for a report, relative to the project root. The driver
 * writes to the first; the others are accepted because a hand-run driver is a
 * legitimate source of the same evidence.
 */
export const DRIVER_REPORT_CANDIDATES = Object.freeze([
  join("screenshots", DRIVER_REPORT_FILE),
  DRIVER_REPORT_FILE,
]);

const REASONS = new Set([
  "ok",
  "playwright-unavailable",
  "launch-failed",
  "url-unreachable",
  "blank-capture",
  "driver-error",
]);

/**
 * @param {unknown} value
 * @returns {null | {
 *   ok: boolean, reason: string, url: string | null, ranAt: string | null,
 *   settleMs: number, viewports: number[],
 *   captures: Array<{ path: string, width: number | null, blank: boolean }>,
 *   consoleErrors: string[], pageErrors: string[], failedRequests: string[],
 *   error: string | null,
 * }}
 */
export function normalizeDriverReport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = /** @type {Record<string, unknown>} */ (value);
  if (typeof record.ok !== "boolean") return null;
  const reason = typeof record.reason === "string" && REASONS.has(record.reason) ? record.reason : "driver-error";
  const strings = (input) => (Array.isArray(input) ? input.filter((entry) => typeof entry === "string") : []);
  const captures = Array.isArray(record.captures)
    ? record.captures
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => {
          const capture = /** @type {Record<string, unknown>} */ (entry);
          return {
            path: typeof capture.path === "string" ? capture.path : "",
            width: typeof capture.width === "number" ? capture.width : null,
            blank: capture.blank === true,
          };
        })
        .filter((capture) => capture.path.length > 0)
    : [];
  return {
    ok: record.ok,
    reason,
    url: typeof record.url === "string" ? record.url : null,
    ranAt: typeof record.ranAt === "string" ? record.ranAt : null,
    settleMs: typeof record.settleMs === "number" ? record.settleMs : 0,
    viewports: Array.isArray(record.viewports)
      ? record.viewports.filter((width) => typeof width === "number")
      : [],
    captures,
    diagnostics: normalizeDiagnostics(record.diagnostics),
    consoleErrors: strings(record.consoleErrors),
    pageErrors: strings(record.pageErrors),
    failedRequests: strings(record.failedRequests),
    error: typeof record.error === "string" ? record.error : null,
  };
}

const DIAGNOSTIC_LIMIT = 5;

/**
 * Overflow and low-contrast findings, keyed by viewport width. These are warnings
 * (the page rendered), so they never flip `ok`; they exist so the record can say
 * "it rendered, and the phone width has content 42px past the edge".
 */
function normalizeDiagnostics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [width, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object") continue;
    const record = /** @type {Record<string, unknown>} */ (entry);
    const overflowing = Array.isArray(record.overflowing)
      ? record.overflowing
          .filter((item) => item && typeof item === "object")
          .slice(0, DIAGNOSTIC_LIMIT)
          .map((item) => {
            const row = /** @type {Record<string, unknown>} */ (item);
            return {
              element: typeof row.element === "string" ? row.element : "unknown",
              right: typeof row.right === "number" ? row.right : 0,
              width: typeof row.width === "number" ? row.width : 0,
            };
          })
      : [];
    const lowContrast = Array.isArray(record.lowContrast)
      ? record.lowContrast
          .filter((item) => item && typeof item === "object")
          .slice(0, DIAGNOSTIC_LIMIT)
          .map((item) => {
            const row = /** @type {Record<string, unknown>} */ (item);
            return {
              text: typeof row.text === "string" ? row.text : "",
              element: typeof row.element === "string" ? row.element : "unknown",
              ratio: typeof row.ratio === "number" ? row.ratio : 0,
              color: typeof row.color === "string" ? row.color : "",
              background: typeof row.background === "string" ? row.background : "",
            };
          })
      : [];
    out[String(width)] = { overflowing, lowContrast };
  }
  return out;
}

/** How many layout warnings the run carries, across every width. */
export function driverWarnings(report) {
  let count = 0;
  for (const entry of Object.values(report?.diagnostics ?? {})) {
    count += (entry?.overflowing?.length ?? 0) + (entry?.lowContrast?.length ?? 0);
  }
  return count;
}

/**
 * Parse a report's text. Returns null for anything unreadable or malformed, so a
 * caller can never mistake a broken file for a green run.
 *
 * @param {string} text
 */
export function parseDriverReport(text) {
  try {
    return normalizeDriverReport(JSON.parse(text));
  } catch {
    return null;
  }
}

/** The report for a project, or null when none exists or none parses. */
export function readDriverReport(cwd) {
  for (const relative of DRIVER_REPORT_CANDIDATES) {
    const path = join(cwd, relative);
    if (!existsSync(path)) continue;
    try {
      const report = parseDriverReport(readFileSync(path, "utf8"));
      if (report) return { path, report };
    } catch {
      // Unreadable report: keep looking, then fall through to "no evidence".
    }
  }
  return null;
}

/**
 * Whether a capture shows a rendered page.
 *
 * Thresholds are calibrated against real pages rather than guessed: a perfectly
 * normal short page on a solid background measures ~0.6-0.88 uniform ROWS,
 * because text is sparse, so a flat "30% blank" rule flags ordinary design work.
 * The taste review can afford that threshold because it only inspects tall
 * captures; a driver sees every size. Therefore: a capture that is almost
 * entirely uniform is blank at any size, and a *tall* capture (the taste
 * review's `fullPage` heuristic) with a contiguous 30%+ band is the signature of
 * content hidden at initial paint.
 */
export function isBlankCapture(analysis) {
  const run = typeof analysis?.maxBlankRunFraction === "number" ? analysis.maxBlankRunFraction : 0;
  if (analysis?.error) return false; // unanalyzable is not the same as blank
  return run >= 0.9 || (analysis?.fullPage === true && run >= 0.3);
}

/** One line for a trace, the doctor report, or a continuation. */
export function summarizeDriver(report) {
  if (!report) return "none";
  const captures = report.captures.length;
  const problems = report.consoleErrors.length + report.pageErrors.length + report.failedRequests.length;
  const blanks = report.captures.filter((capture) => capture.blank).length;
  if (report.ok) {
    const warnings = driverWarnings(report);
    const warningClause = warnings > 0 ? `, ${warnings} layout warning${warnings === 1 ? "" : "s"}` : "";
    return `ok (${captures} capture${captures === 1 ? "" : "s"}, ${problems} console error${problems === 1 ? "" : "s"}${warningClause})`;
  }
  const why = report.error ? `${report.reason}: ${report.error}` : report.reason;
  const detail = blanks > 0 ? `${blanks} blank capture${blanks === 1 ? "" : "s"}` : `${captures} capture${captures === 1 ? "" : "s"}`;
  return `failed (${why}; ${detail})`;
}
