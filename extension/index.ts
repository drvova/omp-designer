/**
 * omp-designer v5 extension for oh-my-pi.
 *
 * Design goals:
 * - one extension instance, even when discovery returns the same package twice
 * - package-relative assets (no dependency on legacy managed-skill copies)
 * - prompt-only workflow guidance; no skill-read tool gate
 * - MCP configuration is observed, never mutated
 * - bounded delivery validation with no infinite continuation loop
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "../shared/security.mjs";
import { analyzeScreenshot } from "../shared/screenshot-analysis.mjs";
import { claimFindings } from "../shared/delivery-claims.mjs";
import { readDriverReport, summarizeDriver } from "../shared/driver-report.mjs";
import { readCanvasIndex, writeCanvasFiles } from "../shared/design-canvas.mjs";
import { collectSkillUsage } from "../shared/skill-usage.mjs";
import { resolveFlags, describeFlags } from "../shared/designer-flags.mjs";

const HOME = homedir();
const MODULE_FILE = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = resolve(dirname(MODULE_FILE), "..");
const SKILLS_ROOT = join(PACKAGE_ROOT, "skills");
const DATA_ROOT = join(PACKAGE_ROOT, "data", "ui-ux-pro-max");
const SCRIPTS_ROOT = join(PACKAGE_ROOT, "scripts");
const QUALITY_SCRIPT = join(SCRIPTS_ROOT, "fix-ai-slop.mjs");
const LAYOUT_SCRIPT = join(SCRIPTS_ROOT, "analyze-layout.mjs");

const AGENT_ROOT = join(HOME, ".omp", "agent");
const STATE_FILE = join(AGENT_ROOT, "designer-state.json");
const VIBE_FILE = join(AGENT_ROOT, "designer-vibes.json");
const MCP_CONFIG = join(AGENT_ROOT, "mcp.json");
const TRACE_DIR = join(AGENT_ROOT, "designer-traces");
const LEGACY_EXTENSION = join(AGENT_ROOT, "extensions", "designer", "index.ts");
const GLOBAL_STATE_KEY = "*";
const INSTANCE_SYMBOL = Symbol.for("omp-designer.v5.registered");
const INSTANCE_ENV = "OMP_DESIGNER_V5_REGISTERED_PID";
const INSTANCE_LOCK = join(tmpdir(), `omp-designer-v5-${process.pid}.lock`);
/**
 * Identity of the process that owns the lock file.
 *
 * Windows recycles PIDs and the lock name carries the PID, so a file left behind
 * by a dead process made the next process to hold that PID answer "another realm
 * already registered" and return before registering a single hook: the whole
 * extension went silently inert for that session, with no error and no trace
 * line. Recording the owner's PID and process start time makes the check exact —
 * only an identical pair means another realm of THIS process owns the lock.
 */
const INSTANCE_START_MS = Math.round(Date.now() - process.uptime() * 1000);
const INSTANCE_OWNER = `${process.pid}:${INSTANCE_START_MS}`;
/**
 * Two realms of one process estimate that start time milliseconds apart, so the
 * comparison carries a tolerance. A PID recycled by a *later* process differs by
 * far more than this, which is the case the tolerance has to keep apart.
 */
const INSTANCE_OWNER_TOLERANCE_MS = 2000;

/** True only when the lock file records this very process. */
function lockHeldByThisProcess(raw: string): boolean {
  const [pidText, startText] = raw.trim().split(":");
  if (Number(pidText) !== process.pid) return false;
  const recorded = Number(startText);
  if (!Number.isFinite(recorded)) return false;
  return Math.abs(recorded - INSTANCE_START_MS) <= INSTANCE_OWNER_TOLERANCE_MS;
}

/**
 * Claim the cross-realm lock. False means another realm of this same process
 * already registered; debris from a recycled PID is taken over instead, because
 * answering "already registered" to a dead process's leftovers disables the
 * extension without saying so. JavaScript runs one thread, so this read-then-
 * takeover cannot interleave with another realm's own claim.
 */
function claimInstanceLock(): boolean {
  try {
    closeSync(openSync(INSTANCE_LOCK, "wx", 0o600));
  } catch (error) {
    if (asRecord(error).code !== "EEXIST") return true; // no lock available: the in-memory guards stand
    try {
      if (lockHeldByThisProcess(readFileSync(INSTANCE_LOCK, "utf8"))) return false;
    } catch {
      return true; // unreadable debris is not evidence of a live realm
    }
    try {
      writeFileSync(INSTANCE_LOCK, INSTANCE_OWNER, { mode: 0o600 });
    } catch {
      // The takeover failed; the two in-memory guards still stand.
    }
    return true;
  }
  try {
    writeFileSync(INSTANCE_LOCK, INSTANCE_OWNER, { mode: 0o600 });
  } catch {
    // Content is advisory; owning the file is what the guard needs.
  }
  return true;
}

// Last measured skill-usage line per working directory. Module scope because the
// doctor command reads it from outside the registration closure; keys are working
// directories that accumulate at runtime, so it stays a Map.
const skillUsageByCwd = new Map<string, string>();

const DESIGNER_SKILLS = Object.freeze([
  { name: "designer-master", file: join(SKILLS_ROOT, "designer-master.md"), role: "core" },
  { name: "design-md", file: join(SKILLS_ROOT, "design-md.md"), role: "visual-system" },
  { name: "expression", file: join(SKILLS_ROOT, "expression.md"), role: "expression" },
  { name: "animate", file: join(SKILLS_ROOT, "animate.md"), role: "motion" },
  { name: "review-skill", file: join(SKILLS_ROOT, "review-skill.md"), role: "review" },
  { name: "run", file: join(SKILLS_ROOT, "run.md"), role: "drive" },
  { name: "run-skill-generator", file: join(SKILLS_ROOT, "run-skill-generator.md"), role: "drive-authoring" },
]);

const DESIGNER_MCP_NAMES = new Set([
  "21st-dev-magic",
  "ui-layouts",
  "designmd",
  "chrome-devtools",
]);

const PROMPT_MARKER_RE = /\n?\[DESIGNER MODE: ACTIVE v5\][\s\S]*?\[\/DESIGNER MODE\]\n?/g;

/**
 * The delivery-checks block, named so the plan-only variant removes it by
 * identity rather than by a regex that silently stops matching when the
 * wording changes.
 */
const DELIVERY_CHECKS_SECTION = `## Delivery checks

For substantive frontend work, run:
1. node ${QUALITY_SCRIPT} --check .
2. node ${LAYOUT_SCRIPT} .
3. the project's build command
4. browser QA at 375px and a wide viewport with the tooling you have
5. save a full-page capture per viewport in the project, then open the saved full-page screenshots and look at them: blank bands mean broken reveal behavior — fix and recapture

Warnings are review input; only true blockers block delivery. Report what you ran and what remains unverified. A check you could not run is not a pass: say it was not measured, and why.
The checks only police honesty and function — never boldness: do not design defensively to satisfy them.`;

