#!/usr/bin/env node
/**
 * designer-driver — start a web app, drive it, and capture it at two widths.
 *
 * This is the local equivalent of the driver the claude-code harness ships for
 * browser work (`chromium-cli` in its `run` skill): the point is that looking at
 * the rendered page becomes a command a session can run, not something it has to
 * remember to do by hand. The stop-time evidence record then reads the report
 * this writes, so "was the page ever looked at" has an answer that is produced
 * rather than claimed.
 *
 * Deliberately not a dependency: Playwright is resolved from the project (or
 * from `--playwright` / `DESIGNER_PLAYWRIGHT`), and when it is absent the driver
 * writes a report saying so and exits with code 2. It never reports success for
 * a page it did not render.
 *
 * Usage:
 *   node scripts/designer-driver.mjs --start "npm run dev" --url http://localhost:5173
 *   node scripts/designer-driver.mjs --url file:///G:/site/index.html --out screenshots
 *
 * Exit codes: 0 captured, 1 ran but failed (unreachable, blank, launch), 2 could
 * not run at all (no Playwright). See shared/driver-report.mjs.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { analyzeScreenshot } from "../shared/screenshot-analysis.mjs";
import { writeCanvasFiles } from "../shared/design-canvas.mjs";
import {
  DRIVER_EXIT,
  DRIVER_REPORT_FILE,
  DRIVER_VIEWPORTS,
  isBlankCapture,
  summarizeDriver,
} from "../shared/driver-report.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FLAGS_WITH_VALUES = new Set([
  "--start", "--url", "--out", "--settle", "--project", "--playwright", "--channel", "--timeout",
]);
const FLAGS_BOOLEAN = new Set(["--headed", "--keep", "--no-canvas", "--help", "-h"]);

function parseArgs(argv) {
  const options = {
    start: "",
    url: "",
    out: "screenshots",
    settle: 1200,
    project: process.cwd(),
    playwright: "",
    channel: "",
    timeout: 30_000,
    headed: false,
    keep: false,
    "no-canvas": false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (FLAGS_BOOLEAN.has(token)) {
      if (token === "--help" || token === "-h") options.help = true;
      else options[token.slice(2)] = true;
      continue;
    }
    if (!FLAGS_WITH_VALUES.has(token)) throw new Error(`Unknown flag: ${token}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${token} needs a value`);
    index += 1;
    if (token === "--settle" || token === "--timeout") options[token.slice(2)] = Number(value);
    else options[token.slice(2)] = value;
  }
  return options;
}

const USAGE = `designer-driver — capture this project's rendered page

  --start <cmd>      command that serves the app (omit if it is already running)
  --url <url>        what to open (http(s):// or file:///...)
  --out <dir>        where captures and the report go (default screenshots)
  --settle <ms>      wait after load for fonts and motion (default 1200)
  --project <dir>    project root, used to resolve Playwright (default cwd)
  --playwright <dir> explicit playwright-core directory
  --channel <name>   browser channel (default: bundled chromium, then msedge, then chrome)
  --timeout <ms>     navigation timeout (default 30000)
  --headed           run with a visible window
  --keep             leave a --start command running afterwards
  --help             this text

Exit codes: 0 captured, 1 ran but failed, 2 could not run (no Playwright).
`;

/** Resolve playwright-core from an explicit path, the environment, or the project. */
function resolvePlaywright(projectRoot, explicit) {
  const candidates = [
    explicit,
    process.env.DESIGNER_PLAYWRIGHT,
    join(projectRoot, "node_modules", "playwright-core"),
    join(PACKAGE_ROOT, "node_modules", "playwright-core"),
  ].filter((entry) => typeof entry === "string" && entry.length > 0);
  for (const candidate of candidates) {
    const packagePath = candidate.endsWith("package.json") ? candidate : join(candidate, "package.json");
    if (!existsSync(packagePath)) continue;
    try {
      const manifest = JSON.parse(createRequire(import.meta.url)(packagePath));
      return { dir: dirname(packagePath), entry: manifest.main ?? "index.js", source: candidate };
    } catch {
      return { dir: dirname(packagePath), entry: "index.js", source: candidate };
    }
  }
  return null;
}

function startServer(command, projectRoot) {
  const child = spawn(command, { cwd: projectRoot, shell: true, stdio: "ignore", windowsHide: true });
  return child;
}

function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    // The server is already gone; nothing to clean up.
  }
}

async function waitForUrl(url, timeoutMs) {
  if (url.startsWith("file:")) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      if (response.status < 500) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((done) => setTimeout(done, 400));
  }
  return false;
}

