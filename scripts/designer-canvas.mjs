#!/usr/bin/env node
/**
 * designer-canvas — write the project's design canvas and print where it is.
 *
 * Every board the project can show (authored `project/*.dc.html` files, and the
 * captures the driver produced) is laid out on one page with the canvas index
 * beside it. This is the local answer to "show me all of it at once" without a
 * host artifact surface: open the file, or point a browser at it.
 *
 * Usage:
 *   node scripts/designer-canvas.mjs                     # current directory
 *   node scripts/designer-canvas.mjs --project G:/site --open
 *   node scripts/designer-canvas.mjs --json              # machine-readable
 *
 * Exit codes: 0 wrote (even with no boards, which is a valid empty state), 1 failed.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serveCanvas, writeCanvasFiles } from "../shared/design-canvas.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function value(args, flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

export function writeCanvas({ project = process.cwd(), title = "", out = "" } = {}, io = console) {
  const cwd = resolve(project);
  if (!existsSync(cwd)) {
    io.error(`designer-canvas: ${cwd} does not exist`);
    return { code: 1, path: null, boards: 0 };
  }
  const target = out ? resolve(out) : cwd;
  const written = writeCanvasFiles(target, { title });
  io.log(`designer-canvas: ${written.boards} board${written.boards === 1 ? "" : "s"} -> ${written.htmlPath}`);
  return {
    code: 0,
    path: written.htmlPath,
    index: written.indexPath,
    boards: written.boards,
    details: { title: written.index.title, generatedAt: written.index.generatedAt },
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  await main(process.argv.slice(2));
}

/** Parse arguments and either serve the canvas live or write it once. */
async function main(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`designer-canvas [--project <dir>] [--title <name>] [--out <file>] [--open] [--json]
                 [--serve [--port <n>]]   live canvas: rebuild + reload open viewers on change`);
    return;
  }
  const project = value(args, "--project", process.cwd());
  const title = value(args, "--title", "");
  if (args.includes("--serve")) {
    const live = await serveCanvas({ cwd: resolve(project), port: Number(value(args, "--port", "0")), title });
    if (args.includes("--open")) {
      spawn("cmd", ["/c", "start", "", live.url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    }
    if (args.includes("--open")) {
      spawn("cmd", ["/c", "start", "", live.url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    }
    console.log(`designer-canvas: live at ${live.url} (Ctrl+C to stop)`);
    process.on("SIGINT", () => { live.close(); process.exit(0); });
    return;
  }
  const result = writeCanvas(
    { project, title, out: value(args, "--out", "") },
    args.includes("--json") ? { log() {}, error: console.error } : console,
  );
  if (args.includes("--json")) console.log(JSON.stringify(result));
  process.exitCode = result.code;
}