const DESIGNER_PROMPT = `[DESIGNER MODE: ACTIVE v5]

You are the project's UI/UX design engineer. Produce specific, usable interfaces while respecting the user's scope and existing code.

## Workflow

1. Read ${join(SKILLS_ROOT, "designer-master.md")} once at the start of a substantive design task.
2. Inspect the existing project before proposing or changing architecture.
3. Choose interaction behavior from the request:
   - If the user explicitly asks for a plan or approval, enter a read-only plan phase: inspect, read only relevant skills, write no project files, present a concise plan, and wait.
   - If the user says to build immediately, do not ask preference questions.
   - Otherwise ask at most two questions, and only when the answer materially changes the result.
4. After approval and before implementation of a new page or major redesign, create short PRODUCT.md, EVIDENCE.md, and DESIGN.md files; skip them for small edits.
5. Read ${join(SKILLS_ROOT, "design-md.md")} for a new visual system or major redesign, and ${join(SKILLS_ROOT, "expression.md")} to set the ambition dials and build the page's signature moment.
6. Read ${join(SKILLS_ROOT, "animate.md")} only when meaningful motion is requested or already present.
7. Build and test in the user's project. Preserve established brand tokens and dependencies unless the user asked for a redesign.
8. Read ${join(SKILLS_ROOT, "review-skill.md")} before delivery and perform the proportional review it describes.

## Plan-only contract

When approval is requested, the plan is the deliverable for this turn.
- Preserve every explicit scope item. If the user requests multiple pages or routes, plan concrete routes; never silently collapse them into one page.
- Map the requested pages, effects, animation, scroll behavior, and approval boundary to named plan items. Do not substitute your preferred architecture for the brief.
- Aim for about 700 words and stay under 800 unless the user explicitly asks for a detailed specification, in which case go as long as needed. Cover direction, route/page purpose, interaction narrative, responsive behavior, stack, and factual/technical risks.
- Do not write PRODUCT.md, EVIDENCE.md, DESIGN.md, scaffold code, or install dependencies before approval.
- Do not read the delivery-review skill or run delivery checks during the plan-only turn.
- Never claim a skill, reference, CSV row, browser, or test was read or run unless that action actually occurred.
- Treat exact palette, typography, performance, and accessibility assertions as provisional until checked.
- Apply factual and functional constraints to the plan itself: no metrics, testimonials, signup success, or unsupported capabilities.
- Mark every simulated AI output or interaction as a visible demo in the plan; never describe a scripted sequence as live reasoning or a real model.
- For timelines or educational claims, include source verification; label future scenarios as speculation.
- Budget motion: choose one primary scroll-driven narrative for the site; elsewhere keep purposeful state and hover feedback.
- End by waiting for approval; no second preference question after "surprise me."

## Art direction

State one art direction derived from the product's real world — materials, setting, audience, actual interface — name the one distinctive anchor that carries the page, and give the page one signature moment (expression.md has the menu and recipes). Boring is also a failure: bold typography, color blocking, and layout are encouraged, never violations. If nothing on the page is specific to this product, the direction failed regardless of polish.

Treat these statistical defaults as failed art direction unless the user asked for them: violet/purple primary + cyan accent on near-black; a gradient or glow wallpaper hero with no product content; gradient-blurred blobs or abstract geometry standing in for product imagery; interchangeable equal-card grids; headlines that fit any product; glassmorphism, bento grids, or scroll effects as decoration. Derive color and type from the product's world, not the tech-brand mean; when the product is abstract, ground the page in its concrete interface and workflow. A request "in the style of X" is a brief about X's principles, not its pixels: extract and restate them for this product (designer-master has the protocol).

Content must be visible at initial paint: scroll-reveal only enhances — no-JS, reduced motion, and full-page screenshots must show every section. Blank regions in a full-page screenshot are a delivery failure.

## Research and MCP policy

MCP research is optional and task-driven. Never call every MCP reflexively. Prefer the built-in browser or chrome-devtools for QA; use ui-layouts, 21st-dev, or designmd only when a reference materially helps. If a server is unavailable, continue locally.

Palette/typography data (optional index): ${join(DATA_ROOT, "colors.csv")} and ${join(DATA_ROOT, "typography.csv")}. Grep relevant rows only; a user-supplied brand system wins; validate contrast yourself (expression.md has the fast derivation).

## Product and copy integrity

- Treat the user's product description as a closed fact set. Before writing page copy, list allowed capabilities in PRODUCT.md and omit unsupplied claims: prices, metrics, customers, certifications, testimonials, shipping terms, and product capabilities. Label demo/example data visibly.
- No unverified third-party logos, hotlinked stock, or prominent links/buttons that point to "#" or do nothing.
- Do not simulate signup or contact success without a real delivery mechanism; without a destination, use truthful in-page actions.
- Do not plan a signup/contact form unless a real destination exists or obtaining one is an explicit unresolved requirement.
- Full copy/evidence rules: designer-master.md.

## Implementation quality

- Use semantic HTML, visible focus, usable keyboard behavior, responsive layouts, and reduced-motion support when animation exists.
- For a full marketing page, inspect the composition map before coding. If two sections both resolve to equal card grids, redesign one (expression.md lists section shapes) unless repeated comparison is the real structure.
- Do not add routes, dependencies, or dark mode the task does not need. Do not install a motion library only to fade sections into view. No fake product screenshots — use a real component preview or an explicit placeholder.
- Build the page anchor honestly: a miniature real component with demo-labelled data, an inline SVG diagram or geometric render of real product form, a typographic composition, downloaded free-license photography (saved to assets/ with source recorded in EVIDENCE.md — never hotlinked), or a labelled placeholder. Text over imagery needs a scrim or measured contrast, at 375px too.
- A landing page answers the visitor's whole question chain — what it is, how it works, what it looks like in use, concrete details, practicalities, action. A vague brief deserves the fuller story; a tight brief can be complete sooner. Never pad.
- Full build guidance: designer-master.md and design-md.md.

${DELIVERY_CHECKS_SECTION}

[/DESIGNER MODE]`;

const PLAN_ONLY_PROMPT = DESIGNER_PROMPT
  .replace(
    `8. Read ${join(SKILLS_ROOT, "review-skill.md")} before delivery and perform the proportional review it describes.`,
    "8. Do not read or execute the delivery-review skill during this plan-only turn.",
  )
  .replace(`${DELIVERY_CHECKS_SECTION}\n\n`, "");

/**
 * Conditional contract fragments, injected per turn.
 *
 * The claude-code harness composes its page contract at call time instead of
 * shipping one frozen block: a fragment appears only when the request calls for
 * it and the tenant's flag allows it. The equivalent here is one short,
 * additive section per in-scope concern, each naming the sibling skill to read
 * and the failure it prevents. A turn that triggers none gets the base contract
 * byte-for-byte.
 */
const CONTRACT_FRAGMENTS: Record<string, string> = {
  motion: `\n\n## Motion is in scope for this request\nRead ${join(SKILLS_ROOT, "animate.md")} before writing transitions. One orchestrated moment beats scattered effects; reduced motion and a no-JS load must still show every section.`,
  dataviz: `\n\n## Charts or numbers are in scope for this request\nDraw marks, ticks, and labels on one scale and label only values the data actually reaches. Take chart text from the theme tokens so both themes read. A chart that decorates or exaggerates is a failure, not a flourish.`,
  forms: `\n\n## Interactive input is in scope for this request\nGive every control a stable id and a visible focus state, and route submissions to a real destination. Never simulate success: an in-page confirmation that delivers nothing is a false claim about the product.`,
  verify: `\n\n## Seeing it work is in scope for this request\nRead ${join(SKILLS_ROOT, "run.md")} before claiming anything about the rendered page. Launch the real app and drive it: a project run skill (\`.omp/skills/run-*/SKILL.md\`) if one exists, otherwise \`node ${join(SCRIPTS_ROOT, "designer-driver.mjs")} --start "<the project's start command>" --url <url>\`, which captures 1440 and 375, collects console errors, and writes \`screenshots/driver-report.json\`. Look at the captures. If launching took real work, generate a run skill with ${join(SKILLS_ROOT, "run-skill-generator.md")} instead of rediscovering it next time. The run leaves a canvas beside the captures (\`designer-canvas.html\`, rebuilt by \`node ${join(SCRIPTS_ROOT, "designer-canvas.mjs")}\`) showing every board and capture at once. A blank frame is a failure to launch, and a page you never opened has no result to report.`,
};

// Request words that put a concern in scope, and the dependencies that prove it
// is already part of the project.
const MOTION_REQUEST_RE = /\b(animat\w*|motion|transition\w*|scroll[- ]?(?:reveal|driven|linked)|parallax|micro[- ]?interaction\w*|gsap|framer|lottie)\b/i;
const DATAVIZ_REQUEST_RE = /\b(chart\w*|graph\w*|plot\w*|dashboard\w*|metric\w*|analytics|data ?viz\w*|sparkline\w*|kpi\w*|stats?)\b/i;
const FORMS_REQUEST_RE = /\b(form\w*|sign ?up|newsletter|checkout|contact|login|sign[- ]?in|input\w*|onboard\w*|waitlist)\b/i;
/** Words that mean the rendered page has to be seen, not described. */
const VERIFY_REQUEST_RE = /\b(run|start|launch|serve|preview|screenshot\w*|capture\w*|browser\w*|renders?|rendering|visually?|verify|validate|lighthouse|responsive|viewport|breakpoint\w*|looks? (?:like|right|wrong)|see (?:it|how))\b/i;
const MOTION_DEPENDENCIES = new Set([
  "framer-motion", "motion", "motion-v", "gsap", "animejs", "auto-animate", "lenis",
  "lottie-react", "lottie-web", "@react-spring/web", "@vueuse/motion", "@formkit/auto-animate",
]);
const DATAVIZ_DEPENDENCIES = new Set([
  "recharts", "chart.js", "d3", "echarts", "apexcharts", "victory", "plotly.js",
  "lightweight-charts", "@nivo/core", "@visx/shape", "highcharts", "chartist",
]);

