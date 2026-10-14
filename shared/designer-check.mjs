/**
 * The check result: what a `designer_check` call hands back to the model.
 *
 * claude-code's equivalent is `ArtifactCheck`, and the reason it matters is
 * *where* the answer lands: in the tool result, mid-turn, while the work is still
 * open. omp-designer's diagnostics used to exist only in the stop record, which
 * the model sees after it has finished — too late to be useful. This module turns
 * a driver report into the same field list cc's preview returns, so the model can
 * read it and fix the page before it says it is done.
 *
 * Pure by design: the caller runs the driver and passes the report in, so the
 * wording and the verdict rules are testable without a browser.
 */

const WIDTH_LABEL = (width) => (width >= 1000 ? "desktop" : "phone");

/**
 * @param {null | {
 *   ok: boolean, reason: string, url?: string | null, error?: string | null,
 *   captures?: Array<{ path: string, width?: number | null, blank?: boolean }>,
 *   consoleErrors?: string[], pageErrors?: string[], failedRequests?: string[],
 *   diagnostics?: Record<string, { overflowing?: any[], lowContrast?: any[] }>,
 * }} report
 * @param {{ url?: string, project?: string, exitCode?: number | null }} [context]
 * @returns {{ ok: boolean, text: string, counts: { failures: number, warnings: number } }}
 */
export function formatCheckResult(report, { url = "", project = "", exitCode = null } = {}) {
  if (!report) {
    return {
      ok: false,
      text: [
        "designer_check could not read a driver report.",
        `Run it directly to see what happened: node scripts/designer-driver.mjs --start "<the project's start command>" --url <url>`,
        project ? `Project: ${project}` : "",
      ].filter(Boolean).join("\n"),
      counts: { failures: 1, warnings: 0 },
    };
  }

  const lines = [];
  const captures = report.captures ?? [];
  const consoleProblems = (report.consoleErrors?.length ?? 0) + (report.pageErrors?.length ?? 0);
  const failedRequests = report.failedRequests ?? [];
  const blanks = captures.filter((capture) => capture.blank);
  const diagnostics = report.diagnostics ?? {};
  // `viewport` and the element's own `width` are different numbers; naming them
  // apart is what keeps the report from saying "900px runs past the edge" about a
  // phone-width finding.
  const overflowing = Object.entries(diagnostics).flatMap(([viewport, entry]) =>
    (entry.overflowing ?? []).map((item) => ({ ...item, viewport })));
  const lowContrast = Object.entries(diagnostics).flatMap(([viewport, entry]) =>
    (entry.lowContrast ?? []).map((item) => ({ ...item, viewport })));

  // Count what went wrong, not that the run also reported itself as failed: one
  // blank capture is one failure, never two. The generic failure is added only
  // when nothing more specific explains it (an unreachable URL, a dead browser).
  const specific = consoleProblems + failedRequests.length + blanks.length;
  const failures = specific > 0 ? specific : report.ok ? 0 : 1;
  const warnings = overflowing.length + lowContrast.length;

  lines.push(report.ok === false
    ? `Rendered page: FAILED — ${report.reason}${report.error ? `: ${report.error}` : ""}`
    : `Rendered page: ok${report.url ? ` at ${report.url}` : url ? ` at ${url}` : ""}`);
  lines.push("");

  lines.push(`Captures (${captures.length}):`);
  if (captures.length === 0) lines.push("  none — the page was never captured, so nothing here is evidence of how it looks");
  for (const capture of captures) {
    const width = typeof capture.width === "number" ? `${capture.width}px (${WIDTH_LABEL(capture.width)})` : "unknown width";
    lines.push(`  ${capture.path} — ${width}${capture.blank ? " — BLANK: content is hidden at initial paint or nothing rendered" : ""}`);
  }

  lines.push("");
  lines.push("Console:");
  if (consoleProblems === 0 && failedRequests.length === 0) {
    lines.push("  no console errors, page errors, or failed requests");
  } else {
    for (const error of report.consoleErrors ?? []) lines.push(`  console error: ${error}`);
    for (const error of report.pageErrors ?? []) lines.push(`  page error: ${error}`);
    for (const request of failedRequests) lines.push(`  failed request: ${request}`);
  }

  lines.push("");
  lines.push("Layout:");
  if (warnings === 0) {
    lines.push("  no overflow past the viewport and no text under 3:1 contrast");
  } else {
    for (const item of overflowing) {
      const overshoot = Math.max(0, Math.round(Number(item.right) - Number(item.viewport)));
      lines.push(`  ${item.viewport}px: ${item.element} runs ${overshoot}px past the right edge (element width ${item.width}px)`);
    }
    for (const item of lowContrast) {
      lines.push(`  ${item.viewport}px: "${item.text}" is ${item.ratio}:1 on ${item.background} — below the 3:1 floor for readable text`);
    }
  }

  lines.push("");
  lines.push(report.ok && failures === 0
    ? "Fix anything listed above before claiming the page works; a warning is a finding, not a blocker."
    : "Do the fixes above, then call designer_check again — do not report a rendered result you have not seen.");

  return {
    ok: failures === 0,
    text: lines.join("\n"),
    counts: { failures, warnings },
  };
}

/** One line for a trace or the doctor: the last check a session ran. */
export function summarizeCheck(report) {
  if (!report) return "never run";
  const captures = report.captures?.length ?? 0;
  const problems = (report.consoleErrors?.length ?? 0) + (report.pageErrors?.length ?? 0) + (report.failedRequests?.length ?? 0);
  const warnings = Object.values(report.diagnostics ?? {})
    .reduce((sum, entry) => sum + (entry.overflowing?.length ?? 0) + (entry.lowContrast?.length ?? 0), 0);
  const blanks = (report.captures ?? []).filter((capture) => capture.blank).length;
  if (!report.ok) return `failed: ${report.reason}`;
  const parts = [`${captures} capture${captures === 1 ? "" : "s"}`, `${problems} console problem${problems === 1 ? "" : "s"}`];
  if (warnings > 0) parts.push(`${warnings} layout warning${warnings === 1 ? "" : "s"}`);
  if (blanks > 0) parts.push(`${blanks} blank`);
  return `ok (${parts.join(", ")})`;
}
