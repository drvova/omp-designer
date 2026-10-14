/**
 * P2 host-bridge evidence.
 *
 * This harness simulates the documented OMP/Pi host event contract
 * (registerCommand + on("before_agent_start" | "resources_discover" |
 * "session_stop")) closely enough to drive the REAL adapter modules and assert
 * on their hook-level behavior, without a live model or a real OMP process.
 *
 * The OMP adapter writes trace events (which distinguish "checks ran" from
 * "checks skipped") under $HOME/.omp/agent/designer-traces. bun's os.homedir()
 * ignores a $HOME override, so the harness reads the real trace dir and deletes
 * exactly the per-cwd trace files it created (each keyed by a sha256 of the cwd).
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, existsSync, readdirSync, readFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

process.env.OMP_DESIGNER_MODE = "1";
process.env.PI_DESIGNER_MODE = "1";

// Real adapter modules under test.
const omp = await import("../../extension/index.ts");
const pi = await import("../../extensions/designer.ts");

const TRACE_DIR = join(homedir(), ".omp", "agent", "designer-traces");
const tempDirs: string[] = [];
const traceCwds = new Set<string>();

// Mirror the adapter's trace filename scheme so cleanup targets only our files.
function tracePath(cwd: string): string {
  const base = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "root";
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  return join(TRACE_DIR, `${base}-${hash}.jsonl`);
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  for (const cwd of traceCwds) rmSync(tracePath(cwd), { force: true });
  delete process.env.OMP_DESIGNER_MODE;
  delete process.env.PI_DESIGNER_MODE;
  delete process.env.OMP_DESIGNER_V5_REGISTERED_PID;
});

type Handler = (event?: unknown, ctx?: { cwd?: string }) => unknown;

// A fake host that records the exact surface an adapter registers against.
function makeHost() {
  const commands: string[] = [];
  const commandOptions = new Map<string, Record<string, unknown>>();
  const handlers = new Map<string, Handler[]>();
  const api = {
    registerCommand(name: string, options: unknown) {
      commands.push(name);
      commandOptions.set(name, options as Record<string, unknown>);
    },
    on(event: string, handler: Handler) {
      const entries = handlers.get(event) ?? [];
      entries.push(handler);
      handlers.set(event, entries);
    },
  };
  const fire = (event: string, payload: unknown, ctx: { cwd?: string }) => {
    if (ctx?.cwd) traceCwds.add(ctx.cwd);
    return handlers.get(event)?.[0]?.(payload, ctx);
  };
  return { commands, commandOptions, handlers, api, fire };
}

function makeTempProject(withBuildScript: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "omp-e2e-proj-"));
  tempDirs.push(dir);
  const pkg: Record<string, unknown> = { name: "e2e-fixture", private: true };
  if (withBuildScript) pkg.scripts = { build: "node -e \"process.exit(1)\"" };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "main.js"), "export const x = 1;\n");
  writeFileSync(join(dir, "index.html"), "<!doctype html><html><head><title>hi</title><meta name=\"description\" content=\"fixture\"><link rel=\"icon\" href=\"data:,\"></head><body><h1>hi</h1></body></html>\n");
  return dir;
}

// Stamp every existing source file into the past so a fresh session baseline
// (Date.now at before_agent_start) sees no change unless the test writes one.
function ageSources(dir: string): void {
  const past = new Date(Date.now() - 60_000);
  const stamp = (p: string) => {
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, entry.name);
      if (entry.isDirectory()) stamp(full);
      else utimesSync(full, past, past);
    }
  };
  stamp(dir);
}

function traceEvents(cwd: string): string[] {
  if (!existsSync(TRACE_DIR)) return [];
  const events: string[] = [];
  for (const file of readdirSync(TRACE_DIR)) {
    if (!file.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(TRACE_DIR, file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { event?: string; cwd?: string };
        if (parsed.cwd === cwd && typeof parsed.event === "string") events.push(parsed.event);
      } catch {
        // ignore malformed trace lines
      }
    }
  }
  return events;
}

const assistant = (text: string) => ({ last_assistant_message: { content: [{ type: "text", text }] } });

// The OMP duplicate-load guard is process-global, so the adapter can only be
// registered once per process. Register a single shared host and give every
// scenario a distinct cwd/session so in-adapter state never bleeds across tests.
const host = makeHost();
omp.default(host.api as never);

describe("P2: OMP hook registration", () => {
  test("registers the documented commands and hooks, and no tool gate", () => {
    expect(host.commands).toEqual(["designer", "designer-vibe", "designer-canvas", "designer-doctor"]);
    expect(host.handlers.has("before_agent_start")).toBe(true);
    expect(host.handlers.has("resources_discover")).toBe(true);
    expect(host.handlers.has("session_stop")).toBe(true);
    expect(host.handlers.has("tool_call")).toBe(false);
    expect(host.handlers.has("tool_result")).toBe(false);
  });

  test("resources_discover exposes exactly the eight skill resources", () => {
    const result = host.fire("resources_discover", {}, { cwd: process.cwd() }) as { skillPaths: string[] };
    expect(result.skillPaths).toHaveLength(8);
    expect(result.skillPaths.every((p) => p.startsWith(omp.PACKAGE_ROOT) && p.endsWith(".md"))).toBe(true);
  });

  test("before_agent_start injects the designer prompt exactly once", () => {
    const cwd = "/tmp/omp-e2e-inject";
    const first = host.fire("before_agent_start", { prompt: "build a page", systemPrompt: ["base"] }, { cwd }) as { systemPrompt: string[] };
    expect(first.systemPrompt.filter((p) => p.includes("[DESIGNER MODE: ACTIVE v5]"))).toHaveLength(1);
    // Re-injection over an already-decorated prompt must not stack a second copy.
    const second = host.fire("before_agent_start", { systemPrompt: first.systemPrompt }, { cwd }) as { systemPrompt: string[] };
    expect(second.systemPrompt.filter((p) => p.includes("[DESIGNER MODE: ACTIVE v5]"))).toHaveLength(1);
  });
});

describe("P2: plan continuation exactness", () => {
  const cwd = "/tmp/omp-e2e-plan";
  const invalidPlan = "A single-page site with several sections."; // collapses requested multiple pages

  const startPlanSession = (prompt: string, c = cwd) =>
    host.fire("before_agent_start", { prompt, systemPrompt: ["base"] }, { cwd: c });

  test("fires exactly one bounded continuation on the first invalid plan, then stops", () => {
    startPlanSession("Create a plan for various pages and wait for my approval.");
    const first = host.fire("session_stop", { session_id: "plan-1", ...assistant(invalidPlan) }, { cwd }) as {
      continue?: boolean; additionalContext?: string;
    };
    expect(first.continue).toBe(true);
    expect(first.additionalContext).toContain("[DESIGNER PLAN CHECKS FAILED]");
    expect(first.additionalContext).toContain("Rewrite only the approval plan");
    expect(first.additionalContext).toContain("wait");
    expect((first.additionalContext ?? "").length).toBeLessThanOrEqual(7000);

    // Same session, still-invalid plan: bounded, no second continuation (no loop).
    const second = host.fire("session_stop", { session_id: "plan-1", ...assistant(invalidPlan) }, { cwd });
    expect(second).toBeUndefined();
  });

  test("a valid plan passes without continuation", () => {
    startPlanSession("Create a plan for various pages and wait for my approval.", "/tmp/omp-e2e-plan-ok");
    const result = host.fire("session_stop", {
      session_id: "plan-ok",
      ...assistant("Routes: `/`, `/archive`, and `/field`. I will wait for approval."),
    }, { cwd: "/tmp/omp-e2e-plan-ok" });
    expect(result).toBeUndefined();
  });

  test("an explicit detailed-specification request bypasses the length block", () => {
    const c = "/tmp/omp-e2e-plan-detailed";
    startPlanSession("Write a detailed specification plan for various pages and wait for my approval.", c);
    const longBody = `Routes: \`/\`, \`/a\`, and \`/b\`. ${"word ".repeat(900)} I will wait for approval.`;
    const result = host.fire("session_stop", { session_id: "plan-detailed", ...assistant(longBody) }, { cwd: c });
    expect(result).toBeUndefined();
  });

  test("an overlong plan without a detail request is continued once for length", () => {
    const c = "/tmp/omp-e2e-plan-long";
    startPlanSession("Create a plan for various pages and wait for my approval.", c);
    const longBody = `Routes: \`/\`, \`/a\`, and \`/b\`. ${"word ".repeat(900)} I will wait for approval.`;
    const result = host.fire("session_stop", { session_id: "plan-long", ...assistant(longBody) }, { cwd: c }) as {
      continue?: boolean; additionalContext?: string;
    };
    expect(result.continue).toBe(true);
    expect(result.additionalContext).toContain("is long");
  });
});

describe("P2: delivery-check bridge", () => {
  test("a pure chat/build turn with no project change does not spawn checks", () => {
    const dir = makeTempProject(true); // build script exits 1 -> would fail loudly if spawned
    ageSources(dir);
    host.fire("before_agent_start", { prompt: "Build a bakery landing page.", systemPrompt: ["base"] }, { cwd: dir });
    const result = host.fire("session_stop", { session_id: "noop", ...assistant("Some layout advice.") }, { cwd: dir });
    expect(result).toBeUndefined();
    expect(traceEvents(dir)).toContain("delivery_checks_skipped");
    expect(traceEvents(dir)).not.toContain("delivery_checks_failed");
    expect(traceEvents(dir)).not.toContain("delivery_checks_passed");
  });

  test("generated build output alone does not count as a project change", () => {
    const dir = makeTempProject(false);
    ageSources(dir);
    host.fire("before_agent_start", { prompt: "Build a bakery landing page.", systemPrompt: ["base"] }, { cwd: dir });
    // Fresh output in ignored dirs after the baseline must not trigger checks.
    const future = new Date(Date.now() + 60_000);
    for (const ignored of ["dist", "node_modules", ".next"]) {
      mkdirSync(join(dir, ignored), { recursive: true });
      const f = join(dir, ignored, "bundle.js");
      writeFileSync(f, "generated");
      utimesSync(f, future, future);
    }
    const result = host.fire("session_stop", { session_id: "genout", ...assistant("done") }, { cwd: dir });
    expect(result).toBeUndefined();
    expect(traceEvents(dir)).toContain("delivery_checks_skipped");
  });

  test("a real frontend source change after session start does run delivery checks", () => {
    const dir = makeTempProject(false); // no build script -> build check is skipped-ok, validators still run
    ageSources(dir);
    host.fire("before_agent_start", { prompt: "Build a bakery landing page.", systemPrompt: ["base"] }, { cwd: dir });
    // A genuine source edit after the baseline.
    const future = new Date(Date.now() + 60_000);
    const changed = join(dir, "src", "main.js");
    writeFileSync(changed, "export const x = 2;\n");
    utimesSync(changed, future, future);
    host.fire("session_stop", { session_id: "changed", ...assistant("Shipped the page.") }, { cwd: dir });
    const events = traceEvents(dir);
    // The delivery path ran (passed or failed), i.e. it was NOT skipped this turn.
    expect(events.some((e) => e === "delivery_checks_passed" || e === "delivery_checks_failed")).toBe(true);
  });
});

describe("P2: taste-review bridge", () => {
  // Minimal PNG encoder (8-bit RGB, filter 0) for screenshot fixtures.
  function crc32(buffer: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of buffer) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function chunk(type: string, data: Buffer): Buffer {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length, 0);
    header.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])), 0);
    return Buffer.concat([header, data, crc]);
  }
  function solidPng(width: number, height: number): Buffer {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const raw = Buffer.alloc(height * (width * 3 + 1)); // zero-filled: black rows, filter 0
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }

  function makeSlopProject(): string {
    const dir = mkdtempSync(join(tmpdir(), "omp-e2e-slop-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "slop-fixture", private: true }));
    writeFileSync(join(dir, "index.html"), "<!doctype html><html><body><section class=\"reveal\"><h1>Areca</h1><img src=\"https://images.unsplash.com/photo-123\" alt=\"studio\"></section></body></html>\n");
    mkdirSync(join(dir, "css"));
    writeFileSync(join(dir, "css", "style.css"), "body { background: #0c0a0f; color: #f5f0ff; } .cta { background: #7c5cfc; } .tag { color: #06cddc; } .reveal { opacity: 0; }\n");
    mkdirSync(join(dir, "js"));
    writeFileSync(join(dir, "js", "main.js"), "const io = new IntersectionObserver(() => {}); io.observe(document.querySelector('.reveal'));\n");
    writeFileSync(join(dir, "screenshot-desktop.png"), solidPng(100, 400));
    return dir;
  }

  test("passing delivery checks with slop patterns earns bounded taste continuations", () => {
    const dir = makeSlopProject();
    ageSources(dir);
    host.fire("before_agent_start", { prompt: "Build a landing page for my product.", systemPrompt: ["base"] }, { cwd: dir });
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(dir, "css", "style.css"), future, future);

    const first = host.fire("session_stop", { session_id: "taste-1", ...assistant("Shipped.") }, { cwd: dir }) as {
      continue?: boolean;
      additionalContext?: string;
    };
    expect(first?.continue).toBe(true);
    expect(first?.additionalContext).toContain("[DESIGNER TASTE REVIEW]");
    expect(first?.additionalContext).toContain("ai-default-palette");
    expect(first?.additionalContext).toContain("reveal-hidden-content");
    expect(first?.additionalContext).toContain("blank-screenshot-band");
    expect(first?.additionalContext).toContain("remote-placeholder-asset");
    expect(first?.additionalContext).toContain("product-facts-missing");
    expect(traceEvents(dir)).toContain("taste_review_flagged");

    // Second pass is allowed (flagged sets shrink per pass in real runs)...
    const second = host.fire("session_stop", { session_id: "taste-1", ...assistant("Still shipped.") }, { cwd: dir }) as {
      continue?: boolean;
    };
    expect(second?.continue).toBe(true);

    // ...but the third stop ends the loop: bounded, never infinite.
    const third = host.fire("session_stop", { session_id: "taste-1", ...assistant("Really shipped.") }, { cwd: dir });
    expect(third).toBeUndefined();
  });

  test("a static site without package.json still gets delivery checks and taste review", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-e2e-static-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "index.html"), "<!doctype html><html><head><title>Atelier</title><meta name=\"description\" content=\"Handmade oak tables\"><link rel=\"icon\" href=\"data:,\"></head><body><h1>Atelier</h1><p>Handmade oak tables.</p></body></html>\n");
    ageSources(dir);
    host.fire("before_agent_start", { prompt: "Build a landing page for my studio.", systemPrompt: ["base"] }, { cwd: dir });
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(dir, "index.html"), future, future);

    const result = host.fire("session_stop", { session_id: "static-1", ...assistant("Shipped.") }, { cwd: dir });
    expect(result).toBeUndefined();
    const events = traceEvents(dir);
    expect(events).toContain("delivery_checks_passed");
    expect(events).toContain("taste_review_passed");
    expect(events).not.toContain("delivery_checks_skipped");
  });

  test("a weak model-backed visual review joins the taste continuation (stubbed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-e2e-visual-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "visual-fixture", private: true }));
    writeFileSync(join(dir, "index.html"), "<!doctype html><html><head><title>Vis</title><meta name=\"description\" content=\"x\"><link rel=\"icon\" href=\"data:,\"></head><body><h1>Vis</h1></body></html>\n");
    writeFileSync(join(dir, "screenshot-desktop.png"), solidPng(100, 150)); // not full-page: no blank-band item
    writeFileSync(join(dir, "design-review.json"), JSON.stringify({
      verdict: "technically valid but visually weak",
      review: { visualHierarchy: { score: 0, reason: "hero has no focal point" } },
      topFixes: ["give the hero a dominant product visual"],
    }));
    process.env.DESIGNER_REVIEW_MODEL = "stub-model";
    process.env.DESIGNER_REVIEW_CMD = "true"; // no-op; the pre-written design-review.json is read
    try {
      ageSources(dir);
      host.fire("before_agent_start", { prompt: "Build a landing page.", systemPrompt: ["base"] }, { cwd: dir });
      const future = new Date(Date.now() + 60_000);
      utimesSync(join(dir, "index.html"), future, future);
      const result = host.fire("session_stop", { session_id: "visual-1", ...assistant("Shipped.") }, { cwd: dir }) as {
        continue?: boolean; additionalContext?: string;
      };
      expect(result?.continue).toBe(true);
      expect(result?.additionalContext).toContain("visual-review");
      expect(result?.additionalContext).toContain("hero has no focal point");
      expect(result?.additionalContext).toContain("dominant product visual");
    } finally {
      delete process.env.DESIGNER_REVIEW_MODEL;
      delete process.env.DESIGNER_REVIEW_CMD;
    }
  });

  test("a clean delivery passes the taste review without continuation", () => {
    const dir = makeTempProject(false);
    ageSources(dir);
    host.fire("before_agent_start", { prompt: "Build a landing page for my product.", systemPrompt: ["base"] }, { cwd: dir });
    const future = new Date(Date.now() + 60_000);
    const changed = join(dir, "src", "main.js");
    writeFileSync(changed, "export const x = 4;\n");
    utimesSync(changed, future, future);

    const result = host.fire("session_stop", { session_id: "taste-clean", ...assistant("Shipped.") }, { cwd: dir });
    expect(result).toBeUndefined();
    expect(traceEvents(dir)).toContain("taste_review_passed");
  });

  // --- screenshot evidence ---------------------------------------------------
  // The record answers "was the rendered page ever looked at?". A capture that
  // does not exist cannot be evidence of a clean render, so the absence is
  // recorded on every frontend stop and only chased when the project is
  // substantive enough for the same bar that asks for DESIGN.md.

  function traceRecords(cwd: string): Array<Record<string, unknown>> {
    if (!existsSync(TRACE_DIR)) return [];
    const records: Array<Record<string, unknown>> = [];
    for (const file of readdirSync(TRACE_DIR)) {
      if (!file.endsWith(".jsonl")) continue;
      for (const line of readFileSync(join(TRACE_DIR, file), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.cwd === cwd) records.push(parsed);
        } catch {
          // A partially written line is not a test failure.
        }
      }
    }
    return records;
  }

  function makeSubstantiveProject(): string {
    const dir = mkdtempSync(join(tmpdir(), "omp-e2e-substantive-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "substantive-fixture", private: true }));
    writeFileSync(join(dir, "index.html"), "<!doctype html><html lang=\"en\"><head><title>Atelier Oak</title><meta name=\"description\" content=\"Handmade oak tables built to order.\"><link rel=\"icon\" href=\"data:,\"></head><body><h1>Atelier Oak</h1><p>Handmade oak tables, built to order.</p></body></html>\n");
    mkdirSync(join(dir, "css"));
    writeFileSync(join(dir, "css", "style.css"), "body { background: #faf7f2; color: #201d18; }\nh1 { font-size: clamp(2rem, 6vw, 3rem); }\n@media (min-width: 60rem) { body { padding: 2rem; } }\n");
    mkdirSync(join(dir, "js"));
    writeFileSync(join(dir, "js", "main.js"), "document.documentElement.dataset.ready = \"1\";\n");
    return dir;
  }

  test("a visual change with no capture is recorded and earns a capture turn", () => {
    const dir = makeSubstantiveProject();
    ageSources(dir);
    host.fire("before_agent_start", { prompt: "Redesign the hero section of my workshop site.", systemPrompt: ["base"] }, { cwd: dir });
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(dir, "css", "style.css"), future, future);

    const result = host.fire("session_stop", { session_id: "evidence-missing", ...assistant("Shipped.") }, { cwd: dir }) as {
      continue?: boolean;
      additionalContext?: string;
    };
    expect(result?.continue).toBe(true);
    expect(result?.additionalContext).toContain("missing-screenshot-evidence");

    const record = traceRecords(dir).find((entry) => entry.event === "screenshot_evidence");
    expect(record?.state).toBe("missing");
    expect(record?.found).toBe(0);
  });

  test("a capture newer than every source edit clears the demand", () => {
    const dir = makeSubstantiveProject();
    writeFileSync(join(dir, "screenshot-desktop.png"), solidPng(100, 150));
    ageSources(dir);
    host.fire("before_agent_start", { prompt: "Redesign the hero section of my workshop site.", systemPrompt: ["base"] }, { cwd: dir });
    const edited = new Date(Date.now() + 60_000);
    utimesSync(join(dir, "css", "style.css"), edited, edited);
    const captured = new Date(Date.now() + 120_000);
    utimesSync(join(dir, "screenshot-desktop.png"), captured, captured);

    const result = host.fire("session_stop", { session_id: "evidence-fresh", ...assistant("Shipped.") }, { cwd: dir }) as {
      additionalContext?: string;
    } | undefined;
    expect(result?.additionalContext ?? "").not.toContain("missing-screenshot-evidence");

    const record = traceRecords(dir).find((entry) => entry.event === "screenshot_evidence");
    expect(record?.state).toBe("fresh");
    expect(record?.found).toBe(1);
  });

  test("a one-file page is recorded, not chased", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-e2e-evidence-thin-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "index.html"), "<!doctype html><html><head><title>Atelier</title><meta name=\"description\" content=\"Handmade oak tables\"><link rel=\"icon\" href=\"data:,\"></head><body><h1>Atelier</h1><p>Handmade oak tables.</p></body></html>\n");
    ageSources(dir);
    host.fire("before_agent_start", { prompt: "Build a landing page for my studio.", systemPrompt: ["base"] }, { cwd: dir });
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(dir, "index.html"), future, future);

    const result = host.fire("session_stop", { session_id: "evidence-thin", ...assistant("Shipped.") }, { cwd: dir });
    expect(result).toBeUndefined();
    expect(traceEvents(dir)).toContain("taste_review_passed");

    // Recorded, because the absence is the finding; not chased, because one
    // edited page is not a substantive frontend delivery.
    const record = traceRecords(dir).find((entry) => entry.event === "screenshot_evidence");
    expect(record?.state).toBe("missing");
    expect(record?.found).toBe(0);
  });

  test("the doctor surfaces the last screenshot evidence", () => {
    const dir = makeSubstantiveProject();
    ageSources(dir);
    host.fire("before_agent_start", { prompt: "Redesign the hero section of my workshop site.", systemPrompt: ["base"] }, { cwd: dir });
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(dir, "css", "style.css"), future, future);
    host.fire("session_stop", { session_id: "evidence-doctor", ...assistant("Shipped.") }, { cwd: dir });

    const handler = host.commandOptions.get("designer-doctor")?.handler as
      | ((args: string, ctx: unknown) => void)
      | undefined;
    expect(handler).toBeDefined();
    let report = "";
    handler?.("", { cwd: dir, editor: { setText: (text: string) => { report = text; } }, ui: {} });
    expect(report).toContain("Screenshot evidence (last session_stop): missing (captures: 0, stale: 0)");
    expect(report).toContain("Driver: present");
    expect(report).toContain("Run skill (project): none");
    expect(report).toContain("Canvas: none");
    expect(report).toMatch(/Skill context: 8 files, [\d.]+KB if all were read/);
  });

  test("the /designer-canvas command builds the sheet and the doctor sees it", () => {
    const dir = makeSubstantiveProject();
    mkdirSync(join(dir, "screenshots"), { recursive: true });
    writeFileSync(join(dir, "screenshots", "desktop-1440.png"), solidPng(100, 150));
    const handler = host.commandOptions.get("designer-canvas")?.handler as
      | ((args: string, ctx: unknown) => void)
      | undefined;
    expect(handler).toBeDefined();
    const notices: string[] = [];
    handler?.("", { cwd: dir, ui: { notify: (text: string) => notices.push(text) }, editor: { setText: () => {} } });
    expect(notices.join(" ")).toMatch(/Canvas: 1 board ->/);
    expect(existsSync(join(dir, "designer-canvas.html"))).toBe(true);

    const doctor = host.commandOptions.get("designer-doctor")?.handler as
      | ((args: string, ctx: unknown) => void)
      | undefined;
    let report = "";
    doctor?.("", { cwd: dir, editor: { setText: (text: string) => { report = text; } }, ui: {} });
    expect(report).toMatch(/Canvas: 1 board, (just built|built \d+m ago)/);
  });

  test("a driver run reaches the record, and its failures are reported as failures", () => {
    const dir = makeSubstantiveProject();
    mkdirSync(join(dir, "screenshots"));
    writeFileSync(join(dir, "screenshots", "desktop-1440.png"), solidPng(100, 150));
    writeFileSync(join(dir, "screenshots", "mobile-375.png"), solidPng(100, 150));
    writeFileSync(join(dir, "screenshots", "driver-report.json"), JSON.stringify({
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
    }));
    ageSources(dir);
    host.fire("before_agent_start", { prompt: "Run it and screenshot the hero.", systemPrompt: ["base"] }, { cwd: dir });
    const future = new Date(Date.now() + 120_000);
    for (const name of ["desktop-1440.png", "mobile-375.png"]) utimesSync(join(dir, "screenshots", name), future, future);
    utimesSync(join(dir, "css", "style.css"), new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));

    host.fire("session_stop", { session_id: "evidence-driver", ...assistant("Shipped.") }, { cwd: dir });
    const record = traceRecords(dir).find((entry) => entry.event === "screenshot_evidence");
    expect(record?.state).toBe("fresh");
    expect(record?.driver).toBe("ok (2 captures, 0 console errors)");

    // A failed run is a finding about the app, not a missing capture.
    writeFileSync(join(dir, "screenshots", "driver-report.json"), JSON.stringify({
      version: 1,
      ok: false,
      reason: "url-unreachable",
      error: "http://localhost:5173 did not answer within 30000ms",
      captures: [],
      consoleErrors: [],
      pageErrors: [],
      failedRequests: [],
    }));
    host.fire("session_stop", { session_id: "evidence-driver-failed", ...assistant("Shipped.") }, { cwd: dir });
    const failure = traceRecords(dir).filter((entry) => entry.event === "screenshot_evidence").at(-1);
    expect(String(failure?.driver)).toContain("failed (url-unreachable");
  });
});

describe("P2: duplicate load and loader realms", () => {
  test("a second default() call in the same process registers no duplicate hooks", () => {
    const dup = makeHost();
    omp.default(dup.api as never); // guarded by INSTANCE_ENV/registry/lock
    expect(dup.commands).toHaveLength(0);
    expect(dup.handlers.size).toBe(0);
  });

  test("a separately imported realm does not double-register in the same process", async () => {
    const realm2 = await import("../../extension/index.ts?realm=2");
    const host2 = makeHost();
    realm2.default(host2.api as never);
    expect(host2.commands).toHaveLength(0);
    expect(host2.handlers.size).toBe(0);
  });
});

describe("P2: instance lock ownership", () => {
  // The lock name carries the PID and Windows recycles PIDs, so a file left by a
  // dead process used to make the next process holding that PID answer "already
  // registered" and register nothing at all — the extension silently inert for a
  // whole session. These two arms are that bug and its intended behaviour.
  const lockPath = join(tmpdir(), `omp-designer-v5-${process.pid}.lock`);

  test("debris from a recycled PID is taken over, not obeyed", () => {
    const mine = readFileSync(lockPath, "utf8");
    try {
      writeFileSync(lockPath, "424242:1");
      expect(omp.claimInstanceLock()).toBe(true);
      expect(readFileSync(lockPath, "utf8")).toContain(`${process.pid}:`);
    } finally {
      writeFileSync(lockPath, mine);
    }
  });

  test("this process's own lock is still respected", () => {
    expect(omp.claimInstanceLock()).toBe(false);
  });
});

describe("P2: OMP vs Pi capability difference", () => {
  test("Pi registers the same commands/hooks but has no delivery-check backstop", () => {
    const piHost = makeHost();
    pi.default(piHost.api as never);
    expect(piHost.commands).toEqual(["designer", "designer-doctor"]);
    expect(piHost.handlers.has("session_stop")).toBe(true);

    const dir = makeTempProject(true); // build would exit 1 if a backstop existed
    ageSources(dir);
    // A build-mode turn with a real change: OMP would run delivery checks; Pi must not.
    piHost.fire("before_agent_start", { prompt: "Build a bakery landing page.", systemPrompt: ["base"] }, { cwd: dir });
    const future = new Date(Date.now() + 60_000);
    const changed = join(dir, "src", "main.js");
    writeFileSync(changed, "export const x = 3;\n");
    utimesSync(changed, future, future);
    const result = piHost.fire("session_stop", { session_id: "pi-build", ...assistant("done") }, { cwd: dir });
    // Pi returns nothing for a non-plan turn: it is prompt-only + plan-check.
    expect(result).toBeUndefined();
  });

  test("both adapters still gate a plan turn identically", () => {
    const piHost = makeHost();
    pi.default(piHost.api as never);
    const cwd = "/tmp/omp-e2e-pi-plan";
    piHost.fire("before_agent_start", { prompt: "Create a plan for various pages and wait for approval.", systemPrompt: ["base"] }, { cwd });
    const result = piHost.fire("session_stop", {
      session_id: "pi-plan",
      ...assistant("A single-page site with several sections."),
    }, { cwd }) as { continue?: boolean; additionalContext?: string };
    expect(result.continue).toBe(true);
    expect(result.additionalContext).toContain("[DESIGNER PLAN CHECKS FAILED]");
  });
});

describe("P2: fallback session id collision resistance", () => {
  test("two host-omitted-session-id sessions in the same cwd do not collide", () => {
    // Both sessions omit session_id; without a robust fallback they would share
    // one attempt counter and the second would be silently suppressed.
    const cwd = "/tmp/omp-e2e-collide";
    const invalid = "A single-page site with several sections.";

    host.fire("before_agent_start", { prompt: "Create a plan for various pages and wait for approval.", systemPrompt: ["base"] }, { cwd });
    const a = host.fire("session_stop", { ...assistant(invalid) }, { cwd }) as { continue?: boolean };
    expect(a.continue).toBe(true);

    // A new, independent session in the same cwd (new baseline -> new fallback id).
    host.fire("before_agent_start", { prompt: "Create a plan for various pages and wait for approval.", systemPrompt: ["base"] }, { cwd });
    const b = host.fire("session_stop", { ...assistant(invalid) }, { cwd }) as { continue?: boolean };
    expect(b.continue).toBe(true);
  });
});
