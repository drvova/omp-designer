#!/usr/bin/env node
/**
 * The architecture diagram in the README.
 *
 * A schematic, not an illustration: one turn of the runtime drawn flat, with the
 * five fragments, the tool the model calls, what the turn leaves on disk, the page
 * that answers back, and the harness that grades itself. Hairline rules, mono
 * labels, orthogonal connectors, no decoration — it has to read at 800 px wide on
 * a README where the reader is skimming.
 *
 *   node scripts/build-architecture-diagram.mjs            # docs/architecture.svg (dark)
 *   node scripts/build-architecture-diagram.mjs --light    # docs/architecture-light.svg
 *   node scripts/build-architecture-diagram.mjs --page     # + an HTML page for review
 *
 * Self-contained: no runtime, no fonts over the network, no build tooling beyond
 * node. Both plates are committed, so the README never needs the builder.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const theme = process.argv.includes("--light") ? "light" : "dark";

const W = 1180;
const H = 720;

// ------------------------------------------------------------------ primitives
const esc = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A labelled panel. `kind` picks the stroke: plain, subject (the lit one) or quiet. */
function panel(x, y, w, h, { label = "", sub = [], kind = "plain", mono = true } = {}) {
  const box = `<rect class="p-${kind}" x="${x}" y="${y}" width="${w}" height="${h}" rx="2"/>`;
  const head = label
    ? `<text class="t-label${mono ? " t-mono" : ""}" x="${x + 12}" y="${y + 21}">${esc(label)}</text>`
    : "";
  const lines = sub.map((line, index) =>
    `<text class="t-sub${mono ? " t-mono" : ""}" x="${x + 12}" y="${y + 40 + index * 16}">${esc(line)}</text>`).join("");
  return box + head + lines;
}

/** A small tag, for the five fragments. */
function chip(x, y, text, tone = "plain") {
  const width = 12 + text.length * 7.1;
  return `<rect class="chip-${tone}" x="${x}" y="${y}" width="${width.toFixed(1)}" height="20" rx="2"/>`
    + `<text class="t-chip t-mono" x="${x + 6}" y="${y + 14}">${esc(text)}</text>`;
}

/** A section label: letterspaced, small, in the margin of whatever it names. */
function section(x, y, text) {
  return `<text class="t-section t-mono" x="${x}" y="${y}">${esc(text)}</text>`;
}

