/**
 * The canvas: every board of a design in one page you can look at.
 *
 * claude-code's design surface is a live canvas — boards stored as files, each
 * one published the moment its call returns, positioned on a pannable stage. OMP
 * has no artifact canvas to render into, so this is the honest analogue rather
 * than an imitation: the same index shape (`canvas.json` with `boards` + `order`),
 * the same board-on-a-stage idea, but assembled from what the project actually
 * has — board files under `project/`, and the captures the driver produced.
 *
 * `collectBoards` reads the project; `layoutBoards` and `renderCanvasHtml` are
 * pure, so the whole surface is testable without a browser.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readDriverReport } from "./driver-report.mjs";

export const CANVAS_HTML_FILE = "designer-canvas.html";
export const CANVAS_INDEX_FILE = "canvas.json";

/** Cell geometry for the deterministic grid. Captures keep their aspect. */
const CELL_WIDTH = 760;
const CELL_HEIGHT = 520;
const GAP = 64;
const MARGIN = 48;
const COLUMNS = 2;

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const escapeJson = (value) => JSON.stringify(value).replaceAll("<", "\\u003c");

const listFiles = (dir, test) => {
  try {
    return readdirSync(dir).filter((name) => test(name)).sort();
  } catch {
    return [];
  }
};

/**
 * Boards this project can show.
 *
 * Order matters: authored boards first (they are the design), then the captures
 * that prove the pages render. The driver's report is used when it exists so a
 * capture carries the run's outcome instead of just being an image.
 *
 * @returns {{ title: string, boards: Array<Record<string, unknown>>, driver: object | null, root: string }}
 */
export function collectBoards(cwd, title = "") {
  const boards = [];
  const driverRun = readDriverReport(cwd);
  const report = driverRun?.report ?? null;

  const boardDir = join(cwd, "project");
  for (const name of listFiles(boardDir, (entry) => /\.(?:dc|board)\.html$/i.test(entry))) {
    boards.push({
      name,
      kind: "board",
      href: `project/${name}`,
      width: CELL_WIDTH,
      height: CELL_HEIGHT,
      note: "board file",
    });
  }
  for (const name of listFiles(cwd, (entry) => /\.board\.html$/i.test(entry))) {
    boards.push({
      name,
      kind: "board",
      href: name,
      width: CELL_WIDTH,
      height: CELL_HEIGHT,
      note: "board file",
    });
  }

  const captures = [];
  if (report) {
    const outcome = report.ok
      ? `driver ok, ${report.consoleErrors.length + report.pageErrors.length + report.failedRequests.length} console problems`
      : `driver failed: ${report.reason}`;
    for (const capture of report.captures) {
      captures.push({ file: capture.path, width: capture.width, blank: capture.blank, note: outcome });
    }
  } else {
    for (const name of listFiles(join(cwd, "screenshots"), (entry) => /\.png$/i.test(entry))) {
      captures.push({ file: `screenshots/${name}`, width: null, blank: false, note: "capture (no driver report)" });
    }
  }
  for (const capture of captures) {
    if (!existsSync(join(cwd, capture.file))) continue;
    const name = basename(capture.file).replace(/\.png$/i, "");
    boards.push({
      name,
      kind: "capture",
      href: capture.file.split("\\").join("/"),
      width: capture.width ?? CELL_WIDTH,
      height: null,
      note: capture.blank ? `${capture.note}; capture is blank` : capture.note,
      blank: capture.blank,
    });
  }

  return {
    title: title || basename(cwd) || "design",
    boards,
    driver: report,
    root: cwd,
  };
}

/**
 * Deterministic grid positions, in the shape claude-code's canvas index uses
 * (`boards` keyed by name, plus `order`). Deterministic matters: the same
 * project must lay out identically every time, or the canvas becomes noise.
 */