function projectDependencies(cwd: string): Set<string> {
  const names = new Set<string>();
  try {
    const parsed = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as Record<string, unknown>;
    for (const field of ["dependencies", "devDependencies"]) {
      for (const name of Object.keys(asRecord(parsed[field]))) names.add(name);
    }
  } catch {
    // No manifest, no dependency signal. The request words still decide.
  }
  return names;
}

/**
 * Which fragments this turn earns. A flag of `false` suppresses its fragment
 * regardless of the request; otherwise the request words or an installed
 * dependency put the concern in scope.
 */
function fragmentNamesFor(userPrompt: string, cwd: string, flags: Record<string, boolean>): string[] {
  const names: string[] = [];
  const dependencies = projectDependencies(cwd);
  const has = (set: Set<string>): boolean => [...dependencies].some((name) => set.has(name));
  if (flags.motion && (MOTION_REQUEST_RE.test(userPrompt) || has(MOTION_DEPENDENCIES))) names.push("motion");
  if (flags.dataviz && (DATAVIZ_REQUEST_RE.test(userPrompt) || has(DATAVIZ_DEPENDENCIES))) names.push("dataviz");
  if (flags.forms && FORMS_REQUEST_RE.test(userPrompt)) names.push("forms");
  // Verification needs something runnable: a page, a dev script, a start command.
  const runnable = existsSync(join(cwd, "index.html")) ||
    [...dependencies].length > 0 ||
    existsSync(join(cwd, "package.json"));
  if (flags.verify && runnable && VERIFY_REQUEST_RE.test(userPrompt)) names.push("verify");
  return names;
}

/**
 * Assemble the contract for one turn.
 *
 * `buildContract()` with no arguments returns the frozen default contract, which
 * is what every existing consumer and contract check sees; fragments and the
 * owner-preference section are appended at the same anchor the marker strip uses,
 * so a turn with neither is byte-identical to the default.
 */
function buildContract({ planOnly = false, fragments = [], vibe = "" }: { planOnly?: boolean; fragments?: string[]; vibe?: string } = {}): string {
  const base = planOnly ? PLAN_ONLY_PROMPT : DESIGNER_PROMPT;
  // Order comes from the declared fragment table, not from the caller, so a
  // future caller cannot reshuffle the contract. Unknown names drop out.
  const declarOrder = Object.keys(CONTRACT_FRAGMENTS);
  const extra = [
    ...declarOrder.filter((name) => fragments.includes(name)).map((name) => CONTRACT_FRAGMENTS[name]),
    vibe,
  ].filter(Boolean);
  if (extra.length === 0) return base;
  return base.replace(/\n\[\/DESIGNER MODE\]$/, `${extra.join("")}\n\n[/DESIGNER MODE]`);
}

interface CommandContext {
  cwd?: string;
  ui?: { notify?: (message: string, level: string) => void };
  editor?: { setText?: (text: string) => void };
}

interface ExtensionContext {
  cwd?: string;
}

interface ExtensionAPI {
  registerCommand(
    name: string,
    options: {
      description: string;
      aliases?: string[];
      handler: (args: unknown, ctx: CommandContext) => void | Promise<void>;
    },
  ): void;
  on(
    event: string,
    handler: (event?: unknown, ctx?: ExtensionContext) => unknown | Promise<unknown>,
  ): void;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function readState(): Record<string, boolean> {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const record = parsed as Record<string, unknown>;

    // Migrate the old global shape without discarding it.
    if (typeof record.enabled === "boolean") {
      if (typeof record.cwd === "string") return { [record.cwd]: record.enabled };
      return { [GLOBAL_STATE_KEY]: record.enabled };
    }

    return Object.fromEntries(
      Object.entries(record).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
    );
  } catch {
    return {};
  }
}

function writeState(state: Record<string, boolean>): void {
  mkdirSync(AGENT_ROOT, { recursive: true });
  const temporary = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, STATE_FILE);
}

function readVibes(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(VIBE_FILE, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0),
    );
  } catch {
    return {};
  }
}

function writeVibes(vibes: Record<string, string>): void {
  mkdirSync(AGENT_ROOT, { recursive: true });
  const temporary = `${VIBE_FILE}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(vibes, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, VIBE_FILE);
}

function vibeSection(cwd: string): string {
  const vibe = readVibes()[cwd];
  if (!vibe) return "";
  return `\n\n## Owner preferences (persistent, set with /designer-vibe)\n${vibe.slice(0, 1200)}\nTreat these as standing user decisions: they rank as explicit user choices in the priority order.`;
}

function isEnabled(cwd = process.cwd()): boolean {
  if (process.env.OMP_DESIGNER_MODE === "1") return true;
  if (process.env.OMP_DESIGNER_MODE === "0") return false;
  const state = readState();
  return state[cwd] === true || state[GLOBAL_STATE_KEY] === true;
}

function toggle(cwd: string): boolean {
  const state = readState();
  delete state[GLOBAL_STATE_KEY];
  const enabled = state[cwd] !== true;
  if (enabled) state[cwd] = true;
  else delete state[cwd];
  writeState(state);
  return enabled;
}

function normalizeSystemPrompt(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" ? [value] : [];
}

function stripDesignerPrompt(prompts: string[]): string[] {
  return prompts
    .map((prompt) => prompt.replace(PROMPT_MARKER_RE, "\n").trim())
    .filter(Boolean);
}

function tracePath(cwd: string): string {
  const base = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "root";
  return join(TRACE_DIR, `${base}-${shortHash(cwd)}.jsonl`);
}

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    // Single source of truth for secret patterns: shared/security.mjs.
    return redactSecrets(value);
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redact(item)]),
    );
  }
  return value;
}

function writeTrace(cwd: string, event: string, details: Record<string, unknown> = {}): void {
  try {
    mkdirSync(TRACE_DIR, { recursive: true });
    appendFileSync(tracePath(cwd), `${JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      cwd,
      ...redact(details) as Record<string, unknown>,
    })}\n`);
  } catch {
    // Observability must not break the agent.
  }
}

/**
 * Measure which skill bodies this session actually read.
 *
 * Observation only: v5 deliberately has no skill gate, and this adds no
 * enforcement. It reads the transcript the host already wrote and records the
 * per-skill evidence, so the original question ("did the agent ever read
 * designer-master?") stays answerable without reintroducing a gate. Failures are
 * swallowed; observability must never break the agent.
 */
function recordSkillUsage(cwd: string, sessionId: string, sinceMs?: number): void {
  try {
    const usage = collectSkillUsage({
      sessionId,
      cwd,
      sinceMs: sinceMs ?? 0,
      skills: DESIGNER_SKILLS.map((skill) => ({ name: skill.name, file: skill.file })),
    });
    skillUsageByCwd.set(cwd, usage.line);
    writeTrace(cwd, "skill_usage", {
      sessionId,
      transcript: usage.transcript,
      reason: usage.reason,
      read: usage.read,
      namedNeverRead: usage.namedNeverRead,
      silent: usage.silent,
      unmeasured: usage.unmeasured,
      detail: usage.rows.map((row: { name: string; mentioned: number; read: number }) => ({
        name: row.name,
        mentioned: row.mentioned,
        read: row.read,
      })),
    });
  } catch {
    // Observability must not break the agent.
  }
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function mcpSummary(): string {
  try {
    const parsed = JSON.parse(readFileSync(MCP_CONFIG, "utf8")) as Record<string, unknown>;
    const servers = asRecord(parsed.mcpServers);
    const configured = [...DESIGNER_MCP_NAMES].filter((name) => name in servers);
    const enabled = configured.filter((name) => asRecord(servers[name]).enabled === true);
    return `${configured.length}/4 configured, ${enabled.length} enabled (${enabled.join(", ") || "none"})`;
  } catch {
    return "not configured or invalid";
  }
}

/**
 * Last recorded visual evidence per working directory, for the doctor report.
 * The trace on disk stays the durable record; this only saves the doctor a read.
 */
const evidenceByCwd = new Map<string, string>();

function recordScreenshotEvidence(
  cwd: string,
  sessionId: string,
  evidence: ScreenshotEvidence,
): void {
  // The driver clause appears only when a driver has actually run, so a project
  // that never used one keeps the short, stable line the suite asserts.
  const driverClause = evidence.driver === "none" ? "" : `, driver: ${evidence.driver}`;
  const line = `${evidence.state} (captures: ${evidence.found}, stale: ${evidence.stale})${driverClause}`;
  evidenceByCwd.set(cwd, line);
  writeTrace(cwd, "screenshot_evidence", { sessionId, ...evidence });
}

/**
 * The project's own run skill, if a previous session authored one. cc discovers
 * these per project and prefers them over re-deriving launch steps; the same
 * lookup drives the doctor line and the contract's verify fragment.
 */
function projectRunSkill(cwd: string): string | null {
  for (const root of [join(cwd, ".omp", "skills"), join(cwd, ".claude", "skills")]) {
    if (!existsSync(root)) continue;
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^run[-_]/.test(entry.name)) continue;
        const skill = join(root, entry.name, "SKILL.md");
        if (existsSync(skill)) return skill;
      }
    } catch {
      // An unreadable skills directory is not a project defect; keep looking.
    }
  }
  return null;
}

