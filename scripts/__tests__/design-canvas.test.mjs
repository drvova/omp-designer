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
  serveCanvas,
  CANVAS_HTML_FILE,
  CANVAS_INDEX_FILE,
  collectBoards,
  layoutBoards,
  readCanvasIndex,
  renderCanvasHtml,
  writeCanvasFiles,
} from "../../shared/design-canvas.mjs";

let checks = 0;
// Async-aware: an un-awaited async body let the end-of-file cleanup delete a
// fixture while the server under test was still serving it, which read as the
// canvas emptying itself.
const ok = async (label, fn) => {
  await fn();
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

await ok("authored boards come first, then the captures the driver reported", () => {
  const dir = makeProject();
  const collected = collectBoards(dir, "Atelier");
  assert.equal(collected.title, "Atelier");
  assert.deepEqual(collected.boards.map((board) => board.name), ["Home.dc.html", "Pricing.dc.html", "desktop-1440", "mobile-375"]);
  assert.equal(collected.boards[0].kind, "board");
  assert.equal(collected.boards[2].kind, "capture");
  assert.equal(collected.boards[2].width, 1440);
  assert.match(String(collected.boards[2].note), /driver ok/);
});

await ok("a failed driver run is visible on the board it produced", () => {
  const dir = makeProject({ report: { ...goodReport, ok: false, reason: "url-unreachable", captures: [] } });
  const collected = collectBoards(dir, "");
  // The run produced no captures, but the two PNGs on disk are still boards: a
  // capture the report does not mention must not become invisible.
  assert.equal(collected.boards.length, 4);
  const unreported = collected.boards.filter((board) => board.kind === "capture");
  assert.equal(unreported.length, 2);
  assert.match(String(unreported[0].note), /not in the last driver run/);
  const failing = makeProject({ report: { ...goodReport, ok: false, reason: "blank-capture", captures: [{ path: "screenshots/desktop-1440.png", width: 1440, blank: true }] } });
  const flagged = collectBoards(failing, "").boards.find((board) => board.kind === "capture");
  assert.match(String(flagged?.note), /driver failed: blank-capture/);
  assert.match(String(flagged?.note), /capture is blank/);
});

await ok("without a report the screenshots directory is still shown", () => {
  const dir = makeProject({ report: null });
  const collected = collectBoards(dir, "");
  const captures = collected.boards.filter((board) => board.kind === "capture");
  assert.equal(captures.length, 2);
  assert.match(String(captures[0].note), /no driver report/);
});

await ok("layout is deterministic and wraps into columns", () => {
  const boards = [{ name: "a" }, { name: "b" }, { name: "c" }];
  const first = layoutBoards(boards);
  const second = layoutBoards(boards);
  assert.deepEqual(first, second);
  assert.equal(first.boards.a.y, first.boards.b.y);
  assert.ok(first.boards.b.x > first.boards.a.x);
  assert.ok(first.boards.c.y > first.boards.a.y);
  assert.deepEqual(first.order, ["a", "b", "c"]);
});

await ok("a hostile board name is escaped in markup and in the embedded index", () => {
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

await ok("the writer produces both files, and the read-back reports boards and age", () => {
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

await ok("an empty project still builds a canvas that says so", () => {
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

await ok("the live server rebuilds on change and pushes a reload", async () => {
  const dir = makeProject();
  const live = await serveCanvas({ cwd: dir, port: 0 }, { log() {}, error() {} });
  const page = await fetch(live.url).then((response) => response.text());
  assert.match(page, /designer-canvas|design canvas/);
  const served = await fetch(`${live.url}canvas.json`).then((response) => response.json());
  assert.equal(served.order?.length, 4, "the served index lists the project's boards");

  // Subscribe, then write a new capture the way the driver would.
  const stream = await fetch(`${live.url}events`);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  await reader.read(); // the initial comment flushes the headers
  mkdirSync(join(dir, "screenshots"), { recursive: true });
  writeFileSync(join(dir, "screenshots", "tablet-768.png"), "png");
  const deadline = Date.now() + 8000;
  let sawReload = "";
  while (Date.now() < deadline && !sawReload.includes("reload")) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise((done) => setTimeout(() => done({ value: undefined }), 500)),
    ]);
    if (chunk.value) sawReload += decoder.decode(chunk.value);
  }
  assert.match(sawReload, /reload/, "an open viewer is told when the canvas changed");
  const after = JSON.parse(readFileSync(join(dir, "canvas.json"), "utf8"));
  assert.equal(after.order.length, 5, "the new capture joined the canvas");
  assert.equal(await fetch(`${live.url}../secrets.txt`).then((response) => response.status), 404, "no traversal");
  reader.cancel().catch(() => {});
  live.close();
});

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
console.log(`\n${checks} canvas checks passed`);