async function launchBrowser(chromium, options) {
  const attempts = options.channel
    ? [{ headless: !options.headed, channel: options.channel }]
    : [{ headless: !options.headed }, { headless: !options.headed, channel: "msedge" }, { headless: !options.headed, channel: "chrome" }];
  let lastError = "";
  for (const attempt of attempts) {
    try {
      return { browser: await chromium.launch(attempt), channel: attempt.channel ?? "bundled" };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastError || "no usable browser");
}

function writeReport(outDir, report) {
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const path = join(outDir, DRIVER_REPORT_FILE);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

function baseReport(options) {
  return {
    version: 1,
    ok: false,
    reason: "driver-error",
    url: options.url || null,
    startedFrom: options.start || null,
    ranAt: new Date().toISOString(),
    settleMs: options.settle,
    viewports: [...DRIVER_VIEWPORTS],
    captures: [],
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    error: null,
  };
}

function finish(outDir, report, code, options) {
  const path = writeReport(outDir, report);
  console.log(`designer-driver: ${summarizeDriver(report)}`);
  console.log(`report: ${path}`);
  if (report.error) console.log(`error: ${report.error}`);
  for (const capture of report.captures) console.log(`capture: ${capture.path}${capture.blank ? " (blank)" : ""}`);
  // The canvas is the "look at all of it at once" surface; it is written on
  // every run (including failures, where seeing the broken board is the point)
  // so the sheet always matches the freshest captures.
  if (!options["no-canvas"] && existsSync(join(options.project, "screenshots"))) {
    try {
      const written = writeCanvasFiles(resolve(options.project));
      console.log(`canvas: ${written.htmlPath} (${written.boards} board${written.boards === 1 ? "" : "s"})`);
    } catch (error) {
      console.log(`canvas: not written (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return code;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return DRIVER_EXIT.unusable;
  }
  if (options.help) {
    console.log(USAGE);
    return DRIVER_EXIT.ok;
  }
  if (!options.url) {
    console.error("--url is required\n" + USAGE);
    return DRIVER_EXIT.unusable;
  }

  const projectRoot = resolve(options.project);
  const outDir = resolve(projectRoot, options.out);
  const report = baseReport(options);

  const playwright = resolvePlaywright(projectRoot, options.playwright);
  if (!playwright) {
    report.reason = "playwright-unavailable";
    report.error = `playwright-core not found (looked in ${projectRoot}/node_modules and ${PACKAGE_ROOT}/node_modules)`;
    return finish(outDir, report, DRIVER_EXIT.unusable, options);
  }

  let chromium;
  try {
    const module = await import(pathToFileURL(join(playwright.dir, playwright.entry)).href);
    chromium = module.chromium ?? module.default?.chromium;
    if (!chromium) throw new Error(`no chromium export in ${playwright.source}`);
  } catch (error) {
    report.reason = "playwright-unavailable";
    report.error = error instanceof Error ? error.message : String(error);
    return finish(outDir, report, DRIVER_EXIT.unusable, options);
  }

  const server = options.start ? startServer(options.start, projectRoot) : null;
  let browser = null;
  try {
    const reachable = await waitForUrl(options.url, options.timeout);
    if (!reachable) {
      report.reason = "url-unreachable";
      report.error = `${options.url} did not answer within ${options.timeout}ms${options.start ? ` (started with: ${options.start})` : ""}`;
      return finish(outDir, report, DRIVER_EXIT.failed, options);
    }

    let launched;
    try {
      launched = await launchBrowser(chromium, options);
    } catch (error) {
      report.reason = "launch-failed";
      report.error = error instanceof Error ? error.message : String(error);
      return finish(outDir, report, DRIVER_EXIT.failed, options);
    }
    browser = launched.browser;

    const context = await browser.newContext({ viewport: { width: DRIVER_VIEWPORTS[0], height: 900 } });
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") report.consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => {
      report.pageErrors.push(error instanceof Error ? error.message : String(error));
    });
    page.on("requestfailed", (request) => {
      report.failedRequests.push(`${request.url()} ${request.failure()?.errorText ?? "failed"}`);
    });

    try {
      await page.goto(options.url, { waitUntil: "load", timeout: options.timeout });
    } catch (error) {
      report.reason = "url-unreachable";
      report.error = error instanceof Error ? error.message : String(error);
      return finish(outDir, report, DRIVER_EXIT.failed, options);
    }

    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    for (const width of DRIVER_VIEWPORTS) {
      await page.setViewportSize({ width, height: Math.max(640, Math.round(width * 0.72)) });
      await page.evaluate(() => (globalThis.document?.fonts?.ready ?? Promise.resolve()).then(() => undefined)).catch(() => undefined);
      await page.waitForTimeout(options.settle);
      const file = join(outDir, `${width >= 1000 ? "desktop" : "mobile"}-${width}.png`);
      await page.screenshot({ path: file, fullPage: true });
      const analysis = analyzeScreenshot(file);
      const blankRun = analysis.maxBlankRunFraction ?? 0;
      const blank = isBlankCapture(analysis);
      report.captures.push({
        path: relative(projectRoot, file).split("\\").join("/"),
        width,
        blank,
        blankRun: Number(blankRun.toFixed(3)),
        height: typeof analysis.height === "number" ? analysis.height : null,
        error: analysis.error ?? null,
      });
    }

    const blanks = report.captures.filter((capture) => capture.blank);
    if (blanks.length > 0) {
      report.reason = "blank-capture";
      report.error = `${blanks.length} of ${report.captures.length} captures are mostly blank: content is hidden at initial paint, or the app did not render`;
      return finish(outDir, report, DRIVER_EXIT.failed, options);
    }

    report.ok = true;
    report.reason = "ok";
    return finish(outDir, report, DRIVER_EXIT.ok, options);
  } catch (error) {
    report.reason = "driver-error";
    report.error = error instanceof Error ? error.message : String(error);
    return finish(outDir, report, DRIVER_EXIT.failed, options);
  } finally {
    try {
      await browser?.close();
    } catch {
      // Closing a dead browser is not an error worth reporting.
    }
    if (!options.keep) stopServer(server);
  }
}

process.exitCode = await main();