/**
 * What the skill set costs if everything were read, and which file dominates it.
 *
 * cc's `/skill-doctor` reports skill usage alongside context cost, and the number
 * matters here for the same reason: the injected contract is a few KB, while the
 * skills are a ceiling that is only paid for the ones a turn actually reads.
 */
function describeSkillContext(): string {
  const measured: Array<{ name: string; bytes: number }> = [];
  for (const skill of DESIGNER_SKILLS) {
    try {
      measured.push({ name: skill.name, bytes: statSync(skill.file).size });
    } catch {
      // A missing skill shows up in the per-skill list below; it costs nothing here.
    }
  }
  if (measured.length === 0) return "no skill files readable";
  const total = measured.reduce((sum, entry) => sum + entry.bytes, 0);
  const largest = [...measured].sort((left, right) => right.bytes - left.bytes)[0];
  const kb = (bytes: number): string => `${Math.round(bytes / 102.4) / 10}KB`;
  return `${measured.length} files, ${kb(total)} if all were read; largest ${largest.name} ${kb(largest.bytes)} — only a turn's own skill is required`;
}

/** One doctor line for the last canvas build. */
function describeCanvas(cwd: string): string {
  const canvas = readCanvasIndex(cwd);
  if (!canvas) return "none";
  const age = canvas.ageMinutes === null
    ? "age unknown"
    : canvas.ageMinutes < 1
      ? "just built"
      : `built ${canvas.ageMinutes}m ago`;
  return `${canvas.boards} board${canvas.boards === 1 ? "" : "s"}, ${age}${canvas.htmlExists ? "" : " (index only)"}`;
}

function doctorReport(cwd: string): string {
  const moduleRealpath = safeRealpath(MODULE_FILE);
  const legacyRealpath = safeRealpath(LEGACY_EXTENSION);
  const duplicateRisk = Boolean(
    legacyRealpath &&
    moduleRealpath &&
    legacyRealpath !== moduleRealpath,
  );
  const skills = DESIGNER_SKILLS.map((skill) => `${skill.name}: ${existsSync(skill.file) ? "present" : "missing"}`);

  return [
    "Designer doctor v5",
    "",
    `Mode for cwd: ${isEnabled(cwd) ? "enabled" : "disabled"}`,
    `Loaded module: ${MODULE_FILE}${MODULE_FILE.startsWith(PACKAGE_ROOT) ? "" : "  <- NOT this checkout (npm copy detected)"}`,
    `Package root: ${PACKAGE_ROOT}`,
    `Legacy extension copy: ${legacyRealpath ?? "none"}`,
    `Duplicate-load risk: ${duplicateRisk ? "YES - remove the legacy copy or unlink the plugin" : "no"}`,
    `Quality validator: ${existsSync(QUALITY_SCRIPT) ? "present" : "missing"}`,
    `Layout validator: ${existsSync(LAYOUT_SCRIPT) ? "present" : "missing"}`,
    `Palette data: ${existsSync(join(DATA_ROOT, "colors.csv")) ? "present" : "missing"}`,
    `MCPs: ${mcpSummary()}`,
    `Skill usage (last session_stop): ${skillUsageByCwd.get(cwd) ?? "not measured yet"}`,
    `Screenshot evidence (last session_stop): ${evidenceByCwd.get(cwd) ?? "not measured yet"}`,
    `Run skill (project): ${projectRunSkill(cwd) ?? "none"}`,
    `Driver: ${existsSync(join(SCRIPTS_ROOT, "designer-driver.mjs")) ? "present" : "missing"}`,
    `Canvas: ${describeCanvas(cwd)}`,
    `Skill context: ${describeSkillContext()}`,
    describeFlags(resolveFlags({ cwd })),
    "",
    ...skills,
    "",
    "Designer mode no longer mutates mcp.json and no longer blocks tools while skills are read.",
  ].join("\n");
}

function looksLikeFrontendProject(cwd: string): boolean {
  // A plain static site (index.html without a package.json) is frontend work
  // too; skipping it would silently disable every delivery and taste check.
  if (existsSync(join(cwd, "index.html"))) return true;
  return existsSync(join(cwd, "package.json")) &&
    ["src", "app", "pages"].some((entry) => existsSync(join(cwd, entry)));
}

// Directories that never count as user work for change detection: dependencies,
// VCS internals, and build/generated output the delivery checks themselves emit.
const CHANGE_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit",
  "coverage", ".cache", ".turbo", ".output", ".vercel", "test-output",
]);

// Whether any source/artifact file under cwd was written since the session began.
// Bounded walk so a pure chat/planning turn (no file writes) skips heavy checks
// and their side effects instead of spawning a build on a no-op turn.
function projectChangedSince(cwd: string, since: number): boolean {
  let budget = 4000;
  const walk = (dir: string): boolean => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (budget-- <= 0) return false;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (CHANGE_SKIP_DIRS.has(entry.name)) continue;
        if (walk(full)) return true;
      } else if (entry.isFile()) {
        try {
          if (statSync(full).mtimeMs > since) return true;
        } catch {
          // Unreadable file: ignore.
        }
      }
    }
    return false;
  };
  return walk(cwd);
}

interface CheckResult {
  name: string;
  ok: boolean;
  skipped?: string;
  output: string;
}

type CheckStatus = "pass" | "fail" | "not-measured";

/**
 * A check that could not run is not a pass.
 *
 * `skipped` checks used to be indistinguishable from passing ones: the report
 * said delivery_checks_passed while a validator or the build never executed,
 * which is the same false-green the Artifact tool's own text forbids ("an empty
 * result can mean no viewer has loaded the version yet, which is NOT evidence of
 * a clean render"). Status keeps the three outcomes apart.
 */
function checkStatus(check: CheckResult): CheckStatus {
  if (check.skipped) return "not-measured";
  return check.ok ? "pass" : "fail";
}

interface PlanCheckResult {
  ok: boolean;
  violations: string[];
}

