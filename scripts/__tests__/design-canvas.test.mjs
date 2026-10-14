#!/usr/bin/env node
/**
 * The canvas: boards collected from what the project actually has, laid out
 * deterministically, and rendered into one page.
 *
 * The two failure classes this pins are the ones that make a surface useless:
 * a layout that shuffles between builds (so nothing is where you left it), and
 * markup that trusts a filename (a board named `"><script>` is a real filename).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCanvas,
  CANVAS_HTML_FILE,
  CANVAS_INDEX_FILE,
  collectBoards,
  layoutBoards,
  readCanvasIndex,
  renderCanvasHtml,
  writeCanvasFiles,
} from "../../shared/design-canvas.mjs";

let checks = 0;
const ok = (label, fn) => {
  fn();
  checks += 1;
  console.log(`ok - ${label}`);
};

const dirs = [];
const makeDir = (label) => {
  const dir = mkdtempSync(join(tmpdir(), `canvas-${label}-`));
  dirs.push(dir);
  return dir;
};

const goodReport = {
  version: 1,
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
};

const makeProject = ({ report = goodReport, boards = ["Home.dc.html", "Pricing.dc.html"], captures = ["desktop-1440.png", "mobile-375.png"] } = {}) => {
  const dir = makeDir("proj");
  mkdirSync(join(dir, "project"), { recursive: true });
  mkdirSync(join(dir, "screenshots"), { recursive: true });
  for (const name of boards) writeFileSync(join(dir, "project", name), "<div>board</div>");
  for (const name of captures) writeFileSync(join(dir, "screenshots", name), "png");
  if (report) writeFileSync(join(dir, "screenshots", "driver-report.json"), JSON.stringify(report));
  return dir;
};

ok("authored boards come first, then the captures the driver reported", () => {
  const dir = makeProject();
  const collected = collectBoards(dir, "Atelier");
  assert.equal(collected.title, "Atelier");
  assert.deepEqual(collected.boards.map((board) => board.name), ["Home.dc.html", "Pricing.dc.html", "desktop-1440", "mobile-375"]);
  assert.equal(collected.boards[0].kind, "board");
  assert.equal(collected.boards[2].kind, "capture");
  assert.equal(collected.boards[2].width, 1440);
  assert.match(String(collected.boards[2].note), /driver ok/);
});

ok("a failed driver run is visible on the board it produced", () => {
  const dir = makeProject({ report: { ...goodReport, ok: false, reason: "url-unreachable", captures: [] } });
  const collected = collectBoards(dir, "");
  assert.equal(collected.boards.length, 2, "no captures when the driver produced none");
  const failing = makeProject({ report: { ...goodReport, ok: false, reason: "blank-capture", captures: [{ path: "screenshots/desktop-1440.png", width: 1440, blank: true }] } });
  const flagged = collectBoards(failing, "").boards.find((board) => board.kind === "capture");
  assert.match(String(flagged?.note), /driver failed: blank-capture/);
  assert.match(String(flagged?.note), /capture is blank/);
});

ok("without a report the screenshots directory is still shown", () => {
  const dir = makeProject({ report: null });
  const collected = collectBoards(dir, "");
  const captures = collected.boards.filter((board) => board.kind === "capture");
  assert.equal(captures.length, 2);
  assert.match(String(captures[0].note), /no driver report/);
});

ok("layout is deterministic and wraps into columns", () => {
  const boards = [{ name: "a" }, { name: "b" }, { name: "c" }];
  const first = layoutBoards(boards);
  const second = layoutBoards(boards);
  assert.deepEqual(first, second);
  assert.equal(first.boards.a.y, first.boards.b.y);
  assert.ok(first.boards.b.x > first.boards.a.x);
  assert.ok(first.boards.c.y > first.boards.a.y);
  assert.deepEqual(first.order, ["a", "b", "c"]);
});

ok("a hostile board name is escaped in markup and in the embedded index", () => {
  const hostile = '"><script>alert(1)</script>';
  const boards = [{ name: hostile, kind: "board", href: "project/x.dc.html", width: 760, height: 520, note: "board file" }];
  const index = layoutBoards(boards);
  index.cell = { width: 760, height: 520, gap: 64, margin: 48 };
  const html = renderCanvasHtml({ title: "<b>t</b>", boards, index, generatedAt: "2026-10-13T00:00:00.000Z" });
  assert.ok(!html.includes("<script>alert(1)</script>"), "raw script tag must not survive");
  assert.ok(html.includes("&lt;script&gt;"), "it should appear escaped");
  assert.ok(html.includes("&lt;b&gt;t&lt;/b&gt;"), "title escaped too");
  assert.ok(html.includes("window.__canvas ="), "index embedded for tooling");
});

ok("the writer produces both files, and the read-back reports boards and age", () => {
  const dir = makeProject();
  const written = writeCanvasFiles(dir, { title: "Atelier" });
  assert.equal(written.boards, 4);
  assert.equal(readFileSync(written.htmlPath, "utf8").includes("Atelier"), true);
  const index = JSON.parse(readFileSync(written.indexPath, "utf8"));
  assert.equal(index.v, 1);
  assert.deepEqual(index.order, ["Home.dc.html", "Pricing.dc.html", "desktop-1440", "mobile-375"]);
  const readBack = readCanvasIndex(dir);
  assert.equal(readBack?.boards, 4);
  assert.equal(readBack?.ageMinutes, 0);
  assert.equal(readBack?.htmlExists, true);
  assert.ok((readBack?.htmlBytes ?? 0) > 0);
});

ok("an empty project still builds a canvas that says so", () => {
  const dir = makeDir("empty");
  const built = buildCanvas({ cwd: dir, title: "", generatedAt: "2026-10-13T00:00:00.000Z" });
  assert.equal(built.boards.length, 0);
  assert.match(built.html, /No boards yet/);
  assert.equal(readCanvasIndex(dir), null, "nothing written yet");
  writeCanvasFiles(dir);
  const readBack = readCanvasIndex(dir);
  assert.equal(readBack?.boards, 0);
  assert.equal(readBack?.htmlExists, true);
});

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
console.log(`\n${checks} canvas checks passed`);