/** An orthogonal connector. `dir` chooses which way the elbow bends. */
function route(points, { tone = "flow", arrow = true, label = "", labelAt = null } = {}) {
  const d = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x} ${y}`).join(" ");
  const head = arrow ? ` marker-end="url(#head-${tone})"` : "";
  const text = label && labelAt
    ? `<text class="t-note t-mono" x="${labelAt[0]}" y="${labelAt[1]}">${esc(label)}</text>`
    : "";
  return `<path class="w-${tone}" d="${d}" fill="none"${head}/>` + text;
}

/** A straight connector between two panels, entering the left edge. */
function link(x0, y0, x1, y1, options = {}) {
  return route([[x0, y0], [x0 + 14, y0], [x0 + 14, y1], [x1, y1]], options);
}

const parts = [];
const add = (fragment) => parts.push(fragment);

// ------------------------------------------------------------------- the sheet
/**
 * Column one: the turn, inside the host process. Each stage is a panel; the
 * connectors are the order they run in.
 */
function turnLane() {
  const x = 72;
  const w = 312;
  const mid = x + w / 2;
  add(`<rect class="host" x="48" y="126" width="364" height="398" rx="3"/>`);
  add(section(60, 148, "FIVE CONDITIONAL FRAGMENTS · FLAGS"));

  let cx = x;
  for (const name of ["motion", "dataviz", "forms", "verify", "workshop"]) {
    add(chip(cx, 158, name, name === "workshop" ? "subject" : "plain"));
    cx += 12 + name.length * 7.1 + 8;
  }

  add(panel(x, 196, w, 72, { label: "before_agent_start", kind: "subject", sub: [
    "assembles the contract once per turn",
    "injects nothing else",
  ] }));
  add(panel(x, 284, w, 56, { label: "the model works", sub: ["read · write · edit · bash · task"] }));
  add(panel(x, 356, w, 72, { label: "designer_check", sub: ["renders the page, returns the", "diagnostics in the tool result"] }));
  add(panel(x, 444, w, 62, { label: "session_stop", sub: ["delivery checks, one bounded repair"] }));

  add(route([[mid, 268], [mid, 284]], {}));
  add(route([[mid, 340], [mid, 356]], {}));
  add(route([[mid, 428], [mid, 444]], { label: "before it claims done", labelAt: [mid + 12, 440] }));

  // the repair loop keeps to the frame's right channel, so it crosses nothing
  add(route([[x + w, 475], [400, 475], [400, 312], [x + w, 312]], { tone: "repair" }));
  add(`<text class="t-note t-mono" x="395" y="404" transform="rotate(-90 395 404)">repair, once</text>`);
  return "";
}

/** Column two: what the turn leaves behind. */
function artifacts() {
  const x = 452;
  const w = 320;
  add(section(x, 148, "WHAT THE TURN LEAVES ON DISK"));
  const cards = [
    { y: 164, h: 64, label: "screenshots/ + driver-report.json", sub: ["1440 and 375, console, overflow, contrast"] },
    { y: 240, h: 64, label: "designer-canvas.html + canvas.json", sub: ["every board and capture on one page"] },
    { y: 316, h: 64, label: "~/.omp/agent/designer-traces/", sub: ["one JSONL per session, per working dir"] },
    { y: 392, h: 64, label: "WORKSHOP.md", sub: ["the open question, in one fenced block"] },
    { y: 468, h: 64, label: ".designer/workshop-decisions.jsonl", sub: ["append-only: what the reader chose"] },
  ];
  for (const card of cards) add(panel(x, card.y, w, card.h, { ...card, kind: "quiet" }));
  return "";
}

/** Column three: the page that answers back, and the harness that grades itself. */
function pageAndHarness() {
  const x = 812;
  const w = 320;
  add(section(x, 148, "THE PAGE, AND THE HARNESS"));

  add(panel(x, 164, w, 168, { label: "canvas server · --serve", kind: "subject", sub: [
    "GET /events       SSE reload",
    "GET /workshop     the open question",
    "POST /workshop/decide",
    "",
    "serves the project; a write in the",
    "same session refreshes it",
  ] }));

  add(panel(x, 348, w, 100, { label: "the way back", sub: [
    "a click is validated against the",
    "options, logged beside the project,",
    "and injected into the next turn once",
  ] }));

  add(panel(x, 464, w, 92, { label: "the gate, and the eval", kind: "quiet", sub: [
    "node scripts/gate.mjs   the chain",
    "evals/<case>/ + graders  with/without",
  ] }));

  // the server reads what the turn wrote
  add(route([[772, 322], [790, 322], [790, 250], [x, 250]], { tone: "quiet" }));
  // the loop: a click on the page, back into the contract of the next turn
  add(route([[x, 392], [798, 392], [798, 566], [30, 566], [30, 232], [72, 232]], {
    label: "the reader's decision, injected into the next turn",
    labelAt: [96, 558],
  }));
  return "";
}

/** The margin notes: what the extension is and is not. */
function notes() {
  const x = 48;
  add(section(x, 608, "DELIBERATE"));
  add(panel(x, 620, 700, 92, { kind: "quiet", sub: [
    "· prompts and checks, never a gate: no tool call is intercepted, no skill read is enforced",
    "· Pi gets the prompt and the plan checks, not the delivery backstop (the host event is OMP-only)",
    "· the canvas and the driver are plain node scripts; the diagram above is built by one",
  ] }));
  return "";
}

// --------------------------------------------------------------------- styles
const PALETTE = {
  light: {
    paper: "#f7f7f5", ink: "#171719", rule: "#b6b7bb", quiet: "#8b8c92", faint: "#d9d9d6",
    subject: "#0d0d0f", fill: "#ffffff", fillQuiet: "#fbfbfa", accent: "#1f4bd8",
  },
  dark: {
    paper: "#121316", ink: "#e9e9ec", rule: "#5a5c66", quiet: "#9a9ba4", faint: "#2a2c33",
    subject: "#ffffff", fill: "#1a1c20", fillQuiet: "#16181c", accent: "#7fa2ff",
  },
};
const c = PALETTE[theme];

const css = `
.sheet{fill:var(--paper)}
.host{fill:var(--fill-quiet);stroke:var(--rule);stroke-width:1;stroke-dasharray:4 3}
.p-plain{fill:var(--fill);stroke:var(--rule);stroke-width:1}
.p-quiet{fill:var(--fill-quiet);stroke:var(--rule);stroke-width:1;stroke-dasharray:2 3}
.p-subject{fill:var(--fill);stroke:var(--subject);stroke-width:1.4}
.chip-plain{fill:none;stroke:var(--rule);stroke-width:1}
.chip-subject{fill:none;stroke:var(--subject);stroke-width:1.4}
.t-label{fill:var(--ink);font-size:17px;font-weight:600}
.t-sub{fill:var(--quiet);font-size:14px}
.t-chip{fill:var(--ink);font-size:13px}
.t-section{fill:var(--quiet);font-size:12px;letter-spacing:1.8px}
.t-note{fill:var(--quiet);font-size:13px}
.t-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
text{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.w-flow{stroke:var(--subject);stroke-width:1.3}
.w-repair{stroke:var(--quiet);stroke-width:1.1;stroke-dasharray:5 4}
.w-quiet{stroke:var(--rule);stroke-width:1;stroke-dasharray:2 3}
`.replace(/\n/g, "");

// ---------------------------------------------------------------------- build
turnLane();
artifacts();
pageAndHarness();
notes();

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" data-theme="${theme}" width="${W}" height="${H}"
  aria-label="A flat schematic of the omp-designer runtime. The host process runs one turn: before_agent_start assembles the contract from five conditional fragments (motion, dataviz, forms, verify, workshop); the model works with its tools; designer_check renders the page and returns the diagnostics in the tool result; session_stop runs the delivery checks with one bounded repair. The turn leaves screenshots and a driver report, the canvas page and index, session traces, WORKSHOP.md and an append-only decision log. A canvas server serves the project over SSE and accepts a click at POST /workshop/decide, which is validated, logged and injected into the next turn once. The gate and the eval suite grade the session, and the deliberate limits are: no tool interception, no enforced skill reads, and a Pi adapter without the delivery backstop.">
  <title>omp-designer runtime</title>
  <style>
:root{--paper:${c.paper};--ink:${c.ink};--rule:${c.rule};--quiet:${c.quiet};--faint:${c.faint};--subject:${c.subject};--fill:${c.fill};--fill-quiet:${c.fillQuiet};--accent:${c.accent}}
${css}
  </style>
  <defs>
    <marker id="head-flow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 1 L9 5 L0 9 z" fill="var(--subject)"/>
    </marker>
    <marker id="head-repair" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 1 L9 5 L0 9 z" fill="var(--quiet)"/>
    </marker>
    <marker id="head-quiet" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
      <path d="M0 1 L9 5 L0 9 z" fill="var(--rule)"/>
    </marker>
  </defs>
  <rect class="sheet" x="0" y="0" width="${W}" height="${H}"/>
  <text class="t-label t-mono" x="60" y="52" font-size="22px">omp-designer · runtime</text>
  <text class="t-sub" x="60" y="78">One turn, what it leaves behind, and the page that answers back. Solid arrows run every turn; the dashed repair runs once; dotted lines carry a file or a read.</text>
  <line x1="60" y1="88" x2="${W - 60}" y2="88" stroke="var(--rule)" stroke-width="1"/>
  ${parts.join("\n  ")}
</svg>
`;

const outName = theme === "light" ? "architecture-light.svg" : "architecture.svg";
const out = join(ROOT, "docs", outName);
writeFileSync(out, `${svg}\n`);
console.log(`wrote ${out} (${(svg.length / 1024).toFixed(1)} KB, theme ${theme})`);

if (process.argv.includes("--page")) {
  const pageDir = join(ROOT, "test-output");
  mkdirSync(pageDir, { recursive: true });
  const page = join(pageDir, `architecture-${theme}.html`);
  const background = theme === "light" ? "#e9e9e6" : "#08090b";
  writeFileSync(page, `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>architecture diagram (${theme})</title></head>\n<body style="margin:0;background:${background}">\n<div style="width:1000px;margin:32px auto">${svg}</div>\n</body></html>\n`);
  console.log(`wrote ${page}`);
}