function messageText(value: unknown): string {
  const content = asRecord(value).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const record = asRecord(block);
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

// The project is English-native: English intent must be robust. German is a
// fallback only, because the owner writes prompts in German.

// The user already has a plan and wants it built now — this outranks any gate
// signal so "review my existing plan and implement it" is NOT treated as plan-only.
function wantsImmediateImplementation(p: string): boolean {
  return /\b(?:implement|build|execute|apply|carry out|proceed with|go ahead with|ship)\b[\s\S]{0,25}\b(?:the|my|this|that|your|existing)\s+(?:plan|spec|design)\b/i.test(p) ||
    /\bjust (?:build|implement|code|do) it\b/i.test(p) ||
    /\b(?:implement|build|code) it now\b/i.test(p);
}

// Explicit approval gate: "wait for approval", "get sign-off first", "for my approval".
function mentionsApprovalGate(p: string): boolean {
  return /\bwait(?:ing)?\s+for\b[\s\S]{0,25}\b(?:ap{1,2}rov|sign[- ]?off|go[- ]?ahead|green[- ]?light|confirm)/i.test(p) ||
    /\b(?:await|pending|for|need|needs|require[sd]?|get|getting|my|your)\b[\s\S]{0,15}\bap{1,2}rov/i.test(p) ||
    /\bap{1,2}rov\w*\b[\s\S]{0,20}\b(?:first|before)\b/i.test(p) ||
    /\bsign[- ]?off\b/i.test(p) ||
    /\bgo[- ]?ahead\b/i.test(p) ||
    /\bgreen[- ]?light\b/i.test(p);
}

// A prospective approval word: the user intends to approve/confirm before work.
// "review" is deliberately excluded — "review my existing plan and implement it"
// is a build request, not an approval gate.
function mentionsApprovalWord(p: string): boolean {
  return /\bap{1,2}rov(?:e|es|ed|al|ing)?\b/i.test(p) ||
    /\bconfirm(?:ation|ed|s)?\b/i.test(p) ||
    /\bsign[- ]?off\b/i.test(p) ||
    /\bgo[- ]?ahead\b/i.test(p) ||
    /\bgreen[- ]?light\b/i.test(p);
}

// Plan is explicitly staged before any building: "make a plan first", "plan before you build".
function mentionsPlanFirst(p: string): boolean {
  return /\bplan\b[\s\S]{0,40}\b(?:first|before|for (?:your |my )?(?:ap{1,2}roval|review|sign))/i.test(p) ||
    /\b(?:first|before (?:you|we|i)\b[\s\S]{0,25}|before (?:implement|build|cod))\b[\s\S]{0,30}\bplan\b/i.test(p);
}

// Implementation is deferred: "do not implement yet", "before you build".
function defersImplementation(p: string): boolean {
  return /\bbefore (?:you |we |i )?(?:implement|build|start|begin|cod|writ|develop|scaffold)/i.test(p) ||
    /\b(?:do ?n['o]?t|don['o]?t|dont|please don['o]?t|no need to|hold off(?: on| from)?)\b[\s\S]{0,30}\b(?:implement|build|code|develop|create|scaffold|start)\b/i.test(p) ||
    /\b(?:implement|build|code|develop|scaffold)\w*\b[\s\S]{0,15}\byet\b/i.test(p);
}

// German fallback: "erst planen", "warte auf Freigabe", "noch nicht umsetzen".
function mentionsGermanPlanGate(p: string): boolean {
  return /\b(?:erst|zuerst)\b[\s\S]{0,25}\b(?:plan|entwurf|konzept)/i.test(p) ||
    /\bplan\w*\b[\s\S]{0,20}\berst\b/i.test(p) ||
    /\bfreigabe\b/i.test(p) ||
    /\b(?:warte|warten|abwarten)\b[\s\S]{0,25}\b(?:freigabe|genehmigung|zustimmung|best[äa]tigung|ok)\b/i.test(p) ||
    /\bnoch\s+nicht\b[\s\S]{0,25}\b(?:umsetz|implementier|baue|bauen|programmier|entwickel|erstell)/i.test(p);
}

function asksForApprovalPlan(prompt: string): boolean {
  const p = prompt ?? "";
  if (wantsImmediateImplementation(p)) return false;
  const hasPlanWord = /\bplan\b/i.test(p);
  return mentionsApprovalGate(p) ||
    (hasPlanWord && mentionsApprovalWord(p)) ||
    mentionsPlanFirst(p) ||
    defersImplementation(p) ||
    mentionsGermanPlanGate(p);
}

// The user explicitly asked for a long/detailed plan, so the length ceiling does not apply.
function wantsDetailedPlan(prompt: string): boolean {
  const p = prompt ?? "";
  return /\b(?:detailed|in[- ]?depth|comprehensive|thorough|exhaustive|granular|step[- ]by[- ]step|long[- ]form)\b[\s\S]{0,25}\b(?:spec|specification|plan|breakdown|document|write[- ]?up|proposal|blueprint|outline|rfc)\b/i.test(p) ||
    /\b(?:detailed specification|full spec)\b/i.test(p) ||
    /\b(?:detailliert|ausführlich|umfassend|gründlich)\w*\b[\s\S]{0,25}\b(?:plan|spezifikation|konzept|dokument)/i.test(p);
}

function asksForMultiplePages(prompt: string): boolean {
  return /\b(?:various|multiple|several|many|multi[- ]?page)\s+(?:pages?|routes?)\b/i.test(prompt) ||
    /\bpages?\b[\s\S]{0,80}\b(?:various|multiple|several|many)\b/i.test(prompt);
}

function planChecks(userPrompt: string, response: string): PlanCheckResult {
  const violations: string[] = [];
  if (!response.trim()) violations.push("The approval plan is missing.");
  const wordCount = response.trim().split(/\s+/).filter(Boolean).length;
  // Length is a soft ceiling: allowed without limit when the user explicitly
  // asked for a detailed specification, otherwise a continuation to tighten it.
  if (wordCount > 800 && !wantsDetailedPlan(userPrompt)) {
    violations.push(`The approval plan is long (${wordCount} words); aim for about 700 words and stay under 800, unless the user asked for a detailed specification.`);
  }

  if (asksForMultiplePages(userPrompt)) {
    const routes = new Set(
      [...response.matchAll(/`(\/(?:[a-z0-9][a-z0-9/_-]*)?)`/gi)].map((match) => match[1]),
    );
    if (/\bsingle[- ]page\b/i.test(response)) {
      violations.push("The user requested multiple pages, but the plan proposes a single page.");
    }
    if (routes.size < 2) {
      violations.push("The user requested multiple pages, but fewer than two concrete routes are named.");
    }
  }

  if (!/\b(?:form|signup|contact|newsletter|email capture)\b/i.test(userPrompt) &&
      /\b(?:add|include|build|feature|animated|minimal|signup|contact|connect|newsletter)\b[\s\S]{0,30}\bform\b/i.test(response)) {
    violations.push("The plan adds a form without a user-supplied destination or form requirement.");
  }

  if (!/\b(?:metric|statistic|percentage|benchmark|data point)\b/i.test(userPrompt) &&
      /\b(?:add|include|show|display|feature|animated|floating)\b[\s\S]{0,25}\b(?:metrics?|statistics?|stats?|stat counters?|data points?)\b/i.test(response)) {
    violations.push("The plan adds metrics or statistics without a supplied data source.");
  }

  if (/\b(?:scroll[- ]?jacking|lenis)\b/i.test(response)) {
    violations.push("The plan proposes scroll-jacking or Lenis instead of preserving native scroll.");
  }

  if (/\b(?:historical timeline|timeline (?:of|showing)|AI milestones|evolution timeline)\b/i.test(response) &&
      !/\b(?:source|verify|verification|fact[- ]?check)\b/i.test(response)) {
    violations.push("Historical or timeline content lacks an explicit source-verification step.");
  }

  if (/\b(?:links?|href|points?|leads?)\b[\s\S]{0,35}(?:to\s+)?[`"']?#[`"']?/i.test(response) ||
      /\bdemo (?:link|placeholder)\b/i.test(response)) {
    violations.push("The plan includes a dead or placeholder link instead of a real destination.");
  }

  if (/\b(?:live|real[- ]?time)\b[\s\S]{0,50}\b(?:AI|reasoning|model output)\b/i.test(response) &&
      !/\b(?:labelled|labeled|visible)\b[\s\S]{0,30}\bdemo\b/i.test(response)) {
    violations.push("A scripted AI interaction is described as live without a visible demo label.");
  }

  return { ok: violations.length === 0, violations };
}

function runProcess(name: string, command: string, args: string[], cwd: string, timeout: number, extraEnv: Record<string, string> = {}): CheckResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, ...extraEnv },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error) return { name, ok: false, output: result.error.message };
  return { name, ok: result.status === 0, output };
}

function projectBuildCheck(cwd: string): CheckResult {
  if (!existsSync(join(cwd, "package.json"))) {
    return { name: "build", ok: true, skipped: "static site without a build system", output: "" };
  }
  try {
    const parsed = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as Record<string, unknown>;
    const scripts = asRecord(parsed.scripts);
    if (typeof scripts.build !== "string") {
      return { name: "build", ok: true, skipped: "no build script", output: "" };
    }
    return runProcess("build", "npm", ["run", "build"], cwd, 120_000);
  } catch (error) {
    return { name: "build", ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}

function deliveryChecks(cwd: string, userFacts = ""): CheckResult[] {
  if (!looksLikeFrontendProject(cwd)) {
    return [{ name: "project", ok: true, skipped: "not a frontend project", output: "" }];
  }
  const factEnv: Record<string, string> = userFacts ? { DESIGNER_USER_FACTS: userFacts } : {};
  return [
    runProcess("quality", process.execPath, [QUALITY_SCRIPT, "--check", "."], cwd, 45_000, factEnv),
    runProcess("layout", process.execPath, [LAYOUT_SCRIPT, "."], cwd, 45_000),
    projectBuildCheck(cwd),
  ];
}

function truncate(text: string, max = 7000): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated ${text.length - max} characters]`;
}

// Validator rules that mark statistical-default (AI slop) output. They stay
// warnings — never blockers — but their presence after passing delivery checks
// grants one bounded self-repair continuation.
const TASTE_RULES = new Set([
  "reveal-hidden-content",
  "ai-default-palette",
  "gradient-imagery",
  "gradient-heavy",
  "missing-page-details",
  "display-scale-timid",
  "page-depth-thin",
]);

// Copy-side slop from the quality validator that joins the same review.
const COPY_TASTE_RULES = new Set([
  "remote-placeholder-asset",
  "stat-tile-claim",
  "contact-details-unverified",
]);

interface TasteItem {
  rule: string;
  detail: string;
}

/**
 * Files whose change alters what the page looks like. A logic-only edit (a .ts
 * store, a test) must not demand a capture; a stylesheet or markup edit must,
 * because the rendered result is the thing that changed and nothing in the
 * record would otherwise show it was never looked at.
 */
const VISUAL_SURFACE_EXT = /\.(?:css|scss|sass|less|html?|vue|svelte|astro|jsx|tsx)$/i;

interface ScreenshotEvidence {
  state: "fresh" | "stale" | "missing" | "none";
  found: number;
  stale: number;
  newestSourceEdit: number;
  newestCapture: number;
  /** Last driver run for this project: `ok (2 captures, 0 console errors)`, `failed (…)`, or `none`. */
  driver: string;
}

function findScreenshots(cwd: string): string[] {
  const results: string[] = [];
  let budget = 2000;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget-- <= 0) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!CHANGE_SKIP_DIRS.has(entry.name)) walk(full);
      } else if (
        /^screenshot[-_.][^/\\]*\.png$/i.test(entry.name) ||
        (/\.png$/i.test(entry.name) && /(?:^|[/\\])screenshots$/i.test(dir))
      ) {
        results.push(full);
      }
    }
  };
  walk(cwd);
  return results;
}

function parseValidatorJson(script: string, cwd: string, userFacts = ""): Record<string, unknown> | null {
  const extraEnv: Record<string, string> = userFacts ? { DESIGNER_USER_FACTS: userFacts } : {};
  const result = runProcess("validator-json", process.execPath, [script, "--json", "."], cwd, 45_000, extraEnv);
  try {
    return JSON.parse(result.output) as Record<string, unknown>;
  } catch {
    // Unparseable output: the plain-text delivery check already covered failures.
    return null;
  }
}

function reportIssues(report: Record<string, unknown> | null): Array<Record<string, unknown>> {
  return Array.isArray(report?.issues) ? report.issues as Array<Record<string, unknown>> : [];
}

function tasteReview(
  cwd: string,
  userFacts = "",
  sessionStart?: number,
): { items: TasteItem[]; evidence: ScreenshotEvidence } {
  const items: TasteItem[] = [];

  const layoutReport = parseValidatorJson(LAYOUT_SCRIPT, cwd);
  const layoutIssues = reportIssues(layoutReport);
  for (const rule of TASTE_RULES) {
    const found = layoutIssues.find((issue) => issue.rule === rule);
    if (found) items.push({ rule, detail: String(found.message ?? "") });
  }

  const substantive = layoutReport !== null &&
    typeof layoutReport.filesScanned === "number" &&
    layoutReport.filesScanned >= 3;
  if (substantive && layoutReport?.designPresent === false) {
    items.push({
      rule: "design-contract-missing",
      detail: "Substantive frontend work has no DESIGN.md. Write the visual-system contract (direction, color source, type, composition) and align the tokens with it.",
    });
  }
  if (substantive && !existsSync(join(cwd, "PRODUCT.md"))) {
    items.push({
      rule: "product-facts-missing",
      detail: "Substantive frontend work has no PRODUCT.md. Record the closed fact set (audience, capabilities, missing facts) so visible copy can be checked against it.",
    });
  }

  const qualityIssues = reportIssues(parseValidatorJson(QUALITY_SCRIPT, cwd, userFacts));
  for (const rule of COPY_TASTE_RULES) {
    const found = qualityIssues.find((issue) => issue.rule === rule);
    if (found) items.push({ rule, detail: `${String(found.message ?? "")} (e.g. ${JSON.stringify(found.value ?? "")})` });
  }

  // Screenshots captured before the last source edit are stale evidence, and a
  // visual change with no capture at all means the page was never measured.
  // The scan runs unconditionally: with no captures there is nothing to compare
  // against, but the absence itself is the finding.
  const screenshots = findScreenshots(cwd);
  let newestSourceEdit = 0;
  let newestVisualEdit = 0;
  let budget = 3000;
  const scanSources = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget-- <= 0) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!CHANGE_SKIP_DIRS.has(entry.name)) scanSources(full);
      } else if (/\.(?:tsx|jsx|ts|js|css|html|vue|svelte)$/i.test(entry.name)) {
        try {
          const mtime = statSync(full).mtimeMs;
          if (mtime > newestSourceEdit) newestSourceEdit = mtime;
          if (VISUAL_SURFACE_EXT.test(entry.name) && mtime > newestVisualEdit) newestVisualEdit = mtime;
        } catch {
          // unreadable file: ignore
        }
      }
    }
  };
  scanSources(cwd);

  let newestCapture = 0;
  let staleShots = 0;
  for (const shot of screenshots) {
    try {
      const mtime = statSync(shot).mtimeMs;
      if (mtime > newestCapture) newestCapture = mtime;
      if (mtime < newestSourceEdit) staleShots += 1;
    } catch {
      // unreadable capture: ignore
    }
  }

  const visualChangeThisSession =
    sessionStart !== undefined && newestVisualEdit >= sessionStart;
  const state: ScreenshotEvidence["state"] = screenshots.length === 0
    ? (visualChangeThisSession ? "missing" : "none")
    : (newestSourceEdit > 0 && staleShots === screenshots.length ? "stale" : "fresh");
  // A driver run is the difference between "a capture exists" and "the app was
  // driven and produced one"; its report says which, and why not when it failed.
  const driverRun = readDriverReport(cwd);
  const evidence: ScreenshotEvidence = {
    state,
    found: screenshots.length,
    stale: staleShots,
    newestSourceEdit: Math.round(newestSourceEdit),
    newestCapture: Math.round(newestCapture),
    driver: summarizeDriver(driverRun?.report ?? null),
  };

  if (state === "stale") {
    items.push({
      rule: "stale-screenshots",
      detail: "Every screenshot predates the latest source edit; the captures no longer show the shipped page. Recapture after the final change.",
    });
  }
  // Proportional: only a substantive project (the same bar that asks for
  // DESIGN.md and PRODUCT.md) is told to capture; a one-file page that just
  // changed is recorded, not chased.
  if (state === "missing" && substantive) {
    items.push({
      rule: "missing-screenshot-evidence",
      detail: `The visual surface changed this session and the project holds no capture, so nothing in the record shows the rendered page was looked at. Save a full-page screenshot at a narrow and a wide viewport in the project (screenshot-*.png or a screenshots/ folder), open it, and fix what it shows at 375px too — the driver does both widths and the console in one command: node ${join(SCRIPTS_ROOT, "designer-driver.mjs")} --start "<the project's start command>" --url <url>.`,
    });
  }

  for (const shot of screenshots) {
    const analysis = analyzeScreenshot(shot) as {
      error?: string;
      fullPage?: boolean;
      maxBlankRunFraction?: number;
    };
    if (!analysis.error && analysis.fullPage && (analysis.maxBlankRunFraction ?? 0) >= 0.3) {
      items.push({
        rule: "blank-screenshot-band",
        detail: `${basename(shot)} has a contiguous blank band covering ${Math.round((analysis.maxBlankRunFraction ?? 0) * 100)}% of the page: content is hidden at initial paint or the layout is empty. Make every section legible without JavaScript or motion, then recapture.`,
      });
    }
  }

  // Optional model-backed visual judgment: when DESIGNER_REVIEW_MODEL names a
  // vision-capable model, an actual look at the screenshots joins the same
  // bounded repair loop. Failures degrade silently — the deterministic layer
  // above already ran.
  const reviewModel = process.env.DESIGNER_REVIEW_MODEL ?? "";
  if (reviewModel && screenshots.length > 0) {
    const reviewCommand = process.env.DESIGNER_REVIEW_CMD;
    const reviewRun = reviewCommand
      ? runProcess("visual-review", "sh", ["-c", reviewCommand], cwd, 300_000)
      : runProcess("visual-review", process.execPath, [
          join(SCRIPTS_ROOT, "design-review-cli.mjs"), "--target", ".", "--model", reviewModel, "--max-time", "240",
        ], cwd, 320_000);
    if (reviewRun.ok) {
      try {
        const parsed = JSON.parse(readFileSync(join(cwd, "design-review.json"), "utf8")) as {
          verdict?: string;
          review?: Record<string, { score?: number; reason?: string }>;
          topFixes?: string[];
        };
        const zeroCategories = Object.entries(parsed.review ?? {})
          .filter(([, entry]) => entry?.score === 0)
          .map(([key, entry]) => `${key}: ${entry.reason ?? ""}`);
        const weakVerdict = typeof parsed.verdict === "string" && /failed|weak/i.test(parsed.verdict);
        if (weakVerdict || zeroCategories.length > 0) {
          items.push({
            rule: "visual-review",
            detail: [
              `A ${reviewModel} reviewer looked at the screenshots (verdict: ${parsed.verdict ?? "n/a"}).`,
              ...zeroCategories.map((entry) => `problem — ${entry}`),
              ...(parsed.topFixes ?? []).slice(0, 3).map((fix) => `fix — ${fix}`),
            ].join(" "),
          });
        }
      } catch {
        // No readable review document: skip, deterministic checks stand alone.
      }
    }
  }

  return { items, evidence };
}

export default function designerExtension(pi: ExtensionAPI): void {
  // OMP can discover the same extension through a plugin and an explicit path.
  // Those loaders may use separate JS realms, so globalThis alone is not a
  // sufficient process-wide guard. Environment variables are shared by both.
  if (process.env[INSTANCE_ENV] === String(process.pid)) return;
  process.env[INSTANCE_ENV] = String(process.pid);

  const registry = globalThis as Record<symbol, unknown>;
  if (registry[INSTANCE_SYMBOL]) return;

  // Bun loader realms can isolate both globalThis and process.env. A
  // process-scoped file is the final guard across those realms.
  if (!claimInstanceLock()) return;
  process.once("exit", () => {
    try {
      unlinkSync(INSTANCE_LOCK);
    } catch {
      // The process is exiting; stale cleanup cannot affect the session.
    }
  });

  registry[INSTANCE_SYMBOL] = { module: MODULE_FILE, registeredAt: new Date().toISOString() };

  const validationAttempts = new Map<string, number>();
  const tasteRepairAttempts = new Map<string, number>();
  const planRepairAttempts = new Map<string, number>();
  const userFactsByCwd = new Map<string, string>();
  // When each session's work began, used to detect real file changes.
  const sessionStartByCwd = new Map<string, number>();
  // A monotonic per-session token, used to build a collision-resistant fallback
  // id when the host omits session_id — a plain timestamp collides when two
  // sessions in the same cwd start within the same millisecond.
  const sessionTokenByCwd = new Map<string, string>();
  let sessionCounter = 0;

  pi.registerCommand("designer", {
    description: "Toggle the focused omp-designer workflow for this project",
    aliases: ["design"],
    handler: (_args, ctx) => {
      const cwd = ctx.cwd ?? process.cwd();
      const enabled = toggle(cwd);
      writeTrace(cwd, enabled ? "designer_enabled" : "designer_disabled", { version: 5 });
      ctx.ui?.notify?.(
        enabled
          ? "DESIGNER MODE ON - focused workflow active. MCP configuration is unchanged."
          : "DESIGNER MODE OFF",
        "info",
      );
      ctx.editor?.setText?.("");
    },
  });

  pi.registerCommand("designer-vibe", {
    description: "Set persistent design preferences for this project (e.g. 'always light, editorial, no dark themes'); no text shows/clears",
    aliases: ["design-vibe"],
    handler: (args, ctx) => {
      const cwd = ctx.cwd ?? process.cwd();
      const text = (typeof args === "string" ? args : Array.isArray(args) ? args.join(" ") : "").trim();
      const vibes = readVibes();
      if (text === "clear") {
        delete vibes[cwd];
        writeVibes(vibes);
        ctx.ui?.notify?.("Designer vibe cleared for this project.", "info");
      } else if (text) {
        vibes[cwd] = text;
        writeVibes(vibes);
        writeTrace(cwd, "vibe_set", { chars: text.length });
        ctx.ui?.notify?.("Designer vibe saved; it will be injected as a standing user decision.", "info");
      } else {
        ctx.ui?.notify?.(vibes[cwd] ? `Current vibe: ${vibes[cwd]}` : "No vibe set. Usage: /designer-vibe <preferences> | clear", "info");
      }
      ctx.editor?.setText?.("");
    },
  });

  pi.registerCommand("designer-canvas", {
    description: "Rebuild the project design canvas (every board and capture on one page) and report its path",
    aliases: ["design-canvas"],
    handler: (_args, ctx) => {
      const cwd = ctx.cwd ?? process.cwd();
      try {
        const written = writeCanvasFiles(cwd);
        writeTrace(cwd, "canvas_built", { boards: written.boards, path: written.htmlPath });
        ctx.ui?.notify?.(`Canvas: ${written.boards} board${written.boards === 1 ? "" : "s"} -> ${written.htmlPath}`, "info");
        ctx.editor?.setText?.(written.htmlPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeTrace(cwd, "canvas_failed", { error: message });
        ctx.ui?.notify?.(`Canvas failed: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("designer-doctor", {
    description: "Show designer install, asset, duplicate-load, and MCP health",
    aliases: ["design-doctor"],
    handler: (_args, ctx) => {
      const cwd = ctx.cwd ?? process.cwd();
      ctx.editor?.setText?.(doctorReport(cwd));
      ctx.ui?.notify?.("Designer doctor report written to the editor.", "info");
      writeTrace(cwd, "doctor_run", { version: 5 });
    },
  });

  pi.on("resources_discover", (_event, ctx) => {
    const cwd = ctx?.cwd ?? process.cwd();
    if (!isEnabled(cwd)) return;
    const skillPaths = DESIGNER_SKILLS.map((skill) => skill.file).filter(existsSync);
    writeTrace(cwd, "skills_discovered", { count: skillPaths.length, expected: DESIGNER_SKILLS.length });
    return { skillPaths };
  });

  pi.on("before_agent_start", (event, ctx) => {
    const cwd = ctx?.cwd ?? process.cwd();
    if (!isEnabled(cwd)) return;
    const userPrompt = typeof asRecord(event).prompt === "string" ? String(asRecord(event).prompt) : "";
    const isContinuation = userPrompt.includes("[DESIGNER DELIVERY CHECKS FAILED]") ||
      userPrompt.includes("[DESIGNER PLAN CHECKS FAILED]");
    if (userPrompt && !isContinuation) {
      userFactsByCwd.set(cwd, userPrompt);
    }
    // Mark the session start once per real turn. A continuation keeps the
    // original baseline and token so changes across the repair still register
    // and the attempt counter stays keyed to the same session.
    if (!isContinuation || !sessionStartByCwd.has(cwd)) {
      sessionStartByCwd.set(cwd, Date.now());
      sessionTokenByCwd.set(cwd, `${Date.now()}-${++sessionCounter}`);
    }
    const planOnly = asksForApprovalPlan(userPrompt);
    // Flags are read per turn so a project can change them without a restart,
    // and so a malformed flag file can only ever fall back to defaults.
    const { flags, sources: flagSources, ignored: flagsIgnored } = resolveFlags({ cwd });
    const fragments = fragmentNamesFor(userPrompt, cwd, flags);
    // The vibe lives inside the prompt markers so re-injection strips it too.
    const prompt = buildContract({ planOnly, fragments, vibe: vibeSection(cwd) });
    const prompts = stripDesignerPrompt(normalizeSystemPrompt(asRecord(event).systemPrompt));
    writeTrace(cwd, "prompt_injected", {
      version: 5,
      promptChars: prompt.length,
      mode: planOnly ? "plan" : "build",
      fragments,
      flagSources,
      flagsIgnored,
    });
    return { systemPrompt: [...prompts, prompt] };
  });

  pi.on("session_stop", (event, ctx) => {
    const cwd = ctx?.cwd ?? process.cwd();
    if (!isEnabled(cwd)) return;
    const eventRecord = asRecord(event);
    const sessionStart = sessionStartByCwd.get(cwd);
    // Prefer the host session id; otherwise fall back to cwd + this session's
    // monotonic token so separate sessions in the same cwd do not collide.
    const sessionId = typeof eventRecord.session_id === "string" && eventRecord.session_id
      ? String(eventRecord.session_id)
      : `${cwd}:${sessionTokenByCwd.get(cwd) ?? "nostart"}`;
    const userPrompt = userFactsByCwd.get(cwd) ?? "";

    // Evidence, not enforcement: record which skill bodies this session read.
    recordSkillUsage(cwd, sessionId, sessionStart);

    if (asksForApprovalPlan(userPrompt)) {
      const response = messageText(eventRecord.last_assistant_message);
      const result = planChecks(userPrompt, response);
      writeTrace(cwd, result.ok ? "plan_checks_passed" : "plan_checks_failed", {
        sessionId,
        violations: result.violations,
      });
      if (result.ok) {
        planRepairAttempts.delete(sessionId);
        return;
      }

      const repairAttempt = (planRepairAttempts.get(sessionId) ?? 0) + 1;
      planRepairAttempts.set(sessionId, repairAttempt);
      if (repairAttempt >= 2) return;
      return {
        continue: true,
        additionalContext: truncate([
          "[DESIGNER PLAN CHECKS FAILED]",
          "Rewrite only the approval plan. Do not create or modify project files.",
          "Preserve the user's explicit architecture and scope. Keep correct parts concise.",
          ...result.violations.map((violation) => `- ${violation}`),
          "End by waiting for approval.",
          "[/DESIGNER PLAN CHECKS FAILED]",
        ].join("\n")),
      };
    }

    if (!looksLikeFrontendProject(cwd)) {
      writeTrace(cwd, "delivery_checks_skipped", { reason: "not a frontend project" });
      return;
    }

    // Pure chat/planning turns produce no file writes; running build + validators
    // then would be a side effect (dist output) and latency for no reason.
    if (sessionStart !== undefined && !projectChangedSince(cwd, sessionStart)) {
      writeTrace(cwd, "delivery_checks_skipped", { reason: "no project changes this session" });
      return;
    }

    const attempt = (validationAttempts.get(sessionId) ?? 0) + 1;
    validationAttempts.set(sessionId, attempt);

    const checks = deliveryChecks(cwd, userFactsByCwd.get(cwd) ?? "");
    // Verdict stays pass/fail: every check this runtime runs marks itself
    // skipped only when it cannot apply (no build system, not a frontend
    // project), so a skip here is inapplicable rather than a missing
    // measurement. The per-check status and the notMeasured list are recorded
    // anyway, which is what makes a skip visible instead of silent, and the
    // contract tells the model to report anything it could not run itself.
    const failures = checks.filter((check) => checkStatus(check) === "fail");
    writeTrace(cwd, failures.length === 0 ? "delivery_checks_passed" : "delivery_checks_failed", {
      sessionId,
      attempt,
      checks: checks.map((check) => ({
        name: check.name,
        ok: check.ok,
        skipped: check.skipped,
        status: checkStatus(check),
      })),
      notMeasured: checks
        .filter((check) => checkStatus(check) === "not-measured")
        .map((check) => `${check.name}: ${check.skipped ?? "not measured"}`),
    });

    // Both the rendered-evidence record and the claim check belong to the whole
    // stop, not to one branch: they are recorded even when delivery failed. The
    // claim check compares the summary's own words against these recorded facts,
    // which is the only honesty check available for a project the harness does
    // not own.
    const review = tasteReview(cwd, userFactsByCwd.get(cwd) ?? "", sessionStart);
    recordScreenshotEvidence(cwd, sessionId, review.evidence);
    const buildCheck = checks.find((check) => check.name === "build");
    const buildOk = !buildCheck || buildCheck.skipped ? null : buildCheck.ok;
    const claimItems = claimFindings({
      message: messageText(eventRecord.last_assistant_message),
      evidence: review.evidence,
      buildOk,
    });
    writeTrace(cwd, claimItems.length === 0 ? "claim_check_passed" : "claim_mismatch", {
      sessionId,
      rules: claimItems.map((claim) => claim.rule),
    });

    if (failures.length === 0) {
      validationAttempts.delete(sessionId);

      // Delivery is objectively fine; now look for default-AI aesthetics.
      // Taste never blocks, but detected slop earns one self-repair pass.
      writeTrace(cwd, review.items.length === 0 ? "taste_review_passed" : "taste_review_flagged", {
        sessionId,
        rules: review.items.map((item) => item.rule),
      });
      if (review.items.length === 0 && claimItems.length === 0) {
        tasteRepairAttempts.delete(sessionId);
        return;
      }
      // Two bounded repair passes: real runs show the flagged set shrinking
      // per pass (4 rules -> 2 rules), so a second pass usually clears it. Claim
      // findings share the counter: same kind of turn, same bound.
      const tasteAttempt = (tasteRepairAttempts.get(sessionId) ?? 0) + 1;
      tasteRepairAttempts.set(sessionId, tasteAttempt);
      if (tasteAttempt >= 3) return;

      // The two findings stay in separate blocks: a claim finding is an honesty
      // problem, not an aesthetic one, and reporting it under the slop heading
      // would misdirect the repair.
      const blocks: string[] = [];
      if (claimItems.length > 0) {
        blocks.push([
          "[DESIGNER CLAIM CHECK]",
          "The summary claims a verification the record does not support. Do the work or correct the sentence; do not restate it as done.",
          "",
          ...claimItems.map((item) => `- ${item.rule}: ${item.detail}`),
          "[/DESIGNER CLAIM CHECK]",
        ].join("\n"));
      }
      if (review.items.length > 0) {
        blocks.push([
          "[DESIGNER TASTE REVIEW]",
          "Delivery checks passed, but the result shows statistical-default (AI slop) patterns. Fix the underlying causes below without changing the user's scope, rerun the checks, and recapture affected screenshots.",
          "",
          ...review.items.map((item) => `- ${item.rule}: ${item.detail}`),
          "",
          "Escape defaults with product specificity (a real product view, honest diagram, or material-derived palette) — not with added decoration.",
          "[/DESIGNER TASTE REVIEW]",
        ].join("\n"));
      }
      return { continue: true, additionalContext: truncate(blocks.join("\n\n")) };
    }

    // One continuation gives the agent a chance to repair. The second failure
    // is reported by the normal assistant response instead of creating a loop.
    if (attempt >= 2) return;

    // Piggyback the taste and claim findings on the same repair turn: a session
    // that ends in delivery failure would otherwise ship with its taste problems
    // and its unsupported claims unreviewed.
    const failureTasteItems = review.items;
    return {
      continue: true,
      additionalContext: truncate([
        "[DESIGNER DELIVERY CHECKS FAILED]",
        "Fix the true blockers below, rerun the checks, and report any remaining limitation.",
        "For an unsupported numeric or commercial claim: remove it or replace it with the user's own facts. A demo label or an EVIDENCE.md row you wrote yourself does not authorize a claim the user never supplied.",
        "Warnings do not require cosmetic churn.",
        "If visible output changes, repeat browser QA and refresh affected screenshots.",
        "",
        ...failures.map((failure) => `## ${failure.name}\n${failure.output || "failed without output"}`),
        ...(claimItems.length > 0
          ? ["", "## claim check (correct the sentence or do the work)", ...claimItems.map((item) => `- ${item.rule}: ${item.detail}`)]
          : []),
        ...(failureTasteItems.length > 0
          ? ["", "## taste review (fix in the same pass)", ...failureTasteItems.map((item) => `- ${item.rule}: ${item.detail}`)]
          : []),
        "[/DESIGNER DELIVERY CHECKS FAILED]",
      ].join("\n")),
    };
  });
}

export {
  CONTRACT_FRAGMENTS,
  checkStatus,
  claimInstanceLock,
  DATA_ROOT,
  buildContract,
  fragmentNamesFor,
  DESIGNER_PROMPT,
  DESIGNER_SKILLS,
  PLAN_ONLY_PROMPT,
  PACKAGE_ROOT,
  asksForApprovalPlan,
  doctorReport,
  isEnabled,
  planChecks,
  projectChangedSince,
};