export function layoutBoards(boards, { columns = COLUMNS } = {}) {
  const placed = {};
  const order = [];
  const columnsCount = Math.max(1, columns);
  boards.forEach((board, index) => {
    const column = index % columnsCount;
    const row = Math.floor(index / columnsCount);
    const x = MARGIN + column * (CELL_WIDTH + GAP);
    const y = MARGIN + row * (CELL_HEIGHT + GAP);
    placed[board.name] = { x, y, w: CELL_WIDTH, h: CELL_HEIGHT, kind: board.kind, href: board.href };
    order.push(board.name);
  });
  return { boards: placed, order, cell: { width: CELL_WIDTH, height: CELL_HEIGHT, gap: GAP, margin: MARGIN } };
}

const style = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #101010; color: #f2f2f2; font: 13px/1.5 ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
header { position: sticky; top: 0; z-index: 2; display: flex; gap: 16px; align-items: baseline; padding: 14px 20px; background: #171717; border-bottom: 1px solid #2a2a2a; }
h1 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: .01em; }
.meta { color: #8d8d8d; }
.controls { margin-left: auto; display: flex; gap: 8px; align-items: center; }
button { background: #232323; color: #f2f2f2; border: 1px solid #333; border-radius: 5px; padding: 5px 10px; font: inherit; cursor: pointer; }
button:hover { background: #2c2c2c; }
.viewport { position: relative; overflow: auto; height: calc(100vh - 52px); cursor: grab; }
.viewport.dragging { cursor: grabbing; }
.stage { position: relative; transform-origin: 0 0; }
.board { position: absolute; border: 1px solid #2f2f2f; border-radius: 8px; background: #161616; overflow: hidden; }
.board.blank { border-color: #7a3b3b; }
.board header { position: static; padding: 6px 10px; background: #1d1d1d; border-bottom: 1px solid #2a2a2a; font-size: 12px; display: flex; gap: 8px; }
.board .note { color: #8d8d8d; margin-left: auto; }
.board iframe, .board img { display: block; width: 100%; height: calc(100% - 29px); border: 0; background: #fff; object-fit: contain; object-position: top center; }
.board img { background: #0c0c0c; }
.empty { padding: 40px; color: #8d8d8d; }
`;

const script = `
const stage = document.getElementById("stage");
const viewport = document.getElementById("viewport");
let zoom = 1;
const apply = () => { stage.style.transform = "scale(" + zoom + ")"; };
document.getElementById("fit").onclick = () => {
  const bounds = stage.getBoundingClientRect();
  zoom = Math.min(1, viewport.clientWidth / (bounds.width / zoom + 96));
  apply();
};
document.getElementById("full").onclick = () => { zoom = 1; apply(); };
document.getElementById("reset").onclick = () => { viewport.scrollTo(0, 0); };
let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
viewport.addEventListener("mousedown", (event) => {
  if (event.target.closest(".board header")) return;
  dragging = true; startX = event.clientX; startY = event.clientY;
  startLeft = viewport.scrollLeft; startTop = viewport.scrollTop;
  viewport.classList.add("dragging");
});
window.addEventListener("mousemove", (event) => {
  if (!dragging) return;
  viewport.scrollLeft = startLeft - (event.clientX - startX);
  viewport.scrollTop = startTop - (event.clientY - startY);
});
window.addEventListener("mouseup", () => { dragging = false; viewport.classList.remove("dragging"); });
apply();
`;

/**
 * Render the canvas page. Every value that comes from a filename goes through
 * `escapeHtml`, and the embedded index through `escapeJson`, because a board
 * named `"><script>` is a filename someone can create.
 */
export function renderCanvasHtml({ title, boards, index, generatedAt, report = null }) {
  const width = Math.max(
    1200,
    ...Object.values(index.boards).map((board) => board.x + board.w + index.cell.margin),
  );
  const height = Math.max(
    700,
    ...Object.values(index.boards).map((board) => board.y + board.h + index.cell.margin),
  );

  const cards = boards
    .map((board) => {
      const place = index.boards[board.name];
      const media = board.kind === "board"
        ? `<iframe src="${escapeHtml(board.href)}" title="${escapeHtml(board.name)}" loading="lazy"></iframe>`
        : `<img src="${escapeHtml(board.href)}" alt="${escapeHtml(board.name)}" loading="lazy">`;
      return `      <figure class="board${board.blank ? " blank" : ""}" style="left:${place.x}px;top:${place.y}px;width:${place.w}px;height:${place.h}px" data-name="${escapeHtml(board.name)}">
        <header><strong>${escapeHtml(board.name)}</strong><span class="note">${escapeHtml(board.note ?? "")}</span></header>
        ${media}
      </figure>`;
    })
    .join("\n");

  const driverLine = report
    ? `${report.ok ? "driver ok" : `driver failed: ${report.reason}`}${report.url ? ` · ${report.url}` : ""}`
    : "no driver report";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — design canvas</title>
<style>${style}</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <span class="meta">${boards.length} board${boards.length === 1 ? "" : "s"} · ${escapeHtml(driverLine)} · built ${escapeHtml(generatedAt)}</span>
  <div class="controls">
    <button id="fit" type="button">Fit</button>
    <button id="full" type="button">100%</button>
    <button id="reset" type="button">Origin</button>
  </div>
</header>
<div class="viewport" id="viewport">
  <div class="stage" id="stage" style="width:${width}px;height:${height}px">
${cards || '    <p class="empty">No boards yet. Run the driver or add <code>project/*.dc.html</code> boards.</p>'}
  </div>
</div>
<script>window.__canvas = ${escapeJson(index)};</script>
<script>${script}</script>
</body>
</html>
`;
}

/**
 * Write the canvas and its index beside the project's captures. Shared by the
 * CLI and the `/designer-canvas` command so there is one implementation of
 * "what the canvas is", not two that drift.
 */
export function writeCanvasFiles(cwd, { title = "", generatedAt = new Date().toISOString(), columns = COLUMNS } = {}) {
  const built = buildCanvas({ cwd, title, generatedAt, columns });
  const htmlPath = join(cwd, CANVAS_HTML_FILE);
  const indexPath = join(cwd, CANVAS_INDEX_FILE);
  mkdirSync(dirname(htmlPath), { recursive: true });
  writeFileSync(htmlPath, built.html);
  writeFileSync(indexPath, `${JSON.stringify(built.index, null, 2)}\n`);
  return { htmlPath, indexPath, boards: built.boards.length, index: built.index };
}

/** The last written canvas index, with how old it is, or null when there is none. */
export function readCanvasIndex(cwd) {
  const path = join(cwd, CANVAS_INDEX_FILE);
  if (!existsSync(path)) return null;
  try {
    const index = JSON.parse(readFileSync(path, "utf8"));
    const builtAt = typeof index.generatedAt === "string" ? Date.parse(index.generatedAt) : NaN;
    const ageMinutes = Number.isFinite(builtAt) ? Math.round((Date.now() - builtAt) / 60_000) : null;
    const boards = Array.isArray(index.order) ? index.order.length : Object.keys(index.boards ?? {}).length;
    const file = join(cwd, CANVAS_HTML_FILE);
    return {
      path,
      htmlPath: file,
      htmlExists: existsSync(file),
      htmlBytes: existsSync(file) ? statSync(file).size : 0,
      boards,
      ageMinutes,
      title: typeof index.title === "string" ? index.title : "",
    };
  } catch {
    return null;
  }
}

/** Assemble everything for one project. Returns the index and the page source. */
export function buildCanvas({ cwd, title = "", generatedAt = new Date().toISOString(), columns = COLUMNS } = {}) {
  const collected = collectBoards(cwd, title);
  const index = {
    v: 1,
    title: collected.title,
    generatedAt,
    cell: null,
    boards: {},
    order: [],
  };
  const layout = layoutBoards(collected.boards, { columns });
  index.boards = layout.boards;
  index.order = layout.order;
  index.cell = layout.cell;
  return {
    index,
    html: renderCanvasHtml({
      title: collected.title,
      boards: collected.boards,
      index,
      generatedAt,
      report: collected.driver,
    }),
    boards: collected.boards,
  };
}
